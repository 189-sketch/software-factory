#!/usr/bin/env python3
"""Submit, poll, and download an AutoDL ComfyUI workflow result."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import requests


BASE_URL = "https://autodl.art/api/v1/comfyui"
TERMINAL_FAILURES = {"FAILED", "CANCELLED", "CANCELED"}
MIN_ADAPTIVE_POLL_SECONDS = 2.0
MAX_INITIAL_POLL_SECONDS = 20.0
MAX_ADAPTIVE_POLL_SECONDS = 30.0
POLL_BACKOFF = 1.5


def request_json(method: str, url: str, *, headers=None, body=None):
    response = requests.request(method, url, headers=headers, json=body, timeout=60)
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != "Success":
        raise RuntimeError(payload.get("msg") or f"API returned {payload.get('code')}")
    return payload


def download_result(url: str, output_dir: Path, index: int) -> Path:
    response = requests.get(url, timeout=300, stream=True)
    response.raise_for_status()
    suffix = Path(urlparse(url).path).suffix or ".bin"
    output_path = output_dir / f"result-{index:02d}{suffix}"
    with output_path.open("wb") as handle:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                handle.write(chunk)
    return output_path


def requested_duration(body: dict) -> float:
    value = body.get("duration", MIN_ADAPTIVE_POLL_SECONDS)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return MIN_ADAPTIVE_POLL_SECONDS
    return float(value)


def initial_poll_interval(body: dict, fixed_seconds: float | None) -> float:
    if fixed_seconds is not None:
        return fixed_seconds
    return max(
        MIN_ADAPTIVE_POLL_SECONDS,
        min(MAX_INITIAL_POLL_SECONDS, requested_duration(body)),
    )


def next_poll_interval(current: float, fixed_seconds: float | None) -> float:
    if fixed_seconds is not None:
        return fixed_seconds
    return min(MAX_ADAPTIVE_POLL_SECONDS, current * POLL_BACKOFF)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow_id")
    parser.add_argument("body_json", help="JSON request body path.")
    parser.add_argument("output_dir")
    parser.add_argument("--token-env", default="AUTODL_TOKEN")
    parser.add_argument(
        "--poll-seconds",
        type=float,
        help="Fixed polling interval. Omit to derive an adaptive interval from video duration.",
    )
    parser.add_argument("--timeout-seconds", type=float, default=1800.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get(args.token_env)
    if not token:
        print(f"ERROR: environment variable {args.token_env} is not set.", file=sys.stderr)
        return 2
    body = json.loads(Path(args.body_json).read_text(encoding="utf-8"))
    if args.poll_seconds is not None and args.poll_seconds <= 0:
        print("ERROR: --poll-seconds must be positive.", file=sys.stderr)
        return 2
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    headers = {"Authorization": token, "Content-Type": "application/json"}

    schema = request_json("GET", f"{BASE_URL}/workflows/{args.workflow_id}")
    (output_dir / "workflow-schema.json").write_text(
        json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    created = request_json(
        "POST",
        f"{BASE_URL}/comfyui_workflow/{args.workflow_id}",
        headers=headers,
        body=body,
    )
    task_id = created["data"]["task_id"]
    (output_dir / "task-created.json").write_text(
        json.dumps(created, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"submitted task_id={task_id}", flush=True)

    deadline = time.monotonic() + args.timeout_seconds
    query_url = f"{BASE_URL}/comfyui_workflow/result/{task_id}"
    poll_interval = initial_poll_interval(body, args.poll_seconds)
    poll_mode = "fixed" if args.poll_seconds is not None else "adaptive"
    print(
        f"poll_mode={poll_mode} first_poll_in={poll_interval:g}s",
        flush=True,
    )
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        time.sleep(min(poll_interval, max(0.0, remaining)))
        if time.monotonic() >= deadline:
            break
        current = request_json("GET", query_url, headers=headers)
        data = current.get("data") or {}
        status = str(data.get("status", "")).upper()
        print(f"status={status} duration={data.get('duration', 0)}", flush=True)
        if status == "SUCCESS":
            (output_dir / "task-result.json").write_text(
                json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            results = data.get("results") or []
            downloaded = []
            for index, result in enumerate(results, start=1):
                if isinstance(result, dict) and isinstance(result.get("url"), str):
                    downloaded.append(str(download_result(result["url"], output_dir, index)))
            print(json.dumps({"task_id": task_id, "files": downloaded}, ensure_ascii=False))
            return 0
        if status in TERMINAL_FAILURES:
            (output_dir / "task-result.json").write_text(
                json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(f"ERROR: task ended with {status}.", file=sys.stderr)
            return 1
        poll_interval = next_poll_interval(poll_interval, args.poll_seconds)
        print(f"next_poll_in={poll_interval:g}s", flush=True)

    print("ERROR: timed out while waiting for workflow result.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
