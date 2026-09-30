# Audio-first scene segmentation

Use this reference whenever narration audio is available.

## Timing source of truth

Use the original narration audio as the master clock.
Probe its duration, sample rate, channels, and silence structure before defining scenes.
Obtain word-level timestamps with ASR or forced alignment, then compare every recognized utterance with the verified page transcript.
Do not treat uncertain recognition as verified wording.
Persist the raw ASR or alignment output, the verified utterance list, and the derived `audio-analysis.json` in the project.

## Capability and environment policy

Prefer an installed offline ASR or forced-alignment tool that can return word timestamps.
Probe the tool before changing the Python environment.
If a local ASR fails because of dependency conflicts, use an isolated virtual environment or another installed engine.
Never downgrade or replace packages in the user's global Python environment to make transcription work.
When only sentence timestamps are available, record the reduced timing precision and do not claim word-level lip synchronization.

Prepare a verified utterance JSON file, then derive continuous scene intervals from Whisper-compatible word timestamps:

    python <skill-dir>/scripts/derive_audio_timeline.py <work-dir>/whisper.json <work-dir>/utterances.json <work-dir>/audio-analysis.json --audio-file <original-audio>

The script aligns exact normalized tokens, creates an optional silent intro, places later boundaries midway between adjacent utterances, and records scene-local speech times.
Stop when exact token alignment fails.

## Boundary rules

Create one scene for one complete spoken sentence or one coherent audio beat.
Place scene boundaries inside natural silence, never inside a word or phoneme.
Use roughly 0.3 to 0.6 seconds of visual lead before speech and 0.5 to 1.0 seconds of visual tail after speech when the source silence permits it.
When two sentences share one page, keep them together only when the audio has no meaningful pause and the visual action is continuous.
When one long sentence contains multiple visual beats, split only at a verified pause and keep the exact sentence wording intact across the resulting cues.
Treat music-only introductions and endings as silent-narration scenes with explicit audio intervals.
When a complete audio track is used as the final soundtrack, make scene intervals continuous from time zero through the probed audio duration.
Use the midpoint between the previous speech end and the next speech start as the ordinary boundary.
Use a short lead before the first utterance and preserve the remaining opening audio as a silent intro scene when needed.

## Page mapping

Match each utterance to a page using exact wording first, then visual semantics and page order.
Record a blocker when the audio says wording that is absent from the supplied pages or when a page sentence has no matching audio.
Do not silently drop, reorder, or synthesize missing narration.
When a dedicated page is absent but a supplied cover, index, or review page visibly supports the same object, follow the evidence-substitution rule in `source-analysis.md` and record the resolution.

## Required scene audio record

Store this object on every scene:

```json
{
  "audio_segment": {
    "source_file": "book.mp3",
    "start_seconds": 9.5,
    "end_seconds": 12.45,
    "speech_start_seconds": 9.76,
    "speech_end_seconds": 12.16
  }
}
```

Use null speech timestamps for a genuinely silent or music-only scene.
Keep source timestamps absolute so they remain auditable against the original MP3.

## Duration and lip-sync lock

Calculate the scene-video duration from the selected audio segment.
If the image-to-video workflow accepts only integer seconds, request the smallest supported integer duration that contains the complete audio segment and trim or retime the video, never the original audio, during assembly.
Put the exact `spoken_text` in quotation marks in the generation prompt.
Name the speaking character and require one delivery with no added words.
Require visible mouth motion to begin with `speech_start_seconds` and end with `speech_end_seconds` after conversion to scene-local time.

During QC, combine the generated visual with the original scene audio and inspect the opening consonant, major syllable changes, sentence end, and silent tail.
Regenerate when the mouth moves during silence, stops substantially before the sentence ends, or continues substantially after it.
Use an audio-conditioned model or lip-sync pass when prompt-only generation cannot meet the required precision.
