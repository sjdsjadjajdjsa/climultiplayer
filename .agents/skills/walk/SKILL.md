---
name: walk
description: Screenshot every surface of the app into /tmp/climp-walk and review them visually. Say "walk the app" or "/walk", add "dark" for the dark theme.
user-invocable: true
---

Run the visual walk and then actually look at the result:

1. `npm run test:walk` (builds, then drives chromium through every surface).
   For the dark theme: `WALK_SCHEME=dark WALK_OUT=/tmp/climp-walk-dark node test/walk.mjs`.
2. View the screenshots from the output folder. Files over ~200 KB must be
   downscaled first, e.g. `ffmpeg -y -loglevel error -i SHOT.png -vf scale=700:-1 -q:v 6 SHOT.jpg`.
3. Report what looks off: contrast, alignment, truncation, dead space.
   Compare against the design rules in AGENTS.md (flat, warm paper, no glow,
   no pill radius).
