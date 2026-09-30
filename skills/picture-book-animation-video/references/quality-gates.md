# Quality gates

Run every blocking gate before delivery.

## Input gate

- Every source file is inventoried.
- Exact duplicates are resolved.
- Perceptual duplicate warnings are reviewed.
- Reading orientation is correct.
- Page boundaries and foreign objects are identified.
- Story order is supported by evidence.
- Missing-page concerns are resolved.

## Content gate

- Every included page has a verified transcript or an explicit no-text state.
- Every scene references included page IDs.
- Every animated subject references a visual fact from those pages or an explicitly approved external asset.
- No scene contains an invented character, object, setting, action, fact, or plot event beyond an explicitly approved asset or transformation.
- Cover-derived characters appear only where the book supports them.
- Exercise and index pages have explicit inclusion decisions.

## Storyboard gate

- Scene boundaries come from verified audio sentences and pauses when original audio exists.
- Every spoken scene has a source-audio interval and a speech interval.
- Audio intervals follow scene order and do not overlap.
- The generation plan explicitly selects preview or full mode.
- Preview mode selects 2 or 3 scenes, while full mode selects every scene.
- Every included page appears in at least one scene.
- Scene order follows approved story order.
- Exact narration mode uses source wording.
- Spoken text and subtitle text match.
- Adapted wording carries explicit user approval.
- Each scene has a comprehension goal.
- Each motion choice has a purpose.
- Each transition has a narrative rationale.

Run validate_storyboard.py and require zero errors.

## Visual gate

Inspect at least the first, middle, and last meaningful frame of each scene.
Check:

- Correct crop and orientation
- No desk, hands, device edges, or unrelated background
- No exposed inpainting seams
- No black borders caused by motion
- No character identity or clothing drift
- No warped faces, hands, objects, or printed words
- No changed object count
- No subtitle overlap with focal art or original keywords
- Smooth camera easing
- Transition continuity
- Stable brightness and color across scenes
- One approved GPT Image master frame exists for every scene.
- One image-to-video clip exists for every scene.
- The generated clip begins from and remains faithful to its approved master frame.
- No identity drift, subject duplication, object morphing, or unsupported camera cut occurs.
- Every spoken video prompt contains the exact verified scene utterance.
- The speaking character's mouth moves only during the scene-local speech interval.
- The mouth does not continue speaking through the silent tail.

Reject a technically clean render when it visually misrepresents the page.

### Explicit visual-review waiver

Skip visual inspection only when the user explicitly says to skip it.
Record the request and mark visual QC as `user-waived`, not `passed`.
Still require asset existence, successful deterministic assembly, and an export that the renderer completed without error.
Do not claim character consistency, lip-sync quality, or visual fidelity was verified when inspection was waived.

## Audio gate

Listen to the complete export while following the verified transcript.
Check:

- Correct language and pronunciation
- No missing, repeated, reordered, translated, or invented words
- Natural pauses
- No clipped consonants or abrupt tails
- Speech remains intelligible over music and effects
- No clicks at cuts or fades
- Consistent perceived loudness
- Original user audio remains the final speech source when supplied.
- The visual is retimed to the original audio rather than time-stretching the original narration.
- Prompt-only lip sync is not accepted without visual review against the original audio.

## Subtitle gate

Check:

- Exact agreement with spoken text
- Timing derived from final audio
- Natural phrase breaks
- Readable size and contrast
- Safe-area placement
- No cue disappears before its phrase finishes
- No stale cue remains into the next page

## Export gate

Probe the final file and confirm:

- Expected resolution and aspect ratio
- Expected frame rate
- Complete duration
- Video stream present
- Audio stream present when narration is required
- No frozen tail, early cutoff, blank opening, or corrupt frame
- Playback succeeds outside the editing environment
- Final H.264 pixel format is `yuv420p` for broad playback compatibility
- Model-provided clip audio is absent from the final mix when original narration is supplied
- Scene clips are trimmed to the audio timeline instead of stretching the original narration

## Child-comprehension gate

Watch once without reading the storyboard.
For each page, answer:

1. What did the sentence say?
2. What should the child look at?
3. Did the animation show that exact thing?
4. Did any effect distract from the meaning?

Revise the scene when an answer is unclear.

## QC report

Record:

- Input count and unique story-unit count
- Included and excluded pages with reasons
- OCR uncertainties and resolutions
- Duplicate decisions
- Storyboard validation result
- Visual findings and fixes
- Audio findings and fixes
- Subtitle findings and fixes
- Export probe
- Accepted limitations approved by the user

Do not convert an unresolved blocker into an accepted limitation without user approval.
