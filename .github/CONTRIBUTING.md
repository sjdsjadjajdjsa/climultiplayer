# Contributing

## Run it for development

```bash
npm install
npm run dev                    # server, with reload
npm run dev --workspace web    # in a second shell: Vite, proxying to the server
```

`npm start` builds and serves the real bundle instead. Behind a VPN, add
`CLIMP_ROOM_NETWORK=host CLIMP_ALLOW_HOST_NETWORK=1`.

## Before a pull request

```bash
npm run typecheck
npm test                             # server suite, a couple of seconds
CLIMP_SHELL=docker npm run test:ui   # two real browsers and a container, end to end
```

| Command | What it covers |
|---|---|
| `npm test` | rooms, invites, auth, sync, containment |
| `npm run test:ui` | two browsers through the whole join and edit path |
| `npm run test:audit` | opens every panel and control, fails on any dead end |
| `npm run test:walk` | screenshots every surface into `/tmp/climp-walk` for a visual check |

The browser suites need a Chromium binary (`npx playwright install chromium`, or
set `CHROME_BIN`). Each starts its own server on a random port and cleans up.

New behaviour needs a test at the level it lives: a vitest case for server
logic, a check in `test/ui.mjs` for something only a browser can prove.

## Finding your way

[docs/architecture.md](../docs/architecture.md) explains how the pieces fit.
[AGENTS.md](../AGENTS.md) lists the traps: the workspace is a copy, the shell
has two modes, approvals only cover the shared shell, and the asset map needs a
restart after a build. Read both before changing behaviour.

## House style

- Plain sentences for anything the user reads.
- No comments that restate the code; comments explain why.
- No em dashes in source.
- Keep `README.md` and `docs/` in step with what the app actually does.
- Screenshots in `docs/` come from `npm run docs:shots`, and the clip from
  `npm run docs:gif` (needs `ffmpeg` and ImageMagick). Do not retouch them by
  hand.
