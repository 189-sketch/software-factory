#!/usr/bin/env python3
"""Assemble generated scene clips on the original-audio clock with crossfades."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def resolve_path(base: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def filter_path(path: Path) -> str:
    return path.resolve().as_posix().replace(":", r"\:").replace("'", r"\'")


def validate(payload: object, base: Path) -> tuple[list[str], list[dict]]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["Assembly manifest must be an object."], []
    scenes = payload.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return ["scenes must be a non-empty list."], []
    for field in ("audio", "output"):
        value = payload.get(field)
        if not isinstance(value, str) or not value:
            errors.append(f"{field} is required.")
        elif field == "audio" and not resolve_path(base, value).is_file():
            errors.append(f"Audio file does not exist: {value}")
    for index, scene in enumerate(scenes):
        label = f"scenes[{index}]"
        if not isinstance(scene, dict):
            errors.append(f"{label} must be an object.")
            continue
        clip = scene.get("clip")
        duration = scene.get("timeline_duration")
        if not isinstance(clip, str) or not resolve_path(base, clip).is_file():
            errors.append(f"{label}.clip must reference an existing file.")
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration <= 0:
            errors.append(f"{label}.timeline_duration must be positive.")
    subtitles = payload.get("subtitles")
    if subtitles and (
        not isinstance(subtitles, str) or not resolve_path(base, subtitles).is_file()
    ):
        errors.append("subtitles must reference an existing ASS file.")
    return errors, scenes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest_path = args.manifest.resolve()
        base = manifest_path.parent
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    errors, scenes = validate(payload, base)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if args.validate_only:
        print(f"VALID: {len(scenes)} assembly scene(s).")
        return 0

    width = int(payload.get("width", 1920))
    height = int(payload.get("height", 1080))
    fps = int(payload.get("fps", 30))
    crossfade = float(payload.get("transition_seconds", 0.4))
    if crossfade < 0:
        print("ERROR: transition_seconds must be non-negative.", file=sys.stderr)
        return 1
    total_duration = sum(float(scene["timeline_duration"]) for scene in scenes)
    audio = resolve_path(base, payload["audio"])
    output = resolve_path(base, payload["output"])
    output.parent.mkdir(parents=True, exist_ok=True)

    command: list[str] = ["ffmpeg", "-y"]
    filters: list[str] = []
    for index, scene in enumerate(scenes):
        clip = resolve_path(base, scene["clip"])
        command.extend(["-i", str(clip)])
        timeline_duration = float(scene["timeline_duration"])
        trim_duration = timeline_duration + (crossfade if index < len(scenes) - 1 else 0)
        filters.append(
            f"[{index}:v]trim=duration={trim_duration:.6f},setpts=PTS-STARTPTS,"
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},fps={fps},format=yuv420p[v{index}]"
        )
    command.extend(["-i", str(audio)])

    current = "v0"
    offset = 0.0
    if crossfade > 0:
        for index in range(1, len(scenes)):
            offset += float(scenes[index - 1]["timeline_duration"])
            output_label = f"x{index}"
            transition = scenes[index - 1].get("transition", "fade")
            filters.append(
                f"[{current}][v{index}]xfade=transition={transition}:"
                f"duration={crossfade:.6f}:offset={offset:.6f}[{output_label}]"
            )
            current = output_label
    elif len(scenes) > 1:
        joined = "".join(f"[v{index}]" for index in range(len(scenes)))
        filters.append(f"{joined}concat=n={len(scenes)}:v=1:a=0[xcat]")
        current = "xcat"

    subtitles = payload.get("subtitles")
    if subtitles:
        subtitle_path = filter_path(resolve_path(base, subtitles))
        filters.append(f"[{current}]subtitles='{subtitle_path}',format=yuv420p[outv]")
    else:
        filters.append(f"[{current}]format=yuv420p[outv]")
    audio_index = len(scenes)
    filters.append(
        f"[{audio_index}:a]atrim=duration={total_duration:.6f},"
        "asetpts=PTS-STARTPTS[aout]"
    )

    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[outv]",
            "-map",
            "[aout]",
            "-c:v",
            "libx264",
            "-preset",
            payload.get("preset", "medium"),
            "-crf",
            str(payload.get("crf", 18)),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            str(payload.get("audio_bitrate", "192k")),
            "-movflags",
            "+faststart",
            "-t",
            f"{total_duration:.6f}",
            str(output),
        ]
    )
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
