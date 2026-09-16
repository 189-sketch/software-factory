# Storyboard contract

Use the JSON storyboard as the production source of truth.
Keep it valid after every approved change.

## Top-level fields

- version: integer 1
- project: output and language settings
- pages: evidence records for physical or logical story units
- approved_assets: optional user-authorized external character or style assets
- generation_plan: explicit preview or full production selection
- scenes: ordered production units

## Project fields

Required fields:

- title
- source_language
- aspect_ratio
- width
- height
- fps
- narration_default

Use narration_default exact unless the user explicitly approves adaptation.

## Generation plan fields

Required fields:

- mode: preview or full
- scene_ids: ordered scene IDs selected for generation
- decision_note: record the user's choice

Preview mode requires 2 or 3 scene IDs.
Full mode requires every storyboard scene ID.
Create the complete storyboard before applying either generation mode.

## Page fields

Required fields:

- id: stable unique identifier
- order: positive unique integer
- source_files: non-empty list of original or normalized source paths
- role: page-role value from source-analysis.md
- include: boolean
- inclusion_reason: concise evidence-based reason
- printed_page_number: string or null
- transcript_status: verified, uncertain, or none
- transcript: verbatim visible narrative wording
- visual_facts: list of traceable visible elements
- issues: list of unresolved or resolved source issues

Each visual fact requires:

- id: globally unique source-element identifier
- description: literal visual description
- source_file: one file listed by the page

Do not encode desired animation as a visual fact.

## Approved asset fields

Each optional approved asset requires:

- id: stable globally unique identifier
- type: character_ip, style_reference, or other
- source_file: original asset path
- description: literal description
- approval_note: concise record of the user's explicit authorization

Do not add an external asset without explicit user approval.

## Scene fields

Required fields:

- id: stable unique identifier
- order: positive unique integer
- page_ids: non-empty list of referenced included pages
- comprehension_goal
- source_text
- narration_mode
- spoken_text
- subtitle_text
- visual_source_ids
- approved_asset_ids
- audio_segment
- scene_image: object containing path, prompt, and reference_files after GPT Image generation
- video_clip: object containing path, workflow_id, task_id, prompt, and resolution after image-to-video generation
- motion
- transition_out
- duration_seconds
- audio_notes

Use one of these narration modes:

- exact
- silent
- approved_adaptation

For exact mode, source_text, spoken_text, and subtitle_text must match after harmless whitespace and punctuation normalization.
The normalized source_text must occur in the verified transcript of a referenced page.
For silent mode, all three text fields must be empty.
For approved_adaptation, spoken_text and subtitle_text must match and approval_note must record the user’s approval.

The audio_segment object requires:

- source_file: original narration audio path
- start_seconds: absolute segment start in the original audio
- end_seconds: absolute segment end in the original audio
- speech_start_seconds: absolute speech start or null for a silent scene
- speech_end_seconds: absolute speech end or null for a silent scene

Require `start_seconds < end_seconds`.
For a spoken scene, require both speech timestamps inside the segment.
Keep audio segments in scene order and do not overlap intervals from the same source file.

Each motion item requires:

- target_source_id
- action
- purpose

The target_source_id must name a visual fact or approved asset referenced by the scene.

The transition_out object requires:

- type
- rationale

Add target_source_id when a source element drives the transition.

## Duration rule

Set duration after final narration exists.
Use the voiceover duration plus reading and transition buffers.
Do not shorten the voice to force a planned duration.

## Page coverage rule

Reference every included page in at least one scene.
Do not reference excluded pages.
Do not map two exact-duplicate files to separate included pages.

## Validation

Run the planning gate:

    python <skill-dir>/scripts/validate_storyboard.py storyboard.json

Run the final asset gate:

    python <skill-dir>/scripts/validate_storyboard.py storyboard.json --stage final

Add --manifest page-inventory.json to cross-check source files and exact duplicates.
Zero errors are required before asset generation and again before final render.
At the final gate, require generated image and video records only for the scene IDs selected by `generation_plan`.
For every selected spoken scene, require the normalized `video_clip.prompt` to contain the normalized exact `spoken_text`.
