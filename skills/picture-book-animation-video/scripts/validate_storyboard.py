#!/usr/bin/env python3
"""Validate source traceability and exact narration in a storyboard JSON file."""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any


PAGE_ROLES = {
    "cover",
    "title",
    "content",
    "spread",
    "exercise",
    "index",
    "dedication",
    "blank",
    "back-cover",
    "unknown",
}
TRANSCRIPT_STATES = {"verified", "uncertain", "none"}
NARRATION_MODES = {"exact", "silent", "approved_adaptation"}
APPROVED_ASSET_TYPES = {"character_ip", "style_reference", "other"}
GENERATION_MODES = {"preview", "full"}


def text_key(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(character for character in normalized if character.isalnum())


def duplicate_values(values: list[object]) -> list[object]:
    counts = Counter(values)
    return [value for value, count in counts.items() if count > 1]


def path_keys(value: str) -> set[str]:
    path = Path(value)
    keys = {value.casefold(), path.name.casefold()}
    try:
        keys.add(str(path.resolve()).casefold())
    except OSError:
        pass
    return keys


def load_json(path: str) -> Any:
    if path == "-":
        return json.load(sys.stdin)
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def validate(
    data: Any, manifest: Any | None, stage: str = "plan"
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(data, dict):
        return ["Storyboard root must be an object."], warnings
    if data.get("version") != 1:
        errors.append("version must be integer 1.")

    project = data.get("project")
    if not isinstance(project, dict):
        errors.append("project must be an object.")
        project = {}
    for field in (
        "title",
        "source_language",
        "aspect_ratio",
        "width",
        "height",
        "fps",
        "narration_default",
    ):
        if field not in project:
            errors.append(f"project.{field} is required.")

    pages = data.get("pages")
    approved_assets = data.get("approved_assets", [])
    scenes = data.get("scenes")
    if not isinstance(pages, list) or not pages:
        errors.append("pages must be a non-empty list.")
        pages = []
    if not isinstance(scenes, list) or not scenes:
        errors.append("scenes must be a non-empty list.")
        scenes = []
    if not isinstance(approved_assets, list):
        errors.append("approved_assets must be a list when present.")
        approved_assets = []

    approved_asset_by_id: dict[str, dict[str, Any]] = {}
    for index, asset in enumerate(approved_assets):
        label = f"approved_assets[{index}]"
        if not isinstance(asset, dict):
            errors.append(f"{label} must be an object.")
            continue
        asset_id = asset.get("id")
        if not isinstance(asset_id, str) or not asset_id:
            errors.append(f"{label}.id must be a non-empty string.")
            continue
        if asset_id in approved_asset_by_id:
            errors.append(f"Duplicate approved asset id: {asset_id!r}.")
        approved_asset_by_id[asset_id] = asset
        if asset.get("type") not in APPROVED_ASSET_TYPES:
            errors.append(f"{label}.type is invalid.")
        for field in ("source_file", "description", "approval_note"):
            if not isinstance(asset.get(field), str) or not asset[field].strip():
                errors.append(f"{label}.{field} is required.")

    page_ids = [page.get("id") for page in pages if isinstance(page, dict)]
    page_orders = [page.get("order") for page in pages if isinstance(page, dict)]
    for duplicate in duplicate_values(page_ids):
        errors.append(f"Duplicate page id: {duplicate!r}.")
    for duplicate in duplicate_values(page_orders):
        errors.append(f"Duplicate page order: {duplicate!r}.")

    page_by_id: dict[str, dict[str, Any]] = {}
    visual_by_id: dict[str, tuple[str, dict[str, Any]]] = {}
    included_ids: set[str] = set()
    included_source_keys: set[str] = set()

    for index, page in enumerate(pages):
        label = f"pages[{index}]"
        if not isinstance(page, dict):
            errors.append(f"{label} must be an object.")
            continue
        page_id = page.get("id")
        if not isinstance(page_id, str) or not page_id:
            errors.append(f"{label}.id must be a non-empty string.")
            continue
        page_by_id[page_id] = page
        if not isinstance(page.get("order"), int) or page["order"] < 1:
            errors.append(f"{label}.order must be a positive integer.")
        if page.get("role") not in PAGE_ROLES:
            errors.append(f"{label}.role is invalid.")
        if not isinstance(page.get("include"), bool):
            errors.append(f"{label}.include must be boolean.")
        if not isinstance(page.get("inclusion_reason"), str) or not page[
            "inclusion_reason"
        ].strip():
            errors.append(f"{label}.inclusion_reason is required.")
        state = page.get("transcript_status")
        if state not in TRANSCRIPT_STATES:
            errors.append(f"{label}.transcript_status is invalid.")
        if state == "verified" and not text_key(page.get("transcript")):
            errors.append(f"{label}.transcript must be non-empty when verified.")
        if state == "none" and text_key(page.get("transcript")):
            errors.append(f"{label}.transcript must be empty when status is none.")
        if page.get("include") and state == "uncertain":
            errors.append(f"{label} is included but its transcript is uncertain.")

        source_files = page.get("source_files")
        if not isinstance(source_files, list) or not source_files:
            errors.append(f"{label}.source_files must be a non-empty list.")
            source_files = []
        source_file_keys = set()
        for source_file in source_files:
            if not isinstance(source_file, str) or not source_file:
                errors.append(f"{label}.source_files contains an invalid path.")
                continue
            source_file_keys.update(path_keys(source_file))
            if page.get("include"):
                included_source_keys.update(path_keys(source_file))

        facts = page.get("visual_facts")
        if not isinstance(facts, list) or (page.get("include") and not facts):
            errors.append(f"{label}.visual_facts must be non-empty for included pages.")
            facts = []
        for fact_index, fact in enumerate(facts):
            fact_label = f"{label}.visual_facts[{fact_index}]"
            if not isinstance(fact, dict):
                errors.append(f"{fact_label} must be an object.")
                continue
            fact_id = fact.get("id")
            if not isinstance(fact_id, str) or not fact_id:
                errors.append(f"{fact_label}.id must be a non-empty string.")
                continue
            if fact_id in visual_by_id:
                errors.append(f"Duplicate visual fact id: {fact_id!r}.")
            visual_by_id[fact_id] = (page_id, fact)
            if not isinstance(fact.get("description"), str) or not fact[
                "description"
            ].strip():
                errors.append(f"{fact_label}.description is required.")
            fact_source = fact.get("source_file")
            if not isinstance(fact_source, str) or not (
                path_keys(fact_source) & source_file_keys
            ):
                errors.append(
                    f"{fact_label}.source_file must reference its page source_files."
                )
        if page.get("include"):
            included_ids.add(page_id)

    scene_ids = [scene.get("id") for scene in scenes if isinstance(scene, dict)]
    scene_orders = [scene.get("order") for scene in scenes if isinstance(scene, dict)]
    for duplicate in duplicate_values(scene_ids):
        errors.append(f"Duplicate scene id: {duplicate!r}.")
    for duplicate in duplicate_values(scene_orders):
        errors.append(f"Duplicate scene order: {duplicate!r}.")

    generation_plan = data.get("generation_plan")
    selected_scene_ids: set[str] = set()
    if not isinstance(generation_plan, dict):
        errors.append("generation_plan must be an object.")
    else:
        generation_mode = generation_plan.get("mode")
        if generation_mode not in GENERATION_MODES:
            errors.append("generation_plan.mode must be preview or full.")
        selected = generation_plan.get("scene_ids")
        if not isinstance(selected, list) or not selected:
            errors.append("generation_plan.scene_ids must be a non-empty list.")
            selected = []
        for duplicate in duplicate_values(selected):
            errors.append(f"Duplicate generation-plan scene id: {duplicate!r}.")
        for scene_id in selected:
            if scene_id not in scene_ids:
                errors.append(
                    f"generation_plan references unknown scene {scene_id!r}."
                )
            elif isinstance(scene_id, str):
                selected_scene_ids.add(scene_id)
        if generation_mode == "preview" and len(selected) not in (2, 3):
            errors.append("Preview generation_plan must select 2 or 3 scenes.")
        if generation_mode == "full" and selected != scene_ids:
            errors.append(
                "Full generation_plan.scene_ids must list every scene in storyboard order."
            )
        if not isinstance(generation_plan.get("decision_note"), str) or not generation_plan[
            "decision_note"
        ].strip():
            errors.append("generation_plan.decision_note is required.")

    covered_pages: set[str] = set()
    audio_intervals: dict[str, list[tuple[int, float, float, str]]] = {}
    for index, scene in enumerate(scenes):
        label = f"scenes[{index}]"
        if not isinstance(scene, dict):
            errors.append(f"{label} must be an object.")
            continue
        if not isinstance(scene.get("id"), str) or not scene["id"]:
            errors.append(f"{label}.id must be a non-empty string.")
        if not isinstance(scene.get("order"), int) or scene["order"] < 1:
            errors.append(f"{label}.order must be a positive integer.")
        page_refs = scene.get("page_ids")
        if not isinstance(page_refs, list) or not page_refs:
            errors.append(f"{label}.page_ids must be a non-empty list.")
            page_refs = []
        for page_ref in page_refs:
            if page_ref not in page_by_id:
                errors.append(f"{label} references unknown page {page_ref!r}.")
            elif page_ref not in included_ids:
                errors.append(f"{label} references excluded page {page_ref!r}.")
            else:
                covered_pages.add(page_ref)

        if not isinstance(scene.get("comprehension_goal"), str) or not scene[
            "comprehension_goal"
        ].strip():
            errors.append(f"{label}.comprehension_goal is required.")
        mode = scene.get("narration_mode")
        if mode not in NARRATION_MODES:
            errors.append(f"{label}.narration_mode is invalid.")
        source_text = text_key(scene.get("source_text"))
        spoken_text = text_key(scene.get("spoken_text"))
        subtitle_text = text_key(scene.get("subtitle_text"))
        if mode == "exact":
            if not source_text:
                errors.append(f"{label}.source_text is required for exact narration.")
            if not (source_text == spoken_text == subtitle_text):
                errors.append(
                    f"{label} exact source, spoken, and subtitle text must match."
                )
            transcripts = "".join(
                text_key(page_by_id[page_ref].get("transcript"))
                for page_ref in page_refs
                if page_ref in page_by_id
                and page_by_id[page_ref].get("transcript_status") == "verified"
            )
            if source_text and source_text not in transcripts:
                errors.append(
                    f"{label}.source_text is not present in the referenced verified transcript."
                )
        elif mode == "silent":
            if source_text or spoken_text or subtitle_text:
                errors.append(
                    f"{label} silent narration requires empty text fields."
                )
        elif mode == "approved_adaptation":
            if not spoken_text or spoken_text != subtitle_text:
                errors.append(
                    f"{label} adapted spoken and subtitle text must match and be non-empty."
                )
            if not isinstance(scene.get("approval_note"), str) or not scene[
                "approval_note"
            ].strip():
                errors.append(
                    f"{label}.approval_note is required for approved adaptation."
                )

        visual_refs = scene.get("visual_source_ids")
        if not isinstance(visual_refs, list) or not visual_refs:
            errors.append(f"{label}.visual_source_ids must be a non-empty list.")
            visual_refs = []
        for visual_ref in visual_refs:
            if visual_ref not in visual_by_id:
                errors.append(f"{label} references unknown visual fact {visual_ref!r}.")
                continue
            owner_page = visual_by_id[visual_ref][0]
            if owner_page not in page_refs:
                errors.append(
                    f"{label} uses visual fact {visual_ref!r} from an unreferenced page."
                )

        asset_refs = scene.get("approved_asset_ids", [])
        if not isinstance(asset_refs, list):
            errors.append(f"{label}.approved_asset_ids must be a list when present.")
            asset_refs = []
        for asset_ref in asset_refs:
            if asset_ref not in approved_asset_by_id:
                errors.append(
                    f"{label} references unknown approved asset {asset_ref!r}."
                )

        allowed_motion_targets = set(visual_refs) | set(asset_refs)

        motion = scene.get("motion")
        if not isinstance(motion, list):
            errors.append(f"{label}.motion must be a list.")
            motion = []
        for motion_index, item in enumerate(motion):
            motion_label = f"{label}.motion[{motion_index}]"
            if not isinstance(item, dict):
                errors.append(f"{motion_label} must be an object.")
                continue
            if item.get("target_source_id") not in allowed_motion_targets:
                errors.append(
                    f"{motion_label}.target_source_id must reference a scene visual or approved asset."
                )
            for field in ("action", "purpose"):
                if not isinstance(item.get(field), str) or not item[field].strip():
                    errors.append(f"{motion_label}.{field} is required.")

        transition = scene.get("transition_out")
        if not isinstance(transition, dict):
            errors.append(f"{label}.transition_out must be an object.")
        else:
            for field in ("type", "rationale"):
                if not isinstance(transition.get(field), str) or not transition[
                    field
                ].strip():
                    errors.append(f"{label}.transition_out.{field} is required.")
            target = transition.get("target_source_id")
            if target is not None and target not in allowed_motion_targets:
                errors.append(
                    f"{label}.transition_out.target_source_id must reference a scene visual or approved asset."
                )

        duration = scene.get("duration_seconds")
        if not isinstance(duration, (int, float)) or duration <= 0:
            errors.append(f"{label}.duration_seconds must be positive.")
        if not isinstance(scene.get("audio_notes"), str):
            errors.append(f"{label}.audio_notes must be a string.")

        audio_segment = scene.get("audio_segment")
        if not isinstance(audio_segment, dict):
            errors.append(f"{label}.audio_segment must be an object.")
        else:
            source_file = audio_segment.get("source_file")
            if not isinstance(source_file, str) or not source_file.strip():
                errors.append(f"{label}.audio_segment.source_file is required.")
                source_file = ""
            start = audio_segment.get("start_seconds")
            end = audio_segment.get("end_seconds")
            valid_bounds = all(
                isinstance(value, (int, float)) and not isinstance(value, bool)
                for value in (start, end)
            )
            if not valid_bounds or start < 0 or end <= start:
                errors.append(
                    f"{label}.audio_segment requires 0 <= start_seconds < end_seconds."
                )
            else:
                if isinstance(duration, (int, float)) and duration + 0.05 < end - start:
                    errors.append(
                        f"{label}.duration_seconds is shorter than its audio segment."
                    )
                if source_file:
                    scene_order = scene.get("order")
                    if not isinstance(scene_order, int):
                        scene_order = index + 1
                    audio_intervals.setdefault(source_file, []).append(
                        (scene_order, float(start), float(end), label)
                    )
            speech_start = audio_segment.get("speech_start_seconds")
            speech_end = audio_segment.get("speech_end_seconds")
            if mode == "silent":
                if speech_start is not None or speech_end is not None:
                    errors.append(
                        f"{label} silent narration requires null speech timestamps."
                    )
            else:
                valid_speech = all(
                    isinstance(value, (int, float)) and not isinstance(value, bool)
                    for value in (speech_start, speech_end)
                )
                if (
                    not valid_speech
                    or not valid_bounds
                    or speech_start < start
                    or speech_end <= speech_start
                    or speech_end > end
                ):
                    errors.append(
                        f"{label}.audio_segment speech timestamps must be ordered inside the segment."
                    )

        scene_id = scene.get("id")
        if stage == "final" and scene_id in selected_scene_ids:
            scene_image = scene.get("scene_image")
            if not isinstance(scene_image, dict):
                errors.append(f"{label}.scene_image must be an object at final stage.")
            else:
                for field in ("path", "prompt", "reference_files"):
                    value = scene_image.get(field)
                    if field == "reference_files":
                        if not isinstance(value, list) or not value:
                            errors.append(
                                f"{label}.scene_image.reference_files must be non-empty."
                            )
                    elif not isinstance(value, str) or not value.strip():
                        errors.append(f"{label}.scene_image.{field} is required.")
            video_clip = scene.get("video_clip")
            if not isinstance(video_clip, dict):
                errors.append(f"{label}.video_clip must be an object at final stage.")
            else:
                for field in (
                    "path",
                    "workflow_id",
                    "task_id",
                    "prompt",
                    "resolution",
                ):
                    if not isinstance(video_clip.get(field), str) or not video_clip[
                        field
                    ].strip():
                        errors.append(f"{label}.video_clip.{field} is required.")
                if mode != "silent" and isinstance(video_clip.get("prompt"), str):
                    if spoken_text not in text_key(video_clip["prompt"]):
                        errors.append(
                            f"{label}.video_clip.prompt must contain the exact spoken_text."
                        )

    for source_file, intervals in audio_intervals.items():
        previous_end: float | None = None
        previous_label = ""
        for _, start, end, label in sorted(intervals):
            if previous_end is not None and start < previous_end:
                errors.append(
                    f"{label}.audio_segment overlaps {previous_label} in {source_file!r}."
                )
            previous_end = end
            previous_label = label

    missing_coverage = sorted(included_ids - covered_pages)
    for page_id in missing_coverage:
        errors.append(f"Included page {page_id!r} is not covered by any scene.")

    if isinstance(manifest, dict):
        manifest_files = manifest.get("files", [])
        known_source_keys: set[str] = set()
        for record in manifest_files if isinstance(manifest_files, list) else []:
            if isinstance(record, dict) and isinstance(record.get("path"), str):
                known_source_keys.update(path_keys(record["path"]))
        for page in pages:
            if not isinstance(page, dict):
                continue
            for source_file in page.get("source_files", []):
                if isinstance(source_file, str) and not (
                    path_keys(source_file) & known_source_keys
                ):
                    warnings.append(
                        f"Storyboard source {source_file!r} is absent from the input manifest."
                    )

        groups = manifest.get("exact_duplicate_groups", [])
        for group in groups if isinstance(groups, list) else []:
            if not isinstance(group, dict):
                continue
            used = [
                source
                for source in group.get("files", [])
                if isinstance(source, str)
                and path_keys(source) & included_source_keys
            ]
            if len(used) > 1:
                errors.append(
                    "More than one file from an exact duplicate group is included: "
                    + ", ".join(used)
                )

    return errors, warnings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a picture-book animation storyboard."
    )
    parser.add_argument("storyboard", help="Storyboard JSON path or - for stdin.")
    parser.add_argument("--manifest", help="Optional page-inventory JSON path.")
    parser.add_argument(
        "--stage",
        choices=("plan", "final"),
        default="plan",
        help="Validation gate. final also requires generated scene and clip records.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        storyboard = load_json(args.storyboard)
        manifest = load_json(args.manifest) if args.manifest else None
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    errors, warnings = validate(storyboard, manifest, args.stage)
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    if errors:
        print(f"INVALID: {len(errors)} error(s), {len(warnings)} warning(s).")
        return 1
    print(f"VALID: 0 errors, {len(warnings)} warning(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
