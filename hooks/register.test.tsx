import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ACME = '/code/acme-app'
const SHOP = '/code/shop_api'

const PANE = {
  plugin: 'ports-panel',
  component: 'Pane',
  requestId: 'ports',
  props: {
    title: 'Ports',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// On a Windows host the engine hands paths on as its own: D:\\code\\acme-app.
const posix = (path: string) => path.replace(/^[A-Z]:/i, '').replaceAll('\\', '/')

const container = (service: string, port: number) =>
  JSON.stringify({
    name: `/acme-${service}-1`,
    service,
    project: 'acme_app',
    dir: ACME,
    ports: { [`${port}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: String(port) }] },
  })

type Options = { isDockerDown?: boolean; isDockerMissing?: boolean; sysname?: string; isOpenMissing?: boolean }

// Stands for the machine and the engine beneath the mod.
const world = (on: On, options: Options = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = {
    runs: [] as string[],
    status: undefined as string | undefined,
    opened: [] as string[],
    copied: [] as string[],
    toasts: [] as string[],
    isPaneOpen: false,
    isLsofBroken: false,
    isNetstatBroken: false,
    detected: [] as string[],
    // Rows as macOS prints them: one established connection, two listeners.
    netstat: [
      'a1 f1 tcp4 0 0 10.0.0.2.63 203.0.113.4.443 ESTABLISHED 97 13 131072 131072 12 0 00102',
      'b1 0 tcp4 0 0 127.0.0.1.3011 *.* LISTEN 0 0 131072 131072 10 0 00100',
      ' c1 0 tcp46 0 0 *.5000 *.* LISTEN 0 0 131072 131072 11 0 00100',
    ],
    hold: null as Promise<void> | null,
    inFlight: 0,
    maxInFlight: 0,
    modelCalls: 0,
  }
  const ok = (stdout: string, exitCode = 0, stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('process.run', async (_, e) => {
    const line = e.argv.join(' ')
    seen.runs.push(line)
    if (['open', 'xdg-open', 'rundll32'].includes(e.argv[0] ?? '')) {
      if (options.isOpenMissing) return { deny: 'failed to start: ENOENT: not found' }
      seen.opened.push(e.argv.at(-1) ?? '')
      return ok('')
    }
    if (e.argv[0] === 'netstat') {
      return seen.isNetstatBroken ? ok('', 1, 'netstat: broken') : ok(seen.netstat.join('\n'))
    }
    if (e.argv[0] === 'ss') {
      return ok('LISTEN 0 511 127.0.0.1:3011 0.0.0.0:* users:(("node",pid=10,fd=3)) ino:1 sk:1\n')
    }
    if (line.includes('LISTEN')) {
      seen.inFlight += 1
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
      if (seen.hold) await seen.hold
      seen.inFlight -= 1
      return seen.isLsofBroken
        ? ok('', 1, 'lsof: broken')
        : ok('p10\ncnode\nf1\nn127.0.0.1:3011\np11\ncControlCenter\nf1\nn*:5000')
    }
    if (line.includes('-d cwd')) {
      const asked = (e.argv[e.argv.indexOf('-p') + 1] ?? '').split(',')
      const folders: Record<string, string> = { 10: SHOP, 11: '/code/tool-home' }
      return ok(asked.map(pid => `p${pid}\nfcwd\nn${folders[pid]}`).join('\n'))
    }
    if (e.argv[0] === 'ps') return ok('10 9 node server.js\n11 1 /System/Library/ControlCenter')
    if (e.argv[0] === 'docker' && options.isDockerMissing) {
      return { deny: 'failed to start: ENOENT: not found' }
    }
    if (options.isDockerDown) return ok('', 1, 'Cannot connect to the Docker daemon')
    if (line.startsWith('docker ps')) return ok('aaa\nbbb\n')
    return ok([container('backend', 8000), container('redis', 6379)].join('\n'))
  })
  on('vcs.detect', (_, e) => {
    const path = posix(e.path)
    seen.detected.push(path)
    return path === ACME || path === SHOP
      ? { vcs: 'git', root: path, mainRoot: path, revision: null, branch: null, defaultBranch: null, remote: null }
      : null
  })
  on('session.machine', () => ({
    value: { sysname: options.sysname ?? 'Darwin', release: '', machine: '', packageManagers: [], runtimes: [] },
  }))
  on('session.root', () => ({ value: ACME }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', () => ({ value: { command: 'ports' } }))
  on('ui.status', (_, e) => {
    seen.status = e.text
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({
    value: seen.isPaneOpen
      ? [{ id: 'ports', title: 'Ports', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('ui.open', () => {
    seen.isPaneOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    seen.isPaneOpen = false
    return { value: undefined } as never
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('model.complete', () => {
    seen.modelCalls += 1
    return { deny: 'no model calls' } as never
  })

  return { clock, seen }
}

const start = { cwd: ACME, surface: 'terminal', isInteractive: true } as const
const scans = (runs: string[]) => runs.filter(line => line.includes('LISTEN')).length
const checks = (runs: string[]) => runs.filter(line => line.startsWith('netstat')).length
const rebind = (row: string) => row.replace('b1 ', 'b2 ')
const ports = { command: 'ports', args: '' } as never

test('status line shows this repo first, and no model is called', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  expect(seen.status).toBe('● acme-app :6379 :8000  +1 other')
  expect(seen.modelCalls).toBe(0)
})

test('a non-interactive session scans nothing', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ ...start, isInteractive: false })
  await clock.advance(60_000)
  expect(seen.runs).toEqual([])
})

test('closed pane checks every 15 s, open pane every 3 s', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  expect(checks(seen.runs)).toBe(1)
  await clock.advance(14_000)
  expect(checks(seen.runs)).toBe(1)
  await clock.advance(1_000)
  expect(checks(seen.runs)).toBe(2)
  await $.command.run(ports)
  await clock.settle()
  expect(checks(seen.runs)).toBe(3)
  await clock.advance(9_000)
  expect(checks(seen.runs)).toBe(6)
  await $.command.run(ports)
  await clock.advance(3_000)
  const closed = checks(seen.runs)
  await clock.advance(12_000)
  expect(checks(seen.runs) - closed <= 1).toBe(true)
})

test('while no listener changes, a check runs netstat alone', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  const before = seen.runs.length
  await clock.advance(45_000)
  const after = seen.runs.slice(before)
  expect([after.length, checks(after)]).toEqual([3, 3])
})

test('connections and traffic are not a change of listeners', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  seen.netstat = [
    'zz 0 tcp4 0 0 10.0.0.1.1 2.2.2.2.443 ESTABLISHED 1 1 1 1 5 0 0',
    ...seen.netstat.slice(1).map(row => row.replace('tcp4 0 0', 'tcp4 7 0').replace('LISTEN 0 0', 'LISTEN 9 9')),
  ]
  await clock.advance(15_000)
  expect(scans(seen.runs)).toBe(1)
})

for (const [name, change] of [
  ['a new listener', (rows: string[]) => [...rows, 'd1 0 tcp4 0 0 *.9 *.* LISTEN 0 0 1 1 12 0 0']],
  ['a listener gone', (rows: string[]) => rows.slice(0, -1)],
  ['the same port bound again', (rows: string[]) => rows.map(rebind)],
  ['the same socket under another process', (rows: string[]) => rows.map(row => row.replace('131072 10 0', '131072 99 0'))],
] as const) {
  test(`${name} is scanned at the next check`, async ($, on) => {
    const { clock, seen } = world(on)
    await $.session.start(start)
    await clock.settle()
    seen.netstat = change(seen.netstat)
    await clock.advance(15_000)
    expect(scans(seen.runs)).toBe(2)
  })
}

test('a full scan runs once a minute whatever netstat says', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  await clock.advance(45_000)
  expect(scans(seen.runs)).toBe(1)
  await clock.advance(15_000)
  expect(scans(seen.runs)).toBe(2)
})

test('without netstat every check is a full scan', async ($, on) => {
  const { clock, seen } = world(on)
  seen.isNetstatBroken = true
  await $.session.start(start)
  await clock.settle()
  await clock.advance(30_000)
  expect(scans(seen.runs)).toBe(3)
})

test('netstat output with no listener in it is not trusted', async ($, on) => {
  const { clock, seen } = world(on)
  seen.netstat = ['Active Internet connections', 'a format this mod does not know']
  await $.session.start(start)
  await clock.settle()
  await clock.advance(30_000)
  expect(scans(seen.runs)).toBe(3)
})

test('a failed Refresh is retried at the next check, with no listener changed', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  seen.isLsofBroken = true
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBeDefined()
  seen.isLsofBroken = false
  await clock.advance(15_000)
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBe(undefined)
  await ui.unmount()
})

test('many turns leave one timer, not one each', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  for (let turn = 0; turn < 4; turn += 1) {
    await clock.advance(1_000)
    await $.turn.complete({ reason: 'answer', text: '' } as never)
    await clock.settle()
  }
  const before = checks(seen.runs)
  await clock.advance(15_000)
  expect(checks(seen.runs) - before).toBe(1)
})

test('Refresh is a full scan', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(scans(seen.runs)).toBe(2)
  await ui.unmount()
})

test("the main turn's end checks, a subagent's does not", async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  await $.turn.complete({ reason: 'answer', text: '', agentId: 'a1' } as never)
  await clock.settle()
  expect(checks(seen.runs)).toBe(1)
  await $.turn.complete({ reason: 'answer', text: '' } as never)
  await clock.settle()
  expect(checks(seen.runs)).toBe(2)
})

test('a repo is looked up once, a tool folder never', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  await clock.advance(120_000)
  expect([...seen.detected].sort()).toEqual([ACME, SHOP])
})

test('scans never overlap', async ($, on) => {
  const { clock, seen } = world(on)
  let release = () => {}
  seen.hold = new Promise<void>(resolve => {
    release = resolve
  })
  await $.session.start(start)
  await clock.settle()
  await $.command.run(ports)
  await $.turn.complete({ reason: 'answer', text: '' } as never)
  await clock.advance(9_000)
  release()
  seen.hold = null
  await clock.settle()
  expect(seen.maxInFlight).toBe(1)
})

test('/ports opens, again closes, and leaves no text for the model', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  const opened = await $.command.run(ports)
  expect(seen.isPaneOpen).toBe(true)
  expect([opened.text, opened.context]).toEqual([undefined, undefined])
  await clock.settle()
  await $.command.run(ports)
  expect(seen.isPaneOpen).toBe(false)
})

test('pane: groups, tools collapsed until pressed', async ($, on) => {
  const { clock } = world(on)
  await $.session.start(start)
  await clock.settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /acme-app/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /shop_api/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ControlCenter' })).toBe(undefined)
    await ui.press({ key: 'tools' })
    expect(await ui.find({ type: 'Text', text: 'ControlCenter' })).toBeDefined()
    await ui.press({ key: 'tools' })
    await ui.unmount()
  }
})

test('a web port opens and copies its URL, a database only copies', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:repo:/code/acme-app:8000:docker:backend' })
  expect(seen.opened).toEqual(['http://localhost:8000'])
  expect(await ui.find({ key: 'open:repo:/code/acme-app:6379:docker:redis' })).toBe(undefined)
  await ui.press({ key: 'copy:repo:/code/acme-app:8000:docker:backend' })
  await ui.press({ key: 'copy:repo:/code/acme-app:6379:docker:redis' })
  expect(seen.copied).toEqual(['http://localhost:8000', 'localhost:6379'])
  await ui.unmount()
})

test('docker down is said, native ports stay', async ($, on) => {
  const { clock } = world(on, { isDockerDown: true })
  await $.session.start(start)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Docker unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /shop_api/ })).toBeDefined()
  await ui.unmount()
})

test('a failing lsof keeps the last ports, counts how long, retries, recovers', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.settle()
  seen.isLsofBroken = true
  seen.netstat = seen.netstat.map(rebind)
  await $.command.run(ports)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /acme-app/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Stale.* 0s/ })).toBeDefined()
  await clock.advance(6_000)
  expect(await ui.find({ type: 'Text', text: /Stale.* 6s/ })).toBeDefined()
  seen.isLsofBroken = false
  await clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /Stale/ })).toBe(undefined)
  await ui.unmount()
})

test('nothing but read-only commands run while scanning', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(start)
  await clock.advance(30_000)
  expect(seen.runs.filter(line => !/^(netstat|lsof|ps|docker ps|docker inspect) /.test(line))).toEqual([])
})

test('docker not installed is nothing to warn of', async ($, on) => {
  const { clock } = world(on, { isDockerMissing: true })
  await $.session.start(start)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /shop_api/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Docker/ })).toBe(undefined)
  await ui.unmount()
})

test('a system with no browser opener says so', async ($, on) => {
  const { clock, seen } = world(on, { isOpenMissing: true })
  await $.session.start(start)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:repo:/code/acme-app:8000:docker:backend' })
  expect(seen.toasts).toEqual(['Could not open http://localhost:8000'])
  await ui.unmount()
})

test('an unsupported system is named, and nothing is run', async ($, on) => {
  const { clock, seen } = world(on, { sysname: 'FreeBSD' })
  await $.session.start(start)
  await clock.advance(60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /FreeBSD is not supported/ })).toBeDefined()
  expect(seen.runs).toEqual([])
  await ui.unmount()
})

test('linux: working folders come from /proc, and nothing but ss, ps and docker runs', async ($, on) => {
  const { clock, seen } = world(on, { sysname: 'Linux' })
  on('fs.stat', (_, e) => ({
    value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: posix(e.path) === '/proc/10/cwd' ? SHOP : '/elsewhere' },
  }) as never)
  await $.session.start(start)
  await clock.settle()
  expect(seen.runs.filter(line => !/^(ss|ps|docker) /.test(line))).toEqual([])
  expect(seen.status).toBe('● acme-app :6379 :8000  +1 other')
})
