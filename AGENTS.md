# AGENTS.md

A shared room where friends code together: one workspace copy, live cursors,
a shared shell and terminal, chat, and each member's own AI plan. Server is
Fastify + TypeScript, web is React + Vite, both in one npm workspace.

## Commands

```bash
npm run typecheck          # server + web, no emit
npm test                   # vitest, server only
npm run build              # web bundle, then server tsc
npm run dev                # server with tsx watch (web: npm run dev --workspace web)
npm run test:ui            # builds, then playwright walks the real UI
npm run test:audit         # builds, then screenshots every panel for inspection
npm run room:image         # docker image the guest shell runs in
```

Tests force `CLIMP_SHELL=host` (see `server/test/setup.ts`): fast and
deterministic. Container flags are asserted in `server/test/shell.test.ts`
instead of being run. `test/ui.mjs` and `test/audit.mjs` drive real chromium
through playwright and are the only coverage of the docker path.

## Layout

| Path | Role |
| --- | --- |
| `server/src/server.ts` | HTTP routes, static web, startup |
| `server/src/control.ts` | the websocket protocol, roles, approvals, chat |
| `server/src/rooms.ts` | room codes, members, invites, workspace seeding |
| `server/src/container.ts` | docker run flags, per-member homes, exec plans |
| `server/src/workspace.ts` | path containment and file IO |
| `server/src/docs.ts` | yjs docs per room file, batched writes to disk |
| `web/src/Workspace.tsx` | the room UI and websocket client |
| `server/test/` | vitest; `test/*.mjs` | end-to-end scripts |

`README.md` carries the user-facing story and limits. Keep it in step with
behaviour.

## Non-obvious behaviour

- **The workspace is a copy.** `createRoom` copies the host's source folder into
  `$CLIMP_DATA/rooms/<code>/workspace`. Nothing writes back to the host folder;
  deleting a room deletes the copy.
- **Two shell modes.** `useDocker()` decides between a per-room container and a
  login shell as the server user. Auto mode falls back to the host when docker
  is missing, which is much less contained, so the mode is surfaced on the
  landing page, in the room menu, and at startup.
- **Approvals gate the shared line-based shell only.** Guests get a regex risk
  prompt (`server/src/risk.ts`) that only the host or an editor can answer.
  Editors and hosts run without asking. Personal terminals are raw TTYs and are
  never gated. Editing files is never gated either, at any role.
- **The container is already tight.** Read-only root, tmpfs `/tmp`, no caps,
  `no-new-privileges`, memory/CPU/PID caps, workspace and homes only. Global npm
  installs work because `npm_config_prefix` points into the member home; that is
  why the root stays read-only. `apt-get install` inside a room will fail.
- **Restart after `npm run build`.** `web/index.html` points at hashed bundles
  from `web/dist`, and `webDir` existence is checked at boot. A server started
  before a rebuild keeps serving the old asset map, so `/assets/*.js` returns
  `index.html` and the app renders blank.
- **Member homes, not your home.** The container sees `/homes/<memberId>` as
  `$HOME`; a file written there survives a reconnect but the host home stays
  outside the mount.
- Rooms persist in `$CLIMP_DATA` and are deleted after `CLIMP_ROOM_IDLE_MINUTES`
  of no connections; the workspace copy and containers go with them.
- Sessions are the `climp` cookie holding `<code>.<token>`; the websocket accepts
  the same token in `?token=` for tests and the CLI.

## Conventions

- Relative imports with `.js` on TypeScript sources, no path aliases.
- Server state lives in module-level maps (`clients`, `approvals`, `terminals`,
  `byRoom`); there is no DI container. New state needs a cleanup path on room
  close and on socket close.
- Errors reaching the client are plain sentences in the UI voice, no stack traces.
- Extra server-side resources (timers, listeners, sockets) are cleaned up in the
  same function that creates them; leaking one keeps a room container alive.
- No comments restating the code. Comments explain the reason a thing is the way
  it is.
