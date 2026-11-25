import type { Group, Port, Snapshot } from '../types'
import { isLoopback, pathsIn } from './platforms'

/** `pid` is null where the system does not tell whose it is. */
export type Listener = { pid: number | null; name: string; port: number; isLan: boolean }
export type Process = { ppid: number; name: string; command: string }
export type Container = {
  name: string
  service: string
  project: string
  dir: string
  ports: { port: number; containerPort: number; isLan: boolean }[]
}

type Facts = {
  listeners: Listener[]
  /** The folders a process may belong to, the likeliest first. */
  folders: Map<number, string[]>
  processes: Map<number, Process>
  /** null: Docker could not be asked. */
  containers: Container[] | null
  /** Folder to the root of the repo it is in; a folder in none is absent. */
  roots: Map<string, string>
  currentRoot: string | null
}

// Services that log protocol errors when a browser opens them.
const NON_WEB = new Set([
  1025, 1433, 1521, 2181, 3306, 5432, 5672, 6379, 9042, 9092, 11211, 27017,
])

// Tested on commands with forward slashes.
const CLAUDE = /^("[^"]*\/claude(\.exe)?"|(\S*\/)?claude(\.exe)?)(\s|$)|@anthropic-ai\/claude-code/
const DOCKER_PROXY = /com\.docker\.|OrbStack|limactl|\/\.lima\/|vpnkit|gvproxy|wslrelay|docker-proxy|rootlesskit|slirp4netns|(^|\/)pasta(\s|$)/
const SYSTEM = /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/usr\/lib\/systemd\/|\/usr\/share\/|\/Library\/Apple\/|\/Applications\/(?!Xcode\.app\/Contents\/Developer\/))/
// ponytail: a list of names, so a new tool shows as a service until it is added
// here; a wrong match only moves a row into the collapsed group.
const TOOLING = [
  /serena/,
  /codebase-memory/,
  /maestro\.cli/,
  /Android\/sdk\/(emulator|platform-tools)\//i,
  /Library\/Developer\/CoreSimulator\//,
  /^(\S*\/)?(adb|netsimd)(\.exe)?\s/,
  /\bdart(\.exe)? "?(tooling-daemon|devtools|language-server)\b/,
  /\.vscode(-server)?\/(extensions|cli|bin)\//,
  /^\S*\/(snap|opt)\/(code|codium|cursor|windsurf)\//i,
  /^\S*JetBrains/,
  /GradleDaemon/,
]

const lines = (text: string) => text.split('\n').filter(line => line !== '')

export const CONTAINER_FORMAT =
  '{"name":{{json .Name}},"ports":{{json .NetworkSettings.Ports}}' +
  ',"service":{{json (index .Config.Labels "com.docker.compose.service")}}' +
  ',"project":{{json (index .Config.Labels "com.docker.compose.project")}}' +
  ',"dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}'

type RawContainer = Omit<Container, 'ports'> & {
  ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null
}

/** `docker inspect` under CONTAINER_FORMAT: one JSON object a line. */
export const parseContainers = (text: string): Container[] =>
  lines(text).map(line => {
    const raw = JSON.parse(line) as RawContainer
    const ports = new Map<number, Container['ports'][number]>()

    for (const [key, bindings] of Object.entries(raw.ports ?? {})) {
      if (!key.endsWith('/tcp')) continue

      for (const { HostIp, HostPort } of bindings ?? []) {
        const port = Number(HostPort)
        const isLan = !isLoopback(HostIp) || ports.get(port)?.isLan === true
        ports.set(port, { port, containerPort: parseInt(key, 10), isLan })
      }
    }

    return { ...raw, name: raw.name.replace(/^\//, ''), ports: [...ports.values()] }
  })

const commandOf = (pid: number | null, processes: Map<number, Process>) =>
  (pid === null ? '' : (processes.get(pid)?.command ?? '')).replaceAll('\\', '/')

export const isTool = (pid: number | null, processes: Map<number, Process>) => {
  const command = commandOf(pid, processes)
  // Claude starts MCP servers itself, and a dev server through a shell.
  const parent = pid === null ? null : (processes.get(pid)?.ppid ?? null)
  const isMcpServer = CLAUDE.test(commandOf(parent, processes))

  return isMcpServer || [CLAUDE, DOCKER_PROXY, SYSTEM, ...TOOLING].some(one => one.test(command))
}

const ANCESTORS = 3

/** Where the system does not tell folders: the paths in the commands of a process and its parents. */
export const foldersFromCommands = (pids: number[], processes: Map<number, Process>) =>
  new Map(
    pids.map(pid => {
      const folders: string[] = []
      let at = pid

      for (let depth = 0; depth <= ANCESTORS; depth += 1) {
        const process = processes.get(at)
        if (process === undefined || CLAUDE.test(commandOf(at, processes))) break

        folders.push(...pathsIn(process.command))
        at = process.ppid
      }

      return [pid, [...new Set(folders)]]
    }),
  )

/** The repo of the first folder that is in one. */
export const rootOfFolders = (folders: string[], roots: Map<string, string>) =>
  folders.map(folder => roots.get(folder)).find(root => root !== undefined)

const byPort = (a: Port, b: Port) =>
  a.port - b.port || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)

// Workers of one server share its socket: one row.
const push = (rows: Port[], row: Port) => {
  const same = rows.find(
    one => one.port === row.port && one.kind === row.kind && one.label === row.label,
  )

  if (same === undefined) rows.push(row)
  else same.isLan ||= row.isLan
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

export const buildSnapshot = (facts: Facts): Snapshot => {
  const groups = new Map<string, Group>()
  const tools: Port[] = []

  const add = (id: string, name: string, isCurrent: boolean, port: Port) => {
    const group = groups.get(id) ?? { id, name, isCurrent, ports: [] }
    push(group.ports, port)
    groups.set(id, group)
  }
  const addToRepo = (root: string, port: Port) =>
    add(`repo:${root}`, baseName(root), root === facts.currentRoot, port)

  const published = new Set<number>()

  for (const { name, service, project, dir, ports } of facts.containers ?? []) {
    const root = facts.roots.get(dir)

    for (const { port, containerPort, isLan } of ports) {
      published.add(port)
      const row: Port = {
        port,
        label: service || name,
        kind: 'docker',
        isLan,
        isWeb: !NON_WEB.has(containerPort),
      }

      if (root !== undefined) addToRepo(root, row)
      else if (project) add(`compose:${project}`, project, false, row)
      else add(`container:${name}`, name, false, row)
    }
  }

  for (const { pid, name, port, isLan } of facts.listeners) {
    const process = pid === null ? undefined : facts.processes.get(pid)
    const isProxy = pid === null || DOCKER_PROXY.test(process?.command ?? name)

    if (published.has(port) && isProxy) continue

    const label = pid === null ? 'other user' : name || process?.name || `pid ${pid}`
    const row: Port = { port, label, kind: 'native', isLan, isWeb: !NON_WEB.has(port) }
    const root = rootOfFolders(pid === null ? [] : (facts.folders.get(pid) ?? []), facts.roots)

    if (root === undefined || isTool(pid, facts.processes)) push(tools, row)
    else addToRepo(root, row)
  }

  const sorted = [...groups.values()].sort(
    (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name),
  )
  for (const group of sorted) group.ports.sort(byPort)

  return { groups: sorted, tools: tools.sort(byPort), isDockerUp: facts.containers !== null }
}

const SHOWN = 5

export const statusText = ({ groups }: Snapshot): string | undefined => {
  const current = groups.find(group => group.isCurrent)
  const others = groups
    .filter(group => !group.isCurrent)
    .reduce((total, group) => total + group.ports.length, 0)
  const tail = others === 0 ? '' : `  +${others} other${others === 1 ? '' : 's'}`

  if (current === undefined) return others === 0 ? undefined : `○ no ports here${tail}`

  const ports = [...new Set(current.ports.map(({ port }) => port))]
  const shown = ports.slice(0, SHOWN).map(port => `:${port}`).join(' ')
  const more = ports.length > SHOWN ? ` +${ports.length - SHOWN}` : ''

  return `● ${current.name} ${shown}${more}${tail}`
}
