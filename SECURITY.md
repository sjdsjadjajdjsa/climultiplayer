# Security

climultiplayer gives other people a shell on your machine, so the boundary is
worth stating plainly.

## What a room can reach

- The workspace is a **copy** of the folder the host picked, in
  `$CLIMP_DATA/rooms/<code>/workspace`. Guests write to the copy. The host's
  original folder is never touched.
- The shared shell runs in a container per room, as the server's uid: the
  workspace and the room's home volume are the only mounts. The host home
  directory, the data directory and the docker socket stay outside.
- That container is `--read-only` with a small tmpfs `/tmp`, all capabilities
  dropped, `no-new-privileges`, and memory, CPU and PID caps.

Without docker (or with `CLIMP_SHELL=host`) the shell falls back to a login shell
as the server user. That mode can reach your whole home directory, and the
startup banner says so.

## What the gates are, and are not

- Risky commands typed into the shared shell are matched with a regular
  expression list (`server/src/risk.ts`) and held for the host or a trusted
  editor. It recognises deletes, moves, installs, redirects, nested shells,
  inline code, script files and similar. It is a heuristic: a clever command can
  be missed, and editing files is never gated at all.
- Personal terminals are raw TTYs, started by the member who opens them, and are
  never command-gated.
- Approvals expire after 90 seconds and land in the host-only command log.

## Boundaries worth knowing

- A guest with an approved command can do anything inside the container. The
  workspace copy is theirs to break; the host copy is not.
- Rooms share the docker daemon. A container escape is a daemon-level problem,
  not a per-room one, and `docker` inside a room means the daemon on the host.
- `CLIMP_ROOM_NETWORK=bridge` (default) gives rooms outbound network. Busybox
  metadata services and your LAN are reachable from inside; use
  `CLIMP_ROOM_NETWORK=none` for a sealed room.
- Invite tokens are single use, expiring, revocable and stored hashed. Joining
  still needs the host to allow the request.

## Reporting

Open an issue with the version, the mode in the startup banner, and the smallest
reproduction you have. For anything you would rather not post publicly, use
GitHub's private vulnerability reporting on this repository.
