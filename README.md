# ports-panel

A Claude Code mod that shows the open ports on your Mac. Ports of the repo you
are working in come first, then other projects, then system processes and
tools in a collapsed group. Docker Compose services are listed under the
project they belong to.

```text
● acme-app                     this repo
  :3000  frontend   docker  LAN    copy
  :6379  redis      docker  local  copy
  :8000  backend    docker  LAN    copy

  shop_api
  :3011  node       native  local  copy

▸ System & tools (24)
```

A summary stays in the status line: `● acme-app :3000 :6379 :8000  +1 other`.

## Install

At the prompt of a terminal session:

```text
/plugin install ports-panel --marketplace korkmazMert/ports-panel
```

Answer `y` to add the marketplace, then choose a scope (user for all projects).

From a shell:

```sh
claude plugin install ports-panel --marketplace korkmazMert/ports-panel
```

In the desktop app, click + next to the prompt box, then Plugins, Add
marketplace with `korkmazMert/ports-panel`, then Add plugin.

## Use

- `/ports` shows or hides the pane.
- Press a port to open it in the browser, or `copy` to copy its address.
  Databases and queues can only be copied.
- `r` refreshes while the pane has the focus.

## What it runs

- It makes no model calls, so it does not use your usage limit.
- It only reads: `netstat`, `lsof`, `ps`, `docker ps` and `docker inspect`
  (names, ports and Compose labels, never a container's environment). It
  cannot stop a process or container, and sends nothing anywhere.
- A check is one `netstat`, every 3 s with the pane open and every 15 s
  otherwise. The rest runs when a listener changes, and once a minute.

## Limits

- macOS only. Docker is optional.
- `lsof` without sudo lists your own processes, so ports owned by root do not
  show, except those Docker publishes.
- "System & tools" is a heuristic. A wrong guess moves a port to or from the
  collapsed group; nothing is hidden.

## Development

```sh
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

## License

MIT
