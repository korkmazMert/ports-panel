import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Port, Snapshot } from '../types'
import {
  buildSnapshot,
  CONTAINER_FORMAT,
  fingerprint,
  isTool,
  parseContainers,
  parseCwds,
  parseListeners,
  parseProcesses,
  statusText,
} from './ports'

const PANE = 'ports'
const OPEN_EVERY = 3_000
const CLOSED_EVERY = 15_000
// A listener can change hands without netstat showing it, so look at all of it at times.
const FULL_EVERY = 60_000
const TIMEOUT = 3_000

const snapshot = atom({ plugin: 'ports-panel', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const staleSince = atom({ plugin: 'ports-panel', key: 'staleSince' } as const, null)
const isToolsOpen = atom({ plugin: 'ports-panel', key: 'isToolsOpen' } as const, false)

const run = ($: EngineInterface, argv: string[]) => $.process.run(argv, { timeoutMs: TIMEOUT })

// Only a folder found in a repo is kept: one outside may become a repo later.
const roots = new Map<string, string>()

const rootOf = async ($: EngineInterface, path: string) => {
  const known = roots.get(path)
  if (known !== undefined) return known

  const copy = await $.vcs.detect({ path }).catch(() => null)
  if (copy === null) return null

  const root = copy.mainRoot ?? copy.root
  roots.set(path, root)

  return root
}

// netstat costs a few ms where lsof, ps and docker together cost over a hundred.
const listenersNow = async ($: EngineInterface) => {
  try {
    const { exitCode, stdout } = await run($, ['netstat', '-anvA', '-p', 'tcp'])

    return exitCode === 0 ? fingerprint(stdout) : null
  } catch {
    return null
  }
}

const listListeners = async ($: EngineInterface) => {
  // +c 0: whole process names. lsof exits 1 both for "none" and for an error.
  const { exitCode, stdout, stderr } = await run($, [
    'lsof', '+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn',
  ])

  if (exitCode !== 0 && stdout === '' && stderr !== '') throw new Error('lsof failed')

  return parseListeners(stdout)
}

const listCwds = async ($: EngineInterface, pids: number[]) => {
  if (pids.length === 0) return new Map<number, string>()

  // A process that ended meanwhile makes it exit 1; the others are still listed.
  const { stdout } = await run($, ['lsof', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'])

  return parseCwds(stdout)
}

const listContainers = async ($: EngineInterface) => {
  try {
    const listed = await run($, ['docker', 'ps', '-q', '--no-trunc'])
    if (listed.exitCode !== 0) return null

    const ids = listed.stdout.split('\n').filter(id => id !== '')
    if (ids.length === 0) return []

    // A container removed meanwhile makes it exit 1; the others are still printed.
    const inspected = await run($, ['docker', 'inspect', '--format', CONTAINER_FORMAT, ...ids])

    return parseContainers(inspected.stdout)
  } catch {
    return null
  }
}

const collect = async ($: EngineInterface): Promise<Snapshot> => {
  const [listeners, ps, containers, currentFolder] = await Promise.all([
    listListeners($),
    run($, ['ps', '-axww', '-o', 'pid=,ppid=,command=']),
    listContainers($),
    $.session.root(),
  ])
  const processes = parseProcesses(ps.stdout)
  const services = new Set(
    listeners.map(({ pid }) => pid).filter(pid => !isTool(pid, processes)),
  )
  const cwds = await listCwds($, [...services])
  const folders = new Set([
    ...cwds.values(),
    ...(containers ?? []).filter(({ ports }) => ports.length > 0).map(({ dir }) => dir),
  ])
  folders.delete('/')
  folders.delete('')

  const found = await Promise.all(
    [...folders].map(async folder => [folder, await rootOf($, folder)] as const),
  )

  return buildSnapshot({
    listeners,
    cwds,
    processes,
    containers,
    roots: new Map(found.filter((pair): pair is [string, string] => pair[1] !== null)),
    currentRoot: await rootOf($, currentFolder),
  })
}

let running: Promise<void> | null = null
let timer: Timer | null = null
let isInteractive = false
let isForced = false
let lastFull = 0
let lastListeners: string | null = null
let lastWritten = ''

const scan = async ($: EngineInterface) => {
  const now = await $.clock.now()

  try {
    const listeners = await listenersNow($)
    const isSame = listeners !== null && listeners === lastListeners

    if (isSame && !isForced && now - lastFull < FULL_EVERY) return

    isForced = false
    const next = await collect($)
    const written = JSON.stringify(next)

    if (written !== lastWritten) {
      await update($, snapshot, () => next)
      $.ui.status(statusText(next))
      lastWritten = written
    }
    if ((await read($, staleSince)) !== null) await update($, staleSince, () => null)
    lastListeners = listeners
    lastFull = now
  } catch (error) {
    lastListeners = null
    $.ui.log(`scan failed: ${error instanceof Error ? error.message : 'unknown'}`, { to: 'debug' })
    await update($, staleSince, since => since ?? now)
  }
}

const isPaneShown = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)

// One timer, set again after each scan: no wakeups faster than the pane needs.
const arm = async ($: EngineInterface) => {
  const isShown = await isPaneShown($).catch(() => false)
  timer?.cancel()
  timer = $.clock.after(isShown ? OPEN_EVERY : CLOSED_EVERY, () => refresh($))
}

const refresh = ($: EngineInterface): Promise<void> =>
  (running ??= scan($)
    .catch(() => {})
    .then(() => {
      running = null

      return arm($)
    }))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive

    if (isInteractive) {
      await $.command.register({
        name: PANE,
        description: "Show or hide open ports, this repo's first",
        immediate: true,
      })
      void refresh($)
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (isInteractive && e.agentId === undefined) void refresh($)

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
    } else {
      await $.ui.open({ id: PANE, title: 'Ports' })
      void refresh($)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const found = await read($, snapshot)
    const stale = await read($, staleSince)
    const areToolsOpen = await read($, isToolsOpen)
    const isWide = e.props.bodyColumns >= 42

    const refreshAll = () => {
      isForced = true

      return refresh($)
    }

    const rowOf = (groupId: string, row: Port) => {
      const id = `${groupId}:${row.port}:${row.kind}:${row.label}`
      const address = `localhost:${row.port}`
      const target = row.isWeb ? `http://${address}` : address

      const openUrl = async () => {
        const { exitCode } = await run($, ['open', target])
        if (exitCode !== 0) $.ui.toast(`Could not open ${target}`)
      }

      return (
        <Box key={`row:${id}`} gap={1}>
          <Box width={8} flexShrink={0} paddingLeft={2}>
            {row.isWeb ? (
              <Button key={`open:${id}`} label={`:${row.port}`} plain onPress={openUrl} />
            ) : (
              <Text>:{row.port}</Text>
            )}
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">{row.label}</Text>
          </Box>
          {isWide && (
            <Box width={6} flexShrink={0}>
              <Text dimColor>{row.kind}</Text>
            </Box>
          )}
          <Box width={5} flexShrink={0}>
            {row.isLan ? <Text color="warning">LAN</Text> : <Text dimColor>local</Text>}
          </Box>
          <Button
            key={`copy:${id}`}
            label="copy"
            plain
            dimColor
            onPress={async press => {
              const copied = await $.ui.copy({ text: target, surface: press.surface })
              $.ui.toast(copied.isCopied ? `Copied ${target}` : `Could not copy ${target}`)
            }}
          />
        </Box>
      )
    }

    if (found === null) {
      return <Text dimColor>{stale === null ? 'Looking for open ports…' : 'Could not read open ports.'}</Text>
    }

    const age = stale === null ? 0 : Math.round(((await $.clock.now()) - stale) / 1000)

    return (
      <Box flexDirection="column" gap={1}>
        {found.groups.length === 0 && <Text dimColor>No project has an open port.</Text>}
        {found.groups.map(group => (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text weight="bold" color={group.isCurrent ? 'success' : undefined} wrap="truncate-end">
                {group.isCurrent ? '● ' : '  '}
                {group.name}
              </Text>
              {group.isCurrent && <Text dimColor>this repo</Text>}
            </Box>
            {group.ports.map(row => rowOf(group.id, row))}
          </Box>
        ))}
        <Box flexDirection="column">
          <Box>
            <Button
              key="tools"
              label={`${areToolsOpen ? '▾' : '▸'} System & tools (${found.tools.length})`}
              plain
              dimColor
              onPress={() => update($, isToolsOpen, value => !value)}
            />
          </Box>
          {areToolsOpen && found.tools.map(row => rowOf('tools', row))}
        </Box>
        <Box flexDirection="column">
          {!found.isDockerUp && <Text color="warning">Docker unavailable: containers not shown</Text>}
          {stale !== null && <Text color="warning">Stale: updates failing for {age}s</Text>}
          <Box>
            <Button key="refresh" label="Refresh" hotkey="r" plain onPress={refreshAll} />
          </Box>
        </Box>
      </Box>
    )
  })
}
