import type { Group, Port, Snapshot } from '../types'

export type Listener = { pid: number; name: string; port: number; isLan: boolean }
export type Process = { ppid: number; command: string }
export type Container = {
  name: string
  service: string
  project: string
  dir: string
  ports: { port: number; containerPort: number; isLan: boolean }[]
}

type Facts = {
  listeners: Listener[]
  cwds: Map<number, string>
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

const CLAUDE = /^(\S*\/)?claude(\.exe)?(\s|$)|@anthropic-ai\/claude-code/
const DOCKER_PROXY = /com\.docker\.|OrbStack|limactl|\/\.lima\/|vpnkit|gvproxy/
const SYSTEM = /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/Library\/Apple\/|\/Applications\/(?!Xcode\.app\/Contents\/Developer\/))/
// ponytail: a list of names, so a new tool shows as a service until it is added
// here; a wrong match only moves a row into the collapsed group.
const TOOLING = [
  /serena/,
  /codebase-memory/,
  /maestro\.cli/,
  /Library\/Android\/sdk\/(emulator|platform-tools)\//,
  /Library\/Developer\/CoreSimulator\//,
  /^(\S*\/)?(adb|netsimd)\s/,
  /\bdart (tooling-daemon|devtools|language-server)\b/,
  /\.vscode\/extensions\//,
  /GradleDaemon/,
]

const isLoopback = (host: string) =>
  host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.')

const unescape = (text: string) =>
  text.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

const lines = (text: string) => text.split('\n').filter(line => line !== '')

/**
 * `netstat -anvA -p tcp` (macOS) reduced to what identifies its listeners: socket,
 * address and pid. Null where there is none to compare.
 */
export const fingerprint = (text: string): string | null => {
  const rows = lines(text).flatMap(line => {
    const cells = line.trim().split(/\s+/)
    const state = cells.indexOf('LISTEN')

    return state === -1 ? [] : [`${cells[0]} ${cells[state - 2]} ${cells[state + 5]}`]
  })

  return rows.length === 0 ? null : rows.sort().join('\n')
}

/** `lsof -F pcn` of listening sockets; one row per process and port. */
export const parseListeners = (text: string): Listener[] => {
  const found = new Map<string, Listener>()
  let pid = 0
  let name = ''

  for (const line of lines(text)) {
    const value = line.slice(1)

    if (line[0] === 'p') pid = Number(value)
    if (line[0] === 'c') name = unescape(value)
    if (line[0] !== 'n') continue

    const colon = value.lastIndexOf(':')
    const port = Number(value.slice(colon + 1))
    const isLan = !isLoopback(value.slice(0, colon))
    const key = `${pid}:${port}`
    found.set(key, { pid, name, port, isLan: isLan || found.get(key)?.isLan === true })
  }

  return [...found.values()]
}

/** `lsof -d cwd -F pn`: each process's working folder. */
export const parseCwds = (text: string): Map<number, string> => {
  const cwds = new Map<number, string>()
  let pid = 0

  for (const line of lines(text)) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    if (line[0] === 'n') cwds.set(pid, line.slice(1))
  }

  return cwds
}

/** `ps -o pid=,ppid=,command=`. */
export const parseProcesses = (text: string): Map<number, Process> => {
  const processes = new Map<number, Process>()

  for (const line of lines(text)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] ?? '' })
  }

  return processes
}

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

export const isTool = (pid: number, processes: Map<number, Process>) => {
  const { command, ppid } = processes.get(pid) ?? { command: '', ppid: 0 }
  // Claude starts MCP servers itself, and a dev server through a shell.
  const isMcpServer = CLAUDE.test(processes.get(ppid)?.command ?? '')

  return isMcpServer || [CLAUDE, SYSTEM, ...TOOLING].some(one => one.test(command))
}

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

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

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
    const command = facts.processes.get(pid)?.command ?? name

    if (published.has(port) && DOCKER_PROXY.test(command)) continue

    const row: Port = { port, label: name, kind: 'native', isLan, isWeb: !NON_WEB.has(port) }
    const root = facts.roots.get(facts.cwds.get(pid) ?? '')

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
