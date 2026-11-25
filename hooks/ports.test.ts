import { describe, expect, test } from 'claude-code/testing'

import {
  buildSnapshot,
  parseContainers,
  parseCwds,
  parseListeners,
  parseProcesses,
  statusText,
} from './ports'

const ACME = '/code/acme/acme-app'
const SHOP = '/code/shop_api'

const listener = (pid: number, name: string, ...hosts: string[]) =>
  [`p${pid}`, `c${name}`, ...hosts.flatMap((host, i) => [`f${i}`, `n${host}`])].join('\n')

type World = {
  lsof?: string[]
  cwds?: Record<number, string>
  ps?: string[]
  containers?: object[] | null
  roots?: Record<string, string>
  current?: string | null
}

const snap = (world: World) =>
  buildSnapshot({
    listeners: parseListeners((world.lsof ?? []).join('\n')),
    cwds: new Map(Object.entries(world.cwds ?? {}).map(([pid, cwd]) => [Number(pid), cwd])),
    processes: parseProcesses((world.ps ?? []).join('\n')),
    containers:
      world.containers === null
        ? null
        : parseContainers((world.containers ?? []).map(c => JSON.stringify(c)).join('\n')),
    roots: new Map(Object.entries(world.roots ?? { [ACME]: ACME, [SHOP]: SHOP })),
    currentRoot: world.current === undefined ? ACME : world.current,
  })

const container = (
  service: string,
  ports: Record<string, [string, string][] | null>,
  rest: object = {},
) => ({
  name: `/x-${service}-1`,
  service,
  project: 'acme_app',
  dir: ACME,
  ports: Object.fromEntries(
    Object.entries(ports).map(([key, list]) => [
      key,
      list && list.map(([HostIp, HostPort]) => ({ HostIp, HostPort })),
    ]),
  ),
  ...rest,
})

describe('order', () => {
  test('current repo leads, then projects by name, ports ascending', () => {
    const got = snap({
      lsof: [listener(10, 'node', '127.0.0.1:3011'), listener(11, 'node', '*:4000')],
      cwds: { 10: SHOP, 11: '/code/alpha' },
      ps: ['10 9 node server.js', '11 9 node server.js'],
      roots: { [ACME]: ACME, [SHOP]: SHOP, '/code/alpha': '/code/alpha' },
      containers: [
        container('backend', { '8000/tcp': [['0.0.0.0', '8000'], ['::', '8000']] }),
        container('frontend', { '3000/tcp': [['0.0.0.0', '3000']] }),
      ],
    })
    expect(got.groups.map(g => [g.name, g.isCurrent, g.ports.map(p => p.port)])).toEqual([
      ['acme-app', true, [3000, 8000]],
      ['alpha', false, [4000]],
      ['shop_api', false, [3011]],
    ])
  })

  test('with no current repo no group is current', () => {
    const got = snap({ containers: [container('backend', { '8000/tcp': [['', '8000']] })], current: null })
    expect(got.groups.map(g => g.isCurrent)).toEqual([false])
  })
})

describe('containers', () => {
  test('compose project outside a repo is its own group, under its project name', () => {
    const got = snap({
      containers: [container('db', { '5432/tcp': [['0.0.0.0', '5432']] }, { project: 'db-stack', dir: '/dl/pg' })],
    })
    expect(got.groups.map(g => [g.name, g.isCurrent, g.ports[0]?.label])).toEqual([['db-stack', false, 'db']])
  })

  test('container without compose is grouped under its own name', () => {
    const got = snap({ containers: [{ name: '/lonely', service: '', project: '', dir: '', ports: { '80/tcp': [{ HostIp: '', HostPort: '8080' }] } }] })
    expect(got.groups.map(g => [g.name, g.ports.map(p => [p.port, p.label])])).toEqual([['lonely', [[8080, 'lonely']]]])
  })

  test('unpublished and udp ports are not listed', () => {
    const got = snap({ containers: [container('celery', { '8000/tcp': null, '53/udp': [['0.0.0.0', '53']] })] })
    expect(got.groups).toEqual([])
  })

  test("a published port's proxy row is dropped, an unpublished proxy row is kept in tools", () => {
    const got = snap({
      lsof: [listener(40, 'com.docker.backend', '*:8000', '*:9999')],
      cwds: { 40: '/Users/me/Library' },
      ps: ['40 1 /Applications/Docker.app/Contents/MacOS/com.docker.backend services'],
      containers: [container('backend', { '8000/tcp': [['0.0.0.0', '8000']] })],
    })
    expect(got.groups[0]?.ports.map(p => [p.port, p.kind])).toEqual([[8000, 'docker']])
    expect(got.tools.map(p => p.port)).toEqual([9999])
  })

  test('a native process sharing a published port still shows', () => {
    const got = snap({
      lsof: [listener(40, 'com.docker.backend', '*:8000'), listener(20, 'Python', '127.0.0.1:8000')],
      cwds: { 20: `${ACME}/backend` },
      roots: { [ACME]: ACME, [`${ACME}/backend`]: ACME },
      ps: ['40 1 /Applications/Docker.app/Contents/MacOS/com.docker.backend', '20 9 python manage.py runserver'],
      containers: [container('backend', { '8000/tcp': [['0.0.0.0', '8000']] })],
    })
    expect(got.groups[0]?.ports.map(p => [p.port, p.kind])).toEqual([[8000, 'docker'], [8000, 'native']])
  })

  test('docker down keeps native ports and says so', () => {
    const got = snap({ lsof: [listener(10, 'node', '*:3011')], cwds: { 10: SHOP }, ps: ['10 9 node s.js'], containers: null })
    expect([got.isDockerUp, got.groups.map(g => g.name)]).toEqual([false, ['shop_api']])
  })
})

describe('native classification', () => {
  const toolCases: [string, string[], number][] = [
    ['an MCP server is a direct child of claude', ['50 1 claude', '60 50 /py/Python /me/.local/bin/whatever-mcp'], 60],
    ['a daemon from the tooling list', ['60 1 /me/.local/bin/codebase-memory-mcp --daemon'], 60],
    ['the serena dashboard', ['60 1 /py/Python -c from serena.dashboard import X'], 60],
    ['an Android emulator', ['60 1 /Users/me/Library/Android/sdk/emulator/qemu/qemu-system-aarch64 -avd P'], 60],
    ['an application', ['60 1 /Applications/Raycast.app/Contents/MacOS/Raycast'], 60],
    ['claude itself', ['60 1 claude'], 60],
  ]
  for (const [name, ps, pid] of toolCases) {
    test(`${name} in the repo is a tool, not a service`, () => {
      const got = snap({ lsof: [listener(pid, 'x', '127.0.0.1:24283')], cwds: { [pid]: ACME }, ps })
      expect([got.groups, got.tools.map(p => p.port)]).toEqual([[], [24283]])
    })
  }

  test('a dev server Claude started through its shell is a service', () => {
    const got = snap({
      lsof: [listener(62, 'node', '*:5173')],
      cwds: { 62: ACME },
      ps: ['50 1 claude', '61 50 /bin/zsh -c npm run dev', '62 61 node vite'],
    })
    expect(got.groups[0]?.ports.map(p => p.port)).toEqual([5173])
  })

  test("Xcode's bundled Python is not an application", () => {
    const got = snap({
      lsof: [listener(62, 'Python', '*:8001')],
      cwds: { 62: ACME },
      ps: ['62 61 /Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python manage.py runserver'],
    })
    expect(got.groups[0]?.ports.map(p => p.port)).toEqual([8001])
  })

  test('workers sharing one socket are one row, different services on one port are two', () => {
    const got = snap({
      lsof: [listener(70, 'gunicorn', '127.0.0.1:8000'), listener(71, 'gunicorn', '*:8000'), listener(72, 'node', '[::1]:8000')],
      cwds: { 70: ACME, 71: ACME, 72: ACME },
      ps: ['70 1 gunicorn', '71 70 gunicorn', '72 1 node s.js'],
    })
    expect(got.groups[0]?.ports.map(p => [p.port, p.label, p.isLan])).toEqual([[8000, 'gunicorn', true], [8000, 'node', false]])
  })

  test('tool processes sharing one socket are one row', () => {
    const got = snap({ lsof: [listener(70, 'x', '*:7000'), listener(71, 'x', '*:7000')], ps: ['70 1 /System/x', '71 70 /System/x'] })
    expect(got.tools.map(p => p.port)).toEqual([7000])
  })

  test('a process outside every repo is a tool', () => {
    const got = snap({ lsof: [listener(62, 'postgres', '127.0.0.1:5433')], cwds: { 62: '/var/pg' }, ps: ['62 1 postgres'] })
    expect([got.groups.length, got.tools.length]).toEqual([0, 1])
  })

  test('a worktree joins its main repo', () => {
    const got = snap({
      lsof: [listener(62, 'node', '*:5173')],
      cwds: { 62: '/code/wt/feature' },
      roots: { '/code/wt/feature': ACME },
      ps: ['62 61 node vite'],
    })
    expect(got.groups.map(g => [g.name, g.isCurrent])).toEqual([['acme-app', true]])
  })
})

describe('addresses', () => {
  const one = (...hosts: string[]) =>
    snap({ lsof: [listener(62, 'node', ...hosts)], cwds: { 62: ACME }, ps: ['62 61 node s.js'] }).groups[0]?.ports.map(p => [p.port, p.isLan])

  test('IPv4 and IPv6 of one listener merge', () => {
    expect(one('127.0.0.1:9100', '[::1]:9100')).toEqual([[9100, false]])
  })
  test('loopback plus a wildcard is LAN, in either order', () => {
    expect(one('127.0.0.1:9100', '*:9100')).toEqual([[9100, true]])
    expect(one('*:9100', '127.0.0.1:9100')).toEqual([[9100, true]])
  })
  test('a specific network address is LAN', () => {
    expect(one('10.0.0.5:9100')).toEqual([[9100, true]])
  })
  test('container bound to loopback is local, to everything is LAN', () => {
    const got = snap({ containers: [container('a', { '1/tcp': [['127.0.0.1', '8025']], '2/tcp': [['0.0.0.0', '8026']] })] })
    expect(got.groups[0]?.ports.map(p => p.isLan)).toEqual([false, true])
  })
})

describe('web or not', () => {
  test('a database is judged by its container port, whatever its host port', () => {
    const got = snap({ containers: [container('db', { '5432/tcp': [['', '15432']] }), container('web', { '80/tcp': [['', '8080']] })] })
    expect(got.groups[0]?.ports.map(p => [p.port, p.isWeb])).toEqual([[8080, true], [15432, false]])
  })
  test('a native redis is not web', () => {
    const got = snap({ lsof: [listener(62, 'redis-server', '127.0.0.1:6379')], cwds: { 62: ACME }, ps: ['62 1 redis-server'] })
    expect(got.groups[0]?.ports[0]?.isWeb).toBe(false)
  })
})

describe('parsing', () => {
  test('lsof escapes in a name are decoded', () => {
    expect(parseListeners(listener(1, 'Code\\x20Helper', '*:80'))[0]?.name).toBe('Code Helper')
  })
  test('working folders by pid, spaces kept', () => {
    expect([...parseCwds('p7\nfcwd\nn/code/MY TEAM/app\np8\nfcwd\nn/')]).toEqual([[7, '/code/MY TEAM/app'], [8, '/']])
  })
  test('empty output is no rows', () => {
    expect([parseListeners(''), [...parseCwds('')], parseContainers('')]).toEqual([[], [], []])
  })
  test('process arguments never reach the snapshot', () => {
    const got = snap({ lsof: [listener(62, 'node', '*:5173')], cwds: { 62: ACME }, ps: ['62 61 node s.js --token=hunter2'] })
    expect(JSON.stringify(got).includes('hunter2')).toBe(false)
  })
})

describe('status line', () => {
  const ports = (...list: number[]) => list.map(port => container(`s${port}`, { [`${port}/tcp`]: [['', String(port)]] }))
  const db = container('db', { '5432/tcp': [['', '5432']] }, { project: 'pg', dir: '/dl/pg' })

  test("this repo's ports, then how many others", () => {
    expect(statusText(snap({ containers: [...ports(8000, 3000), db] }))).toBe('● acme-app :3000 :8000  +1 other')
  })
  test('five ports at most, the rest counted', () => {
    expect(statusText(snap({ containers: ports(1, 2, 3, 4, 5, 6, 7) }))).toBe('● acme-app :1 :2 :3 :4 :5 +2')
  })
  test('exactly five shows no count', () => {
    expect(statusText(snap({ containers: ports(1, 2, 3, 4, 5) }))).toBe('● acme-app :1 :2 :3 :4 :5')
  })
  test('only other projects', () => {
    expect(statusText(snap({ containers: [db] }))).toBe('○ no ports here  +1 other')
  })
  test('nothing but tools clears the line', () => {
    expect(statusText(snap({ lsof: [listener(1, 'x', '*:7000')], ps: ['1 0 /System/x'] }))).toBe(undefined)
  })
})
