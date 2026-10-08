# Contributing

Thanks for helping. demoloom is small on purpose: a recorder, a planner, a
compositor page and a score. Please keep it that way.

## Setup

```
npm install
npx playwright install chromium
brew install ffmpeg        # or apt-get install ffmpeg
npm test
```

## Working on the picture

Record the example once, then iterate on stills, which take seconds:

```
node bin/demoloom.mjs record examples/todo/flow.mjs
node bin/demoloom.mjs render examples/todo --stills --shape=both
node bin/demoloom.mjs render examples/todo --verify --shape=both
```

Open `examples/todo/out/stills/contact.png` to see the whole video at a glance.

## Rules

- **Determinism.** A frame must be a pure function of its time. No
  `Math.random()`, `Date.now()` or state carried from the previous frame in
  `page/` or `src/motion.cjs`; seed anything random. `render --verify` and
  `npm test` must pass.
- **Licences.** Only CC0 audio in `samples/`, only OFL (or similarly open) fonts
  with their licence files in `assets/fonts/`. Note anything new in
  `THIRD_PARTY.md`.
- **No secrets.** Voice providers use the user's own login (gcloud, the OS).
  Never commit keys, tokens, project IDs or recordings of real accounts.
- **Style.** Plain modern JavaScript, no build step, no new dependencies unless
  they pull real weight. Comments explain why, not what.
- **Tests.** Maths that the video depends on (camera, cursor, time map,
  captions, schema) gets a test in `test/`.

## Pull requests

Describe what changed in the picture or the sound, and attach a still or a
short clip when it is visual.
