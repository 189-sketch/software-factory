# Original-audio timeline assembly

Use this reference whenever the user supplies narration audio or scene clips contain model-generated audio.

## Master clock

Use the original narration audio from time zero through its probed duration as the master clock.
Create continuous, non-overlapping scene intervals that cover that same duration.
Do not concatenate isolated audio excerpts when the complete original track is available.
Do not time-stretch, truncate, reorder, or synthesize over the original narration.

## Transition compensation

A crossfade shortens the sum of clip durations by its overlap.
Compensate by trimming every non-final visual clip to:

    scene timeline duration + transition duration

Start each crossfade at the cumulative end time of the current scene on the audio timeline.
The final visual duration then remains equal to the original audio duration.

## Video normalization

Scale each generated clip to fill the delivery canvas, then center-crop to the exact output dimensions.
Convert all clips to the final frame rate before crossfading.
Discard every generated clip audio stream.
Map only the original narration audio into the final output.
Normalize the decoded audio timestamp to zero with `atrim` and `asetpts` without changing its speed.

Apply subtitles after the final crossfade chain.
Apply `format=yuv420p` after subtitle rendering because subtitle filters can change the pixel format.
Also set the encoder pixel format explicitly to `yuv420p`.

## Deterministic command

Create the assembly manifest described in [production-manifests.md](production-manifests.md), then run:

    python <skill-dir>/scripts/assemble_scenes.py <assembly-manifest.json> --validate-only
    python <skill-dir>/scripts/assemble_scenes.py <assembly-manifest.json>

The script computes the transition offsets, trims excess model duration, removes model audio, burns ASS subtitles when supplied, and writes an H.264/AAC MP4 with fast-start metadata.
