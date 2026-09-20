# Animation direction

Use animation to reveal the page, not to rewrite it.

## Scene objective

Write one comprehension goal for each scene.
Choose one focal subject and one supporting detail.
Let the spoken sentence determine the order of attention.
Keep the first readable frame long enough for orientation and the last frame long enough for comprehension.

## Motion contract

Animate the approved GPT Image scene frame with an image-to-video model.
Use one primary subject action and at most one restrained camera move.
Keep the first frame composition recognizable throughout the clip.

### Character motion

Prefer breathing, a blink, a tiny head shift, a hand settle, or a gaze cue.
Preserve face, hair, clothing, body proportions, and pose logic.
Avoid lip synchronization when it would require inventing facial detail.
Reject any frame with identity drift or anatomy artifacts.

### Object and camera motion

Use a gentle push, pull, pan, or reveal when it reinforces the focal subject.
Keep object contact points believable and object counts stable.
Avoid rapid zooms, orbiting cameras, cuts, morphs, and motion that exposes unsupported areas.

## Timing

Derive scene duration from final voiceover.
Allow roughly 0.4 to 0.8 seconds before speech and 0.6 to 1.2 seconds after speech.
Give short language-learning sentences enough dwell time for a child to repeat them.
Do not rush a page to fit a predetermined total length.

## Transition grammar

Choose transitions for narrative continuity:

- Page turn for a literal reading rhythm
- Match cut for repeated shape, color, object, or composition
- Directional wipe using a source object already moving in that direction
- Focus pull from a page detail into the next scene
- Short dissolve when time or location changes gently
- Camera pullback for recap, index, or closing pages

Keep ordinary transitions near 0.4 to 0.9 seconds.
Use one transition idea at a time.
Avoid spins, flashes, glitch, random particles, and unrelated wipes.
Do not let a transition cover a keyword before it has been read.

## Page-type patterns

### Cover

Begin with the full cover or enough context to establish the book.
Move toward the title and principal subject.
Speak only the visible title unless the user supplies an introduction.

### Single-object or category page

Establish the complete page.
Move attention from the sentence to the pictured object, or reverse that order when the language lesson benefits.
Use a gentle object emphasis without changing quantity or type.

### Character action page

Follow the direction of the character’s established gaze or movement.
Use micro-motion only when the pose supports it.

### Dense spread

Begin wide.
Use one or two guided stops that correspond to the sentence.
Avoid fast scanning across many details.

### Exercise or recap

Show the structure before highlighting an answer path.
Do not reveal answers the page does not provide.
Use a pullback or page-turn transition to signal the change from story to activity.

## Subtitles

Use the exact spoken text.
Break lines at natural phrase boundaries.
Keep to two lines when possible.
Avoid more than about 14 Latin words or 20 Chinese characters on screen at once.
Use a high-contrast backing shape only when the image requires it.
Keep the original printed keyword unobstructed.
Highlight the currently spoken word only when alignment is reliable.

## Voice and sound

Choose a clear natural voice without exaggerated baby talk.
Use a slightly slower pace than general adult narration.
Preserve correct source-language pronunciation.
Keep sentence-final pauses long enough for comprehension.
Keep music at least 14 to 20 dB below narration as a starting point.
Duck music smoothly under speech.
Use sound effects only for visible or text-supported events.

## Renderer selection

Use GPT Image to create every approved scene frame and an image-to-video model to create every scene clip.
Use a deterministic editor only for ordering, trimming, transitions, subtitles, audio, and final encoding.
Do not use HyperFrames, static page pans, or slideshow motion as a substitute for scene-video generation.
