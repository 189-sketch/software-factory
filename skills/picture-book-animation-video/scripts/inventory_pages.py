#!/usr/bin/env python3
"""Inventory picture-book images and flag exact or perceptual duplicates."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable

try:
    from PIL import Image, ImageOps
except ImportError as exc:
    raise SystemExit(
        "Pillow is required. Install it with: python -m pip install Pillow"
    ) from exc


SUPPORTED_EXTENSIONS = {
    ".bmp",
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
}
EXIF_ORIENTATION_TAG = 274


def natural_key(path: Path) -> list[object]:
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", path.name)
    ]


def collect_files(inputs: Iterable[str], recursive: bool) -> list[Path]:
    files: list[Path] = []
    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_file():
            if path.suffix.casefold() in SUPPORTED_EXTENSIONS:
                files.append(path.resolve())
            continue
        if path.is_dir():
            iterator = path.rglob("*") if recursive else path.glob("*")
            files.extend(
                candidate.resolve()
                for candidate in iterator
                if candidate.is_file()
                and candidate.suffix.casefold() in SUPPORTED_EXTENSIONS
            )
            continue
        raise FileNotFoundError(f"Input does not exist: {path}")
    return sorted(dict.fromkeys(files), key=natural_key)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def difference_hash(image: Image.Image) -> int:
    gray = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = gray.tobytes()
    value = 0
    for row in range(8):
        offset = row * 9
        for column in range(8):
            value <<= 1
            value |= pixels[offset + column] > pixels[offset + column + 1]
    return value


def rotation_hashes(image: Image.Image) -> dict[str, str]:
    sample = image.copy()
    sample.thumbnail((512, 512), Image.Resampling.LANCZOS)
    return {
        str(angle): f"{difference_hash(sample.rotate(angle, expand=True)):016x}"
        for angle in (0, 90, 180, 270)
    }


def orientation_label(width: int, height: int) -> str:
    if width == height:
        return "square"
    return "landscape" if width > height else "portrait"


def inspect_file(path: Path) -> dict[str, object]:
    exact_hash = sha256_file(path)
    with Image.open(path) as source:
        exif = source.getexif()
        exif_orientation = exif.get(EXIF_ORIENTATION_TAG)
        original_width, original_height = source.size
        normalized = ImageOps.exif_transpose(source)
        normalized.load()
        display_width, display_height = normalized.size
        hashes = rotation_hashes(normalized)
        return {
            "path": str(path),
            "name": path.name,
            "size_bytes": path.stat().st_size,
            "sha256": exact_hash,
            "original_width": original_width,
            "original_height": original_height,
            "exif_orientation": exif_orientation,
            "display_width": display_width,
            "display_height": display_height,
            "display_shape": orientation_label(display_width, display_height),
            "aspect_ratio": round(display_width / display_height, 6),
            "rotation_dhash": hashes,
        }


def hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def closest_rotation_pair(
    left: dict[str, str], right: dict[str, str]
) -> tuple[int, int, int]:
    best = (65, 0, 0)
    for left_angle, left_hash in left.items():
        for right_angle, right_hash in right.items():
            candidate = (
                hamming_distance(int(left_hash, 16), int(right_hash, 16)),
                int(left_angle),
                int(right_angle),
            )
            if candidate < best:
                best = candidate
    return best


def build_report(files: list[Path], threshold: int) -> dict[str, object]:
    records: list[dict[str, object]] = []
    errors: list[dict[str, str]] = []
    for path in files:
        try:
            records.append(inspect_file(path))
        except Exception as exc:
            errors.append({"path": str(path), "error": str(exc)})

    by_hash: dict[str, list[str]] = defaultdict(list)
    for record in records:
        by_hash[str(record["sha256"])].append(str(record["path"]))
    exact_groups = [
        {"sha256": digest, "files": paths}
        for digest, paths in by_hash.items()
        if len(paths) > 1
    ]

    near_pairs: list[dict[str, object]] = []
    for index, left in enumerate(records):
        for right in records[index + 1 :]:
            if left["sha256"] == right["sha256"]:
                continue
            distance, left_angle, right_angle = closest_rotation_pair(
                left["rotation_dhash"], right["rotation_dhash"]
            )
            if distance <= threshold:
                near_pairs.append(
                    {
                        "left": left["path"],
                        "right": right["path"],
                        "distance": distance,
                        "left_rotation": left_angle,
                        "right_rotation": right_angle,
                    }
                )

    warnings: list[str] = []
    if exact_groups:
        warnings.append(
            f"Found {len(exact_groups)} exact duplicate group(s); keep one capture per story unit."
        )
    if near_pairs:
        warnings.append(
            f"Found {len(near_pairs)} perceptual duplicate candidate(s); review them visually."
        )
    if errors:
        warnings.append(f"Could not inspect {len(errors)} file(s).")

    return {
        "schema_version": 1,
        "file_count": len(files),
        "inspected_count": len(records),
        "files": records,
        "exact_duplicate_groups": exact_groups,
        "near_duplicate_candidates": near_pairs,
        "errors": errors,
        "warnings": warnings,
        "analysis_limits": [
            "Natural filename order is not proof of story order.",
            "Display shape is not proof of reading orientation.",
            "Perceptual duplicate candidates require visual review.",
            "OCR, crop, perspective, page role, and missing-page decisions require visual analysis.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inventory picture-book image files and detect duplicates."
    )
    parser.add_argument("inputs", nargs="+", help="Image files or directories.")
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Search input directories recursively.",
    )
    parser.add_argument(
        "--near-threshold",
        type=int,
        default=5,
        help="Maximum 64-bit dHash distance for a perceptual duplicate candidate.",
    )
    parser.add_argument(
        "--output",
        help="Write JSON to this path instead of standard output.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 0 <= args.near_threshold <= 64:
        raise SystemExit("--near-threshold must be between 0 and 64.")
    try:
        files = collect_files(args.inputs, args.recursive)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if not files:
        print("No supported image files were found.", file=sys.stderr)
        return 2

    report = build_report(files, args.near_threshold)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")
        print(f"Wrote inventory for {len(files)} file(s) to {output_path}")
    else:
        print(rendered)
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
