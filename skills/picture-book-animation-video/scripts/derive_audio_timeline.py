#!/usr/bin/env python3
"""Derive non-overlapping scene intervals from verified utterances and Whisper words."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import unicodedata
from pathlib import Path


def normalize_tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return re.findall(r"[^\W_]+", normalized, flags=re.UNICODE)


def probe_duration(audio_file: str) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audio_file,
    ]
    return float(subprocess.check_output(command, text=True).strip())


def load_utterances(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    utterances = payload.get("utterances") if isinstance(payload, dict) else payload
    if not isinstance(utterances, list) or not utterances:
        raise ValueError("Utterance JSON must be a non-empty list or contain utterances.")
    for index, utterance in enumerate(utterances, start=1):
        if not isinstance(utterance, dict) or not utterance.get("text"):
            raise ValueError(f"Utterance {index} requires text.")
        utterance.setdefault("id", f"u{index:03d}")
    return utterances


def whisper_words(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    words: list[dict] = []
    for segment in payload.get("segments", []):
        for word in segment.get("words") or []:
            tokens = normalize_tokens(str(word.get("word", "")))
            if len(tokens) != 1:
                continue
            start = word.get("start")
            end = word.get("end")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                continue
            words.append({"token": tokens[0], "start": float(start), "end": float(end)})
    if not words:
        raise ValueError("Whisper JSON contains no word timestamps. Enable word_timestamps.")
    return words


def align(utterances: list[dict], words: list[dict]) -> list[dict]:
    cursor = 0
    aligned: list[dict] = []
    word_tokens = [word["token"] for word in words]
    for utterance in utterances:
        target = normalize_tokens(str(utterance["text"]))
        if not target:
            raise ValueError(f"Utterance {utterance['id']} has no alignable tokens.")
        found = None
        for start in range(cursor, len(words) - len(target) + 1):
            if word_tokens[start : start + len(target)] == target:
                found = start
                break
        if found is None:
            raise ValueError(
                f"Could not align {utterance['id']}: {utterance['text']!r}. "
                "Correct the ASR words or the verified utterance list before continuing."
            )
        end_index = found + len(target) - 1
        aligned.append(
            {
                **utterance,
                "speech_start_seconds": words[found]["start"],
                "speech_end_seconds": words[end_index]["end"],
            }
        )
        cursor = end_index + 1
    return aligned


def build_scenes(
    aligned: list[dict], audio_duration: float, lead: float, intro_scene_id: str | None
) -> list[dict]:
    if audio_duration <= 0:
        raise ValueError("Audio duration must be positive.")
    first_start = aligned[0]["speech_start_seconds"]
    first_boundary = max(0.0, first_start - lead)
    scenes: list[dict] = []
    if intro_scene_id and first_boundary > 0:
        scenes.append(
            {
                "scene_id": intro_scene_id,
                "utterance_id": None,
                "text": "",
                "start_seconds": 0.0,
                "end_seconds": round(first_boundary, 6),
                "speech_start_seconds": None,
                "speech_end_seconds": None,
                "local_speech_start_seconds": None,
                "local_speech_end_seconds": None,
            }
        )

    for index, utterance in enumerate(aligned):
        if index == 0:
            start = first_boundary if scenes else 0.0
        else:
            previous = aligned[index - 1]
            start = (
                previous["speech_end_seconds"] + utterance["speech_start_seconds"]
            ) / 2
        if index == len(aligned) - 1:
            end = audio_duration
        else:
            following = aligned[index + 1]
            end = (
                utterance["speech_end_seconds"] + following["speech_start_seconds"]
            ) / 2
        if end <= start:
            raise ValueError(f"Derived invalid interval for {utterance['id']}.")
        scenes.append(
            {
                "scene_id": utterance.get("scene_id") or f"s{index + 1:03d}",
                "utterance_id": utterance["id"],
                "text": utterance["text"],
                "start_seconds": round(start, 6),
                "end_seconds": round(end, 6),
                "speech_start_seconds": round(
                    utterance["speech_start_seconds"], 6
                ),
                "speech_end_seconds": round(utterance["speech_end_seconds"], 6),
                "local_speech_start_seconds": round(
                    utterance["speech_start_seconds"] - start, 6
                ),
                "local_speech_end_seconds": round(
                    utterance["speech_end_seconds"] - start, 6
                ),
            }
        )
    return scenes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("whisper_json", type=Path)
    parser.add_argument("utterances_json", type=Path)
    parser.add_argument("output_json", type=Path)
    parser.add_argument("--audio-file", required=True)
    parser.add_argument("--audio-duration", type=float)
    parser.add_argument("--lead-seconds", type=float, default=0.4)
    parser.add_argument("--intro-scene-id", default="s000")
    parser.add_argument("--no-intro-scene", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.lead_seconds < 0:
        raise SystemExit("ERROR: --lead-seconds must be non-negative.")
    try:
        utterances = load_utterances(args.utterances_json)
        words = whisper_words(args.whisper_json)
        aligned = align(utterances, words)
        duration = args.audio_duration or probe_duration(args.audio_file)
        scenes = build_scenes(
            aligned,
            duration,
            args.lead_seconds,
            None if args.no_intro_scene else args.intro_scene_id,
        )
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print(f"ERROR: {exc}")
        return 1
    output = {
        "schema_version": 1,
        "audio_file": args.audio_file,
        "audio_duration_seconds": round(duration, 6),
        "alignment_source": str(args.whisper_json),
        "utterances": aligned,
        "scenes": scenes,
    }
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Wrote {len(scenes)} scene interval(s) to {args.output_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
