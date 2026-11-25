import { describe, expect, test } from 'claude-code/testing'

import { DARWIN, LINUX, pathsIn, platformOf, WINDOWS } from './platforms'

test('each system has its platform, any other has none', () => {
  expect([platformOf('Darwin'), platformOf('Linux'), platformOf('Windows_NT'), platformOf('FreeBSD')]).toEqual([
    DARWIN,
    LINUX,
    WINDOWS,
    null,
  ])
})

test('a URL is opened by argument, never through a shell', () => {
  const url = 'http://localhost:1'
  expect([DARWIN, LINUX, WINDOWS].map(one => one.open(url))).toEqual([
    ['open', url],
    ['xdg-open', url],
    ['rundll32', 'url.dll,FileProtocolHandler', url],
  ])
})

test('Windows ignores case and takes either slash in a path, Linux does not', () => {
  expect(WINDOWS.keyOf('c:\\Code\\App')).toBe(WINDOWS.keyOf('C:/code/app'))
  expect(LINUX.keyOf('/code/App') === LINUX.keyOf('/code/app')).toBe(false)
})

describe('linux', () => {
  const users = (...list: [string, number][]) =>
    `users:(${list.map(([name, pid]) => `("${name}",pid=${pid},fd=20)`).join(',')})`
  const row = (local: string, rest = '') => `LISTEN 0      511          ${local}      0.0.0.0:*    ${rest}`
  const read = (...rows: string[]) =>
    LINUX.parseListeners(rows.join('\n')).map(l => [l.pid, l.name, l.port, l.isLan])

  test('address, process and reach', () => {
    expect(
      read(
        row('127.0.0.1:3011', users(['node', 10])),
        row('*:8000', users(['python3', 11])),
        row('[::]:8001', users(['python3', 12])),
        row('[::1]:8002', users(['java', 13])),
        row('[::ffff:127.0.0.1]:8003', users(['java', 14])),
        row('127.0.0.53%lo:53'),
        row('[::1%lo]:54'),
      ),
    ).toEqual([
      [10, 'node', 3011, false],
      [11, 'python3', 8000, true],
      [12, 'python3', 8001, true],
      [13, 'java', 8002, false],
      [14, 'java', 8003, false],
      [null, '', 53, false],
      [null, '', 54, false],
    ])
  })

  test('workers sharing a socket are each listed', () => {
    expect(read(row('0.0.0.0:80', users(['nginx', 20], ['nginx', 21])))).toEqual([
      [20, 'nginx', 80, true],
      [21, 'nginx', 80, true],
    ])
  })

  test('a name with spaces and brackets is kept', () => {
    expect(read(row('*:9', users(['Web (x) y', 5])))).toEqual([[5, 'Web (x) y', 9, true]])
  })

  const check = (ino: number, queue = 0, local = '127.0.0.1:3011') =>
    `LISTEN ${queue} 511 ${local} 0.0.0.0:* uid:1000 ino:${ino} sk:a${ino} cgroup:/x <->`
  test('a full queue is no change, another socket or address is', () => {
    expect(LINUX.fingerprint(check(1, 5))).toBe(LINUX.fingerprint(check(1)))
    expect(LINUX.fingerprint(check(2)) === LINUX.fingerprint(check(1))).toBe(false)
    expect(LINUX.fingerprint(check(1, 0, '*:3011')) === LINUX.fingerprint(check(1))).toBe(false)
  })
  test('order of rows is no change', () => {
    expect(LINUX.fingerprint([check(1), check(2)].join('\n'))).toBe(LINUX.fingerprint([check(2), check(1)].join('\n')))
  })
})

describe('windows', () => {
  // German Windows: the state is translated, so only the foreign port 0 says "listening".
  const netstat = [
    '',
    'Aktive Verbindungen',
    '',
    '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
    '  TCP    0.0.0.0:8000           0.0.0.0:0              ABHÖREN          4120',
    '  TCP    127.0.0.1:3011         0.0.0.0:0              ABHÖREN          4121',
    '  TCP    127.0.0.1:3011         127.0.0.1:50000        HERGESTELLT      4121',
    '  TCP    [::]:8000              [::]:0                 ABHÖREN          4120',
    '  TCP    [::1]:9000             [::]:0                 ABHÖREN          4122',
    '  UDP    0.0.0.0:5353           *:*                                     999',
  ].join('\r\n')

  test('listeners in any language', () => {
    expect(WINDOWS.parseListeners(netstat).map(l => [l.pid, l.port, l.isLan])).toEqual([
      [4120, 8000, true],
      [4121, 3011, false],
      [4122, 9000, false],
    ])
  })
  test('a connection coming or going is no change, a listener is', () => {
    const without = netstat.split('\r\n').filter(line => !line.includes('50000')).join('\r\n')
    expect(WINDOWS.fingerprint(without)).toBe(WINDOWS.fingerprint(netstat))
    expect(WINDOWS.fingerprint(netstat.replace('4122', '4999')) === WINDOWS.fingerprint(netstat)).toBe(false)
  })

  const one = (ProcessId: number, ParentProcessId: number, at: number | null, rest: object = {}) => ({
    ProcessId,
    ParentProcessId,
    Name: 'node.exe',
    ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    CommandLine: 'node x',
    CreationDate: at === null ? null : `/Date(${at})/`,
    ...rest,
  })
  test('names without .exe, protected processes without a command line', () => {
    const got = WINDOWS.parseProcesses(
      JSON.stringify([one(1, 0, 5), one(4, 0, null, { Name: 'System', ExecutablePath: null, CommandLine: null })]),
    )
    expect([got.get(1)?.name, got.get(4)?.name, got.get(4)?.command]).toEqual(['node', 'System', ''])
  })
  test('a reused parent id, younger than the child, is no parent', () => {
    const got = WINDOWS.parseProcesses(JSON.stringify([one(10, 11, 100), one(11, 0, 200), one(12, 11, 300)]))
    expect([got.get(10)?.ppid, got.get(12)?.ppid]).toEqual([0, 11])
  })
  test('a byte order mark before the answer is skipped', () => {
    expect(WINDOWS.parseProcesses(`\uFEFF${JSON.stringify([one(7, 0, 1)])}`).has(7)).toBe(true)
  })
  test('a single process is not a list', () => {
    expect(WINDOWS.parseProcesses(JSON.stringify(one(7, 0, 1))).has(7)).toBe(true)
  })
})

describe('project folders from a Windows command line', () => {
  const cases: [string, string, string[]][] = [
    ['a quoted path with spaces', '"C:\\Program Files\\nodejs\\node.exe" "C:\\my code\\app\\node_modules\\vite\\bin\\vite.js"', ['C:\\my code\\app\\node_modules\\vite\\bin']],
    ['an unquoted path', 'python C:\\code\\api\\manage.py runserver', ['C:\\code\\api']],
    ['after an equals sign', 'java --spring.config=C:\\code\\j\\app.yml', ['C:\\code\\j']],
    ['forward slashes', 'node C:/code/app/server.js', ['C:/code/app']],
    ["a venv's python, as the program", 'C:\\code\\api\\.venv\\Scripts\\python.exe manage.py', ['C:\\code\\api\\.venv\\Scripts']],
    ['arguments before the program', 'C:\\code\\tool\\run.exe C:\\code\\app\\x.js', ['C:\\code\\app', 'C:\\code\\tool']],
    ['only relative paths', 'node server.js', []],
    ['Windows and Program Files', 'C:\\Windows\\System32\\svchost.exe -k C:\\Program Files (x86)\\x\\y.dll', []],
    ['version managers', 'C:\\Users\\me\\.pyenv\\pyenv-win\\versions\\3\\python.exe -m http.server', []],
    ['network paths are never looked at', 'node \\\\server\\share\\app\\x.js', []],
    ['a URL is no path', 'node --url http://localhost:3000/a/b', []],
  ]
  for (const [name, command, expected] of cases) {
    test(name, () => expect(pathsIn(command)).toEqual(expected))
  }
})
