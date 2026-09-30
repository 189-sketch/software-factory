#!/usr/bin/env python3
"""Submit, resume, poll, and download a batch of AutoDL ComfyUI scenes."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

from autodl_comfyui_client import (
    BASE_URL,
    TERMINAL_FAILURES,
    download_result,
    initial_poll_interval,
    next_poll_interval,
    request_json,
)


UGUU_UPLOAD_URL = "https://uguu.se/upload.php"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_path(base: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def upload_uguu(path: Path) -> str:
    with path.open("rb") as handle:
        response = requests.post(
            UGUU_UPLOAD_URL,
            files={"files[]": (path.name, handle, "image/png")},
            timeout=180,
        )
    response.raise_for_status()
    payload = response.json()
    files = payload.get("files") or []
    if not files or not isinstance(files[0].get("url"), str):
        raise RuntimeError(f"Unexpected temporary-upload response for {path.name}.")
    return files[0]["url"]


def validate_manifest(payload: object, base: Path) -> tuple[str, list[dict]]:
    if not isinstance(payload, dict):
        raise ValueError("Batch manifest must be an object.")
    workflow_id = payload.get("workflow_id")
    scenes = payload.get("scenes")
    if not isinstance(workflow_id, str) or not workflow_id.strip():
        raise ValueError("workflow_id is required.")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("scenes must be a non-empty list.")
    ids: set[str] = set()
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise ValueError(f"scenes[{index}] must be an object.")
        scene_id = scene.get("scene_id")
        if not isinstance(scene_id, str) or not scene_id:
            raise ValueError(f"scenes[{index}].scene_id is required.")
        if scene_id in ids:
            raise ValueError(f"Duplicate scene_id: {scene_id}")
        ids.add(scene_id)
        for field in ("prompt", "output_dir"):
            if not isinstance(scene.get(field), str) or not scene[field].strip():
                raise ValueError(f"{scene_id}.{field} is required.")
        duration = scene.get("duration")
        if not isinstance(duration, int) or isinstance(duration, bool) or duration < 1:
            raise ValueError(f"{scene_id}.duration must be a positive integer.")
        if not scene.get("ref_image_0"):
            image_path = scene.get("image_path")
            if not isinstance(image_path, str) or not resolve_path(base, image_path).is_file():
                raise ValueError(
                    f"{scene_id} requires ref_image_0 or an existing image_path."
                )
    return workflow_id, scenes


def update_storyboard(path: Path, task_ids: dict[str, str]) -> None:
    if not path.exists():
        raise FileNotFoundError(path)
    storyboard = json.loads(path.read_text(encoding="utf-8"))
    for scene in storyboard.get("scenes", []):
        task_id = task_ids.get(scene.get("id"))
        if task_id and isinstance(scene.get("video_clip"), dict):
            scene["video_clip"]["task_id"] = task_id
    write_json(path, storyboard)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--token-env", default="AUTODL_TOKEN")
    parser.add_argument("--timeout-seconds", type=float, default=3600.0)
    parser.add_argument("--allow-temporary-public-upload", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest_path = args.manifest.resolve()
        base = manifest_path.parent
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        workflow_id, scenes = validate_manifest(payload, base)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.validate_only:
        print(f"VALID: {len(scenes)} batch scene(s).")
        return 0

    token = os.environ.get(args.token_env)
    if not token:
        print(f"ERROR: environment variable {args.token_env} is not set.", file=sys.stderr)
        return 2
    headers = {"Authorization": token, "Content-Type": "application/json"}
    try:
        schema = request_json(
            "GET", f"{BASE_URL}/workflows/{workflow_id}", headers=headers
        )
        write_json(base / "workflow-schema.json", schema)
        active: dict[str, dict] = {}
        completed: list[str] = []
        task_ids: dict[str, str] = {}
        deadline = time.monotonic() + args.timeout_seconds

        for scene in scenes:
            scene_id = scene["scene_id"]
            output_dir = resolve_path(base, scene["output_dir"])
            output_dir.mkdir(parents=True, exist_ok=True)
            result_path = output_dir / "result-01.mp4"
            created_path = output_dir / "task-created.json"
            request_path = output_dir / "request.json"
            if result_path.exists() and result_path.stat().st_size > 0:
                completed.append(scene_id)
                if created_path.exists():
                    created = json.loads(created_path.read_text(encoding="utf-8"))
                    task_ids[scene_id] = created["data"]["task_id"]
                print(f"skip completed scene={scene_id}", flush=True)
                continue

            if created_path.exists() and request_path.exists():
                created = json.loads(created_path.read_text(encoding="utf-8"))
                body = json.loads(request_path.read_text(encoding="utf-8"))
                task_id = created["data"]["task_id"]
                print(f"resume scene={scene_id} task_id={task_id}", flush=True)
            else:
                ref_url = scene.get("ref_image_0")
                if not ref_url:
                    if not args.allow_temporary_public_upload:
                        raise RuntimeError(
                            f"{scene_id} needs a public ref_image_0 URL. "
                            "Provide one or explicitly allow temporary public upload."
                        )
                    ref_url = upload_uguu(resolve_path(base, scene["image_path"]))
                body = {
                    "prompt": scene["prompt"],
                    "duration": scene["duration"],
                    "resolution": scene.get("resolution", "1080p横"),
                    "ref_image_0": ref_url,
                    **scene.get("request_overrides", {}),
                }
                write_json(request_path, body)
                created = request_json(
                    "POST",
                    f"{BASE_URL}/comfyui_workflow/{workflow_id}",
                    headers=headers,
                    body=body,
                )
                write_json(created_path, created)
                task_id = created["data"]["task_id"]
                print(
                    f"submitted scene={scene_id} task_id={task_id} "
                    f"duration={scene['duration']}s",
                    flush=True,
                )
            task_ids[scene_id] = task_id
            interval = initial_poll_interval(body, None)
            active[scene_id] = {
                "task_id": task_id,
                "output_dir": output_dir,
                "interval": interval,
                "next_poll": time.monotonic() + interval,
            }

        storyboard_value = payload.get("storyboard")
        storyboard_path = (
            resolve_path(base, storyboard_value)
            if isinstance(storyboard_value, str) and storyboard_value
            else None
        )
        if storyboard_path:
            update_storyboard(storyboard_path, task_ids)

        while active:
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out while waiting for the batch.")
            wait = min(item["next_poll"] for item in active.values()) - time.monotonic()
            if wait > 0:
                time.sleep(min(wait, 30.0))
                continue
            for scene_id, item in list(active.items()):
                if item["next_poll"] > time.monotonic():
                    continue
                current = request_json(
                    "GET",
                    f"{BASE_URL}/comfyui_workflow/result/{item['task_id']}",
                    headers=headers,
                )
                data = current.get("data") or {}
                status = str(data.get("status", "")).upper()
                print(
                    f"scene={scene_id} status={status} runtime={data.get('duration', 0)}",
                    flush=True,
                )
                if status == "SUCCESS":
                    write_json(item["output_dir"] / "task-result.json", current)
                    files = []
                    for index, result in enumerate(data.get("results") or [], start=1):
                        if isinstance(result, dict) and isinstance(result.get("url"), str):
                            files.append(
                                str(download_result(result["url"], item["output_dir"], index))
                            )
                    if not files:
                        raise RuntimeError(f"No downloadable result for {scene_id}.")
                    completed.append(scene_id)
                    print(f"downloaded scene={scene_id}", flush=True)
                    del active[scene_id]
                elif status in TERMINAL_FAILURES:
                    write_json(item["output_dir"] / "task-result.json", current)
                    raise RuntimeError(f"Scene {scene_id} ended with {status}.")
                else:
                    item["interval"] = next_poll_interval(item["interval"], None)
                    item["next_poll"] = time.monotonic() + item["interval"]

        if storyboard_path:
            update_storyboard(storyboard_path, task_ids)
        result_file = resolve_path(base, payload.get("result_file", "batch-result.json"))
        write_json(result_file, {"completed": completed, "task_ids": task_ids})
        print(f"COMPLETE: {len(completed)} scene(s).")
        return 0
    except (
        OSError,
        RuntimeError,
        TimeoutError,
        ValueError,
        json.JSONDecodeError,
        requests.RequestException,
    ) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
