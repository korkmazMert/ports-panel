# ports-panel

A Claude Code mod that shows the open ports on your computer, on macOS, Linux
and Windows. Ports of the repo you
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
To hide it, turn off **Show in status line** for ports-panel in `/config`;
`/ports` keeps working.

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

## Update

From a shell, then restart Claude Code:

```sh
claude plugin marketplace update ports-panel
claude plugin update ports-panel@ports-panel
```

## Use

- `/ports` shows or hides the pane.
- Press a port to open it in the browser, or `copy` to copy its address.
  Databases and queues can only be copied.
- `r` refreshes while the pane has the focus.

## What it runs

- It makes no model calls, so it does not use your usage limit.
- It only reads, and cannot stop a process or container. It sends nothing
  anywhere.

  | | Each check | When a listener changes |
  | --- | --- | --- |
  | macOS | `netstat` | `lsof`, `ps` |
  | Linux | `ss` | `ss`, `ps`, `/proc/<pid>/cwd` |
  | Windows | `netstat` | `netstat`, PowerShell (`Win32_Process`) |

  And on all three `docker ps` and `docker inspect`: names, ports and Compose
  labels, never a container's environment.
- A check runs every 3 s with the pane open and every 15 s otherwise. The rest
  also runs once a minute (every 5 minutes on Windows).

## Limits

- Docker is optional. Linux needs `ss` (iproute2) and `ps` (procps), which most
  distributions have, and `xdg-open` to open a port.
- Other users' processes, root's included, do not show on macOS. On Linux they
  show as `other user`, under "System & tools". Ports Docker publishes always
  show.
- Windows has no supported way to read another process's working folder, so a
  native process is matched to a project by the full paths in its command, or
  in the commands of the processes that started it. A server started with
  relative paths alone (`node server.js`) is under "System & tools". Docker
  containers are matched as everywhere else.
- "System & tools" is a heuristic. A wrong guess moves a port to or from the
  collapsed group; nothing is hidden.

## Development

```sh
claude --plugin-dir .
claude plugin validate .
claude plugin test .
node e2e/run.mjs            # real servers, real engine; no login, no model call
```

## License

MIT
