# Production manifests

Use these manifests to keep full-scene generation and final assembly resumable and deterministic.

## AutoDL batch manifest

Create one scene entry for every selected storyboard scene.
Keep the exact spoken sentence inside `prompt` for spoken scenes.

```json
{
  "workflow_id": "minimax_h3_lightx2v_v5",
  "storyboard": "storyboard.json",
  "result_file": "batch-result.json",
  "scenes": [
    {
      "scene_id": "s001",
      "image_path": "assets/generated-scenes/s001.png",
      "prompt": "The child says exactly: \"I can see the apples.\" Mouth motion begins at 0.40 seconds and ends at 3.18 seconds. Preserve identity, objects, and background. No cuts, text, or morphing.",
      "duration": 5,
      "resolution": "1080p横",
      "output_dir": "clips/s001"
    }
  ]
}
```

Use `ref_image_0` instead of `image_path` when the generated frame already has a reachable URL.
Use `request_overrides` only for fields confirmed by the live workflow schema.
Run `--validate-only` before paid submission.

## Assembly manifest

Use the original narration audio as the master clock.
Set each `timeline_duration` to the scene's exact non-overlapping audio interval length.

```json
{
  "audio": "audio/original.mp3",
  "subtitles": "subtitles/book.ass",
  "output": "final/book.mp4",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "transition_seconds": 0.4,
  "crf": 18,
  "scenes": [
    {
      "scene_id": "s001",
      "clip": "clips/s001/result-01.mp4",
      "timeline_duration": 4.2,
      "transition": "fade"
    },
    {
      "scene_id": "s002",
      "clip": "clips/s002/result-01.mp4",
      "timeline_duration": 3.5,
      "transition": "fade"
    }
  ]
}
```

The assembly script trims every non-final clip to `timeline_duration + transition_seconds` and overlaps that extra material with the next clip.
This preserves the original audio clock while still producing an elegant crossfade.
Run `--validate-only` before encoding.
