# Configuration

Everything is an environment variable; there is no config file.

```bash
PORT=8790 CLIMP_ROOM_NETWORK=none npm start
```

## Server

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `127.0.0.1`, or `0.0.0.0` with `--lan` / `npm run host` | bind address |
| `CLIMP_DATA` | `~/.local/share/climultiplayer` | rooms, workspaces, tokens, published pages |
| `CLIMP_ROOM_IDLE_MINUTES` | `180` | delete rooms with no connections for this long |
| `CLIMP_MAX_FILE` | `2097152` | largest editable file in bytes |
| `CLIMP_OPEN_ROOMS` | unset | `1` to let anyone, not only this machine, start a room |
| `CLIMP_ORIGINS` | unset | extra comma separated hosts allowed to call the API |
| `CLIMP_TRUST_PROXY` | unset | `1` to trust forwarding headers from your tunnel, for join rate limits |
| `CLIMP_PUBLIC_URL` | unset | the public address to put in share links; `npm run tunnel` sets it |
| `CLIMP_WEB` | `web/dist` | built client directory |

## Room shell

| Variable | Default | Meaning |
|---|---|---|
| `CLIMP_SHELL` | `auto` | `docker` (contained), `host`, or `auto`, which uses docker when it is there |
| `CLIMP_ROOM_IMAGE` | `climultiplayer-room:latest` | image the room shell runs |
| `CLIMP_ROOM_IMAGE_PULL` | `ghcr.io/sjdsjadjajdjsa/climultiplayer-room:latest` | image pulled when `CLIMP_ROOM_IMAGE` is not present locally |
| `CLIMP_ROOM_MEMORY` | `1g` | memory cap per container |
| `CLIMP_ROOM_CPUS` | `1` | CPU cap per container |
| `CLIMP_ROOM_PIDS` | `512` | process cap per container |
| `CLIMP_ROOM_NETWORK` | `bridge` | `none` for an offline room, `host` if the bridge is broken |
| `CLIMP_ALLOW_HOST_NETWORK` | unset | `1` to permit `host` networking, which exposes your loopback to guests |

## Previews

| Variable | Default | Meaning |
|---|---|---|
| `CLIMP_PREVIEW_PORT` | `PORT` + 1 | port the preview gateway listens on |
| `CLIMP_PREVIEW_PORTS` | `3000,4173,5000,5173,8000,8080` | ports inside a room that may be previewed |
| `CLIMP_PREVIEW_HOURS` | `3` | how long a preview lives |
| `CLIMP_PREVIEW_URL` | unset | public address of the preview gateway; `npm run tunnel` sets it |

## Shell modes

With docker, every room gets a throwaway container and guests get a shell and
terminals of their own. Without it (or with `CLIMP_SHELL=host`) the server falls
back to a login shell as the server user, which can reach your whole home
directory, so only the host can type in it. The mode is shown at startup, on the
landing page and in the room menu.

## Room images

On first start the server uses a local `climultiplayer-room:latest` if there is
one, and otherwise pulls the published image (about 900 MB, once).

| Image | Get it with | What is in it |
|---|---|---|
| Published | pulled automatically | git, curl, an editor, a compiler, Node |
| Local build | `npm run room:image` | the same, built from `Dockerfile.room` |
| Full | `npm run room:image:full`, then `CLIMP_ROOM_IMAGE=climultiplayer-room:full` | adds Claude Code, Codex, Grok and Copilot; several gigabytes |

The container root is read-only, so `apt-get install` inside a room fails.
Global npm installs work because they are pointed at the member's home.

## Networking trouble

A VPN often blocks the docker bridge while the host still has network. Rooms
then boot fine and every install hangs.

- `npm run room:image` retries once with host networking on its own.
- To run rooms on host networking: `CLIMP_ROOM_NETWORK=host
  CLIMP_ALLOW_HOST_NETWORK=1 npm start`. Guests can then reach your machine's
  loopback, including this server's own API, so only do this with people you
  trust.
- `CLIMP_ROOM_NETWORK=none` cuts rooms off from the network entirely: no
  `npm install`, no `git fetch`.
