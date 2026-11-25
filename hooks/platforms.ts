import type { Listener, Process } from './ports'

export type Platform = {
  /** Cheap: run at each check, reduced by `fingerprint` to what identifies the listeners. */
  check: string[]
  fingerprint: (text: string) => string | null
  listeners: string[]
  parseListeners: (text: string) => Listener[]
  processes: string[]
  parseProcesses: (text: string) => Map<number, Process>
  /** Where a process's folder is found: lsof, /proc, or the paths in its command. */
  folders: 'lsof' | 'proc' | 'commands'
  open: (url: string) => string[]
  /** The same for every spelling of one repo's path. */
  keyOf: (root: string) => string
  timeoutMs: number
  /** How often to look at everything, whatever `check` says. */
  fullEveryMs: number
}

const lines = (text: string) => text.split('\n').filter(line => line.trim() !== '')

const cellsOf = (line: string) => line.trim().split(/\s+/)

const joined = (rows: string[]) => (rows.length === 0 ? null : rows.sort().join('\n'))

export const isLoopback = (host: string) => {
  const bare = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '')

  return bare === 'localhost' || bare === '::1' || /^(::ffff:)?127\./.test(bare)
}

const addressOf = (address: string) => {
  const colon = address.lastIndexOf(':')

  return { port: Number(address.slice(colon + 1)), isLan: !isLoopback(address.slice(0, colon)) }
}

/** One row per process and port: IPv4 and IPv6 of a listener are the same port. */
const merged = (listeners: Listener[]) => {
  const found = new Map<string, Listener>()

  for (const one of listeners) {
    const key = `${one.pid}:${one.port}`
    found.set(key, { ...one, isLan: one.isLan || found.get(key)?.isLan === true })
  }

  return [...found.values()]
}

const unescapeLsof = (text: string) =>
  text.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

/** `lsof -F pn` of working folders, by pid. */
export const parseCwds = (text: string): Map<number, string> => {
  const cwds = new Map<number, string>()
  let pid = 0

  for (const line of lines(text)) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    if (line[0] === 'n') cwds.set(pid, line.slice(1))
  }

  return cwds
}

const parsePs = (text: string): Map<number, Process> => {
  const processes = new Map<number, Process>()

  for (const line of lines(text)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) {
      processes.set(Number(match[1]), { ppid: Number(match[2]), name: '', command: match[3] ?? '' })
    }
  }

  return processes
}

const PS = ['ps', '-axww', '-o', 'pid=,ppid=,command=']

export const DARWIN: Platform = {
  check: ['netstat', '-anvA', '-p', 'tcp'],
  // Socket, address and pid.
  fingerprint: text =>
    joined(
      lines(text).flatMap(line => {
        const cells = cellsOf(line)
        const state = cells.indexOf('LISTEN')

        return state === -1 ? [] : [`${cells[0]} ${cells[state - 2]} ${cells[state + 5]}`]
      }),
    ),
  // +c 0: whole process names.
  listeners: ['lsof', '+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
  parseListeners: text => {
    const listeners: Listener[] = []
    let pid = 0
    let name = ''

    for (const line of lines(text)) {
      const value = line.slice(1)

      if (line[0] === 'p') pid = Number(value)
      if (line[0] === 'c') name = unescapeLsof(value)
      if (line[0] === 'n') listeners.push({ pid, name, ...addressOf(value) })
    }

    return merged(listeners)
  },
  processes: PS,
  parseProcesses: parsePs,
  folders: 'lsof',
  open: url => ['open', url],
  keyOf: root => root,
  timeoutMs: 3_000,
  fullEveryMs: 60_000,
}

/** The local address of a row of `ss`: the cell before the peer, which ends in `:*`. */
const localOf = (cells: string[]) => cells[cells.findIndex(cell => cell.endsWith(':*')) - 1]

export const LINUX: Platform = {
  // Without -p, which reads the open files of every process.
  check: ['ss', '-Hltne'],
  // Address, socket inode and cookie.
  fingerprint: text =>
    joined(
      lines(text).flatMap(line => {
        const cells = cellsOf(line)
        const local = localOf(cells)
        const ids = cells.filter(cell => /^(ino|sk):/.test(cell))

        return local === undefined ? [] : [[local, ...ids].join(' ')]
      }),
    ),
  listeners: ['ss', '-Hltnp'],
  parseListeners: text =>
    merged(
      lines(text).flatMap((line): Listener[] => {
        const local = localOf(cellsOf(line))
        if (local === undefined) return []

        const address = addressOf(local)
        const users = [...line.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)]
        // Without root, ss names only the person's own processes.
        if (users.length === 0) return [{ pid: null, name: '', ...address }]

        return users.map(([, name = '', pid]) => ({ pid: Number(pid), name, ...address }))
      }),
    ),
  processes: PS,
  parseProcesses: parsePs,
  folders: 'proc',
  open: url => ['xdg-open', url],
  keyOf: root => root,
  timeoutMs: 3_000,
  fullEveryMs: 60_000,
}

type WindowsProcess = {
  ProcessId: number
  ParentProcessId: number
  Name: string | null
  ExecutablePath: string | null
  CommandLine: string | null
  CreationDate: string | null
}

const createdAt = ({ CreationDate }: WindowsProcess) => Number(/\d+/.exec(CreationDate ?? '')?.[0] ?? 0)

/** The TCP rows with nothing at the other end; the state's word is translated, the 0 is not. */
const windowsRows = (text: string) =>
  lines(text).flatMap(line => {
    const cells = cellsOf(line)
    const [protocol, local, foreign] = cells

    return protocol === 'TCP' && local !== undefined && foreign?.endsWith(':0')
      ? [{ local, pid: Number(cells.at(-1)) }]
      : []
  })

const FIELDS = 'ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate'

export const WINDOWS: Platform = {
  check: ['netstat', '-ano'],
  fingerprint: text => joined(windowsRows(text).map(({ local, pid }) => `${local} ${pid}`)),
  listeners: ['netstat', '-ano'],
  parseListeners: text =>
    merged(windowsRows(text).map(({ local, pid }) => ({ pid, name: '', ...addressOf(local) }))),
  // Windows PowerShell comes with Windows; wmic no longer does.
  processes: [
    'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
      `Get-CimInstance Win32_Process -Property ${FIELDS} | ` +
      `Select-Object ${FIELDS} | ConvertTo-Json -Compress`,
  ],
  parseProcesses: text => {
    const rows = [JSON.parse(text.replace(/^\uFEFF/, ''))].flat() as WindowsProcess[]
    const born = new Map(rows.map(row => [row.ProcessId, createdAt(row)]))

    return new Map(
      rows.map(row => {
        // Windows gives a dead parent's id to a new process.
        const isParent = (born.get(row.ParentProcessId) ?? 0) <= createdAt(row)

        return [
          row.ProcessId,
          {
            ppid: isParent ? row.ParentProcessId : 0,
            name: (row.Name ?? '').replace(/\.exe$/i, ''),
            command: row.CommandLine ?? row.ExecutablePath ?? '',
          },
        ]
      }),
    )
  },
  folders: 'commands',
  open: url => ['rundll32', 'url.dll,FileProtocolHandler', url],
  keyOf: root => root.replaceAll('\\', '/').toLowerCase(),
  // PowerShell takes about a second to start: give it time, and run it seldom.
  timeoutMs: 15_000,
  fullEveryMs: 300_000,
}

const NO_PROJECT = /^[a-z]:[\\/](windows|program files( \(x86\))?|programdata)[\\/]|[\\/](\.pyenv|\.nvm|\.volta|scoop)[\\/]/i
const PATH = /"([a-z]:[\\/][^"]+)"|(?:^|[\s=,;])([a-z]:[\\/][^\s"'<>|?*]+)/gi

/**
 * The folders of the absolute paths in a Windows command line, the program's own
 * last. Windows has no supported way to read another process's working folder.
 */
export const pathsIn = (command: string): string[] => {
  const found = [...command.matchAll(PATH)].map(match => ({
    path: match[1] ?? match[2] ?? '',
    isProgram: match.index === 0,
  }))
  const ordered = [...found.filter(one => !one.isProgram), ...found.filter(one => one.isProgram)]

  return ordered
    .map(({ path }) => path)
    .filter(path => !NO_PROJECT.test(path))
    .map(path => path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))))
    // A drive alone, as an unquoted path with a space leaves.
    .filter(folder => folder.length > 2)
}

const PLATFORMS: Record<string, Platform> = { Darwin: DARWIN, Linux: LINUX, Windows_NT: WINDOWS }

export const platformOf = (sysname: string): Platform | null => PLATFORMS[sysname] ?? null
