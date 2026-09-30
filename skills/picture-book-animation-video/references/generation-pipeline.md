# Generative production pipeline

Use this reference for the required GPT Image and image-to-video stages.

## Scene analysis record

Record these fields before generating a scene image:

- source_page_ids
- setting
- core_elements
- literal_semantics
- context
- focal_subject
- approved_character_sources
- allowed_action
- prohibited_additions
- subtitle_safe_area

Do not turn an inference into a visible event unless the source image, source wording, or explicit user approval supports it.

## GPT Image scene frame

Generate exactly one approved master frame for each scene.
Label every input image as a page-content reference, character-identity reference, style reference, or compositing insert.
Include the intended 16:9 animation use, source-supported scene facts, composition, focal hierarchy, authorized IP invariants, and negative constraints in the prompt.
Require no embedded text unless the printed text itself is a required visual fact.
Save the final prompt and generated file path in the storyboard.
Copy each returned image immediately to a deterministic scene-ID filename.
Never infer which output belongs to which scene from completion timestamps when generation runs concurrently.

When the user supplies a recurring IP, preserve its face, hair, glasses, clothing, proportions, linework, palette, and personality.
Do not add or replace a user IP without explicit authorization.

## Image-to-video direction

Use the approved generated frame as the scene's first-frame reference.
Describe only visible motion, camera behavior, duration, and stability constraints.
Prefer one primary action and one restrained camera move.
Require identity consistency, stable object count, stable background structure, no cuts, no new subjects, no text generation, and no morphing.
For a spoken scene, quote the exact verified utterance in the prompt and identify the one character who speaks it.
Use scene-local speech timing derived from `audio_segment` and direct mouth motion to occur only inside that interval.
Keep model-generated speech as a timing reference only when the final production must use the user's original MP3.
Replace the model audio with the original scene segment during assembly.

## AutoDL ComfyUI API

Inspect the current schema before each production run:

    GET https://autodl.art/api/v1/comfyui/workflows/<workflow_id>

Submit a task:

    POST https://autodl.art/api/v1/comfyui/comfyui_workflow/<workflow_id>

Poll the returned task ID:

    GET https://autodl.art/api/v1/comfyui/comfyui_workflow/result/<task_id>

Pass the token in the `Authorization` header exactly as provided by AutoDL.
Keep it in an environment variable and redact it from logs.
Treat `QUEUED` and `RUNNING` as non-terminal states, `SUCCESS` as success, and `FAILED` as failure.
Download every result URL immediately after success.

For preview mode, run the single-scene client:

    python <skill-dir>/scripts/autodl_comfyui_client.py <workflow-id> <request.json> <clip-dir>

For full mode, create a batch manifest and run:

    python <skill-dir>/scripts/autodl_comfyui_batch.py <batch-manifest.json>

The batch client submits all missing scenes, resumes task IDs already stored in each clip directory, polls every active task independently, and downloads successful results immediately.
Read [production-manifests.md](production-manifests.md) before creating the batch manifest.

Keep the token in the configured environment variable before launching either client.
Do not paste a token into a visible interactive shell that echoes input.
Do not store a token in a request, batch manifest, storyboard, log, or script.

AutoDL requires a reachable image URL for `ref_image_0`.
Prefer a private or user-controlled URL.
If the user explicitly permits temporary public upload, pass `--allow-temporary-public-upload` to the batch client and upload only generated scene frames.
Never upload original photographed pages, the raw user IP sheet, narration audio, or credentials to a public temporary host.

Derive the first polling delay from the requested `duration`.
Use the requested duration as the default first wait, clamped to 2 through 20 seconds.
When the task remains `QUEUED` or `RUNNING`, multiply the wait by 1.5 up to 30 seconds.
Use a fixed polling interval only for debugging or a workflow with documented timing requirements.

For `minimax_h3_lightx2v_v5`, the live schema exposes:

- `prompt`: required motion prompt
- `duration`: integer from 1 to 10 seconds
- `resolution`: enum including `1080p横`
- `ref_image_0`: required JPG, PNG, or WebP URL
- `ref_image_1` through `ref_image_8`: optional additional reference URLs
- `seed`: optional integer

Use `1080p横` for a 1920×1080 landscape deliverable.
Do not assume these fields apply to another workflow ID.
Treat the actual downloaded clip dimensions as model output rather than a delivery guarantee.
Normalize outputs such as 1920×1056 to the required 1920×1080 canvas during deterministic assembly.

## Assembly

Keep the original narration MP3 unchanged when the user supplies it.
Select the source-audio interval for each page from verified word timing.
Place subtitles from the exact verified wording on the final edit timeline.
Use FFmpeg or another deterministic editor to trim clips, add semantic transitions, mix the source audio, burn or attach subtitles, and encode the final MP4.
