# Contributing

Run it:

```bash
npm install
npm run build
CLIMP_ROOM_NETWORK=host npm start     # use host networking behind a VPN
```

Checks before a pull request:

```bash
npm run typecheck
npm test                       # unit tests, host shell, a couple of seconds
CLIMP_SHELL=docker npm run test:ui   # browser and container end to end
```

`AGENTS.md` describes how the pieces fit and the traps: the workspace is a copy,
the shell has two modes, approvals only cover the shared line-based shell, and
the asset map needs a restart after a build. Read it before changing behaviour.

House style: plain sentences for anything the user reads, no comments that
restate the code, no em dashes in source, and keep `README.md` in step with what
the app actually does.

New behaviour needs a test at the level it lives: a vitest case for server logic,
a check in `test/ui.mjs` for something only a browser can prove. Screenshots in
`docs/` come from `npm run docs:shots`; do not retouch them by hand.
