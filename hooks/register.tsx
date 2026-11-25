import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Port } from '../types'
import { collect, listenersNow, run } from './collect'
import { platformOf } from './platforms'
import { statusText } from './ports'

const PANE = 'ports'
const OPEN_EVERY = 3_000
const CLOSED_EVERY = 15_000

const snapshot = atom({ plugin: 'ports-panel', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const staleSince = atom({ plugin: 'ports-panel', key: 'staleSince' } as const, null)
const isToolsOpen = atom({ plugin: 'ports-panel', key: 'isToolsOpen' } as const, false)

let running: Promise<void> | null = null
let timer: Timer | null = null
let isInteractive = false
let isForced = false
let lastFull = 0
let lastListeners: string | null = null
let lastWritten = ''
let isStatusShown = true

const scan = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const platform = platformOf((await $.session.machine()).sysname)
  if (platform === null) return

  try {
    const listeners = await listenersNow($, platform)
    const isSame = listeners !== null && listeners === lastListeners

    if (isSame && !isForced && now - lastFull < platform.fullEveryMs) return

    isForced = false
    const next = await collect($, platform)
    const written = JSON.stringify(next)

    if (written !== lastWritten) {
      await update($, snapshot, () => next)
      if (isStatusShown) $.ui.status(statusText(next))
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

export const register: Register = (on, options) => {
  isStatusShown = options.showStatusLine !== false

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive

    if (isInteractive) {
      if (!isStatusShown) $.ui.status(undefined)
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
    const { sysname } = await $.session.machine()
    const platform = platformOf(sysname)
    const isWide = e.props.bodyColumns >= 42

    if (platform === null) return <Text dimColor>{sysname} is not supported.</Text>

    const refreshAll = () => {
      isForced = true

      return refresh($)
    }

    const rowOf = (groupId: string, row: Port) => {
      const id = `${groupId}:${row.port}:${row.kind}:${row.label}`
      const address = `localhost:${row.port}`
      const target = row.isWeb ? `http://${address}` : address

      const openUrl = async () => {
        const isOpened = await run($, platform, platform.open(target)).then(
          ({ exitCode }) => exitCode === 0,
          () => false,
        )
        if (!isOpened) $.ui.toast(`Could not open ${target}`)
      }

      return (
        <Box key={`row:${id}`} gap={1}>
          <Box width={8} flexShrink={0} paddingLeft={2}>
            {row.isWeb ? (
              <Button key={`open:${id}`} plain onPress={openUrl}>
                <Text color="text">:{row.port}</Text>
              </Button>
            ) : (
              <Text color="text">:{row.port}</Text>
            )}
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="text" wrap="truncate-end">{row.label}</Text>
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
            plain
            onPress={async press => {
              const copied = await $.ui.copy({ text: target, surface: press.surface })
              $.ui.toast(copied.isCopied ? `Copied ${target}` : `Could not copy ${target}`)
            }}
          >
            <Text dimColor>copy</Text>
          </Button>
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
              <Text weight="bold" color={group.isCurrent ? 'success' : 'text'} wrap="truncate-end">
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
            <Button key="tools" plain onPress={() => update($, isToolsOpen, value => !value)}>
              <Text dimColor>
                {areToolsOpen ? '▾' : '▸'} System & tools ({found.tools.length})
              </Text>
            </Button>
          </Box>
          {areToolsOpen && found.tools.map(row => rowOf('tools', row))}
        </Box>
        <Box flexDirection="column">
          {!found.isDockerUp && <Text color="warning">Docker unavailable: containers not shown</Text>}
          {stale !== null && <Text color="warning">Stale: updates failing for {age}s</Text>}
          <Box>
            <Button key="refresh" hotkey="r" plain onPress={refreshAll}>
              <Text color="text">Refresh</Text>
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
