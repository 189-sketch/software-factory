# Audio-first scene segmentation

Use this reference whenever narration audio is available.

## Timing source of truth

Use the original narration audio as the master clock.
Probe its duration, sample rate, channels, and silence structure before defining scenes.
Obtain word-level timestamps with ASR or forced alignment, then compare every recognized utterance with the verified page transcript.
Do not treat uncertain recognition as verified wording.

## Boundary rules

Create one scene for one complete spoken sentence or one coherent audio beat.
Place scene boundaries inside natural silence, never inside a word or phoneme.
Use roughly 0.3 to 0.6 seconds of visual lead before speech and 0.5 to 1.0 seconds of visual tail after speech when the source silence permits it.
When two sentences share one page, keep them together only when the audio has no meaningful pause and the visual action is continuous.
When one long sentence contains multiple visual beats, split only at a verified pause and keep the exact sentence wording intact across the resulting cues.
Treat music-only introductions and endings as silent-narration scenes with explicit audio intervals.

## Page mapping

Match each utterance to a page using exact wording first, then visual semantics and page order.
Record a blocker when the audio says wording that is absent from the supplied pages or when a page sentence has no matching audio.
Do not silently drop, reorder, or synthesize missing narration.

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
