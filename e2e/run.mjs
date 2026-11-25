// Starts real servers in real repos and checks what the mod reports of them, in
// the real engine: no login, and no model is called.
//
//   node e2e/run.mjs            native servers
//   node e2e/run.mjs --docker   and a container
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env, argv, execPath, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isWindows = platform === 'win32'
const work = mkdtempSync(join(tmpdir(), 'ports-e2e-'))

// The mod with the probe in place of its hooks.
const plugin = join(work, 'plugin')
cpSync(join(here, '..', 'types', 'index.d.ts'), join(plugin, 'types', 'index.d.ts'))
for (const file of ['collect.ts', 'platforms.ts', 'ports.ts']) {
  cpSync(join(here, '..', 'hooks', file), join(plugin, 'hooks', file))
}
cpSync(join(here, 'probe.ts'), join(plugin, 'hooks', 'register.ts'))
mkdirSync(join(plugin, '.claude-plugin'))
writeFileSync(
  join(plugin, '.claude-plugin', 'plugin.json'),
  '{"name":"ports-probe","version":"0.0.1","description":"probe"}',
)
writeFileSync(join(plugin, 'hooks', 'hooks.json'), '{"modules":["./register.ts"]}')

const SERVER = `
const [port, host] = process.argv.slice(2)
require('http').createServer((_, res) => res.end('ok')).listen(Number(port), host, () => console.log('up'))
`
const repo = name => {
  const folder = join(work, name, 'Sub Folder')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'server.js'), SERVER)
  assert.equal(spawnSync('git', ['init', '-q', join(work, name)]).status, 0)

  return folder
}

const children = []
const serve = async (folder, port, host, isRelative = false) => {
  const script = isRelative ? 'server.js' : join(folder, 'server.js')
  const child = spawn(execPath, [script, String(port), host], { cwd: folder })
  children.push(child)
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.stderr.once('data', data => reject(new Error(String(data))))
  })
}

const probe = cwd => {
  const ran = spawnSync('claude', ['--plugin-dir', plugin, '-p', '/ports-probe'], {
    cwd,
    encoding: 'utf8',
    input: '',
    shell: isWindows,
    timeout: 120_000,
    env: {
      ...env,
      ANTHROPIC_API_KEY: 'none',
      CLAUDE_CONFIG_DIR: join(work, 'config'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  })
  const line = /PROBE (\{.*\})/.exec(ran.stdout)
  assert.ok(line, `no answer: ${ran.stdout}\n${ran.stderr}\n${ran.error ?? ''}`)

  const answer = JSON.parse(line[1])
  assert.equal(answer.error, undefined)

  return answer
}

const at = ({ snapshot }, port) =>
  [...snapshot.groups, { name: 'tools', isCurrent: false, ports: snapshot.tools }]
    .flatMap(({ name, isCurrent, ports }) => ports.map(one => ({ ...one, group: name, isCurrent })))
    .filter(one => one.port === port)

try {
  const current = repo('current-app')
  const other = repo('other-app')
  const before = probe(current)
  assert.ok(before.fingerprint, 'the check found no listener to compare')

  await serve(current, 38311, '127.0.0.1')
  await serve(other, 38312, '0.0.0.0')
  await serve(other, 38313, '127.0.0.1', true)
  const after = probe(current)
  const rows = [38311, 38312, 38313].map(port => at(after, port))
  console.log(JSON.stringify({ times: after.times, isDockerUp: after.snapshot.isDockerUp, rows }, null, 1))

  const row = { label: 'node', kind: 'native', isWeb: true }
  assert.notEqual(after.fingerprint, before.fingerprint, 'the check missed new listeners')
  assert.deepEqual(rows[0], [{ port: 38311, ...row, isLan: false, group: 'current-app', isCurrent: true }])
  assert.deepEqual(rows[1], [{ port: 38312, ...row, isLan: true, group: 'other-app', isCurrent: false }])
  // A documented limit: Windows does not tell working folders.
  assert.equal(rows[2][0]?.group, isWindows ? 'tools' : 'other-app')
  assert.equal(after.snapshot.groups[0]?.name, 'current-app')

  // Windows ignores the case of a path, so the same repo.
  if (isWindows) {
    const shouted = probe(current.toUpperCase())
    assert.equal(at(shouted, 38311)[0]?.isCurrent, true, 'the repo in capitals is another one')
  }

  children.pop().kill()
  await new Promise(resolve => setTimeout(resolve, 1_000))
  const stopped = probe(current)
  assert.deepEqual(at(stopped, 38313), [])
  assert.notEqual(stopped.fingerprint, after.fingerprint, 'the check missed a listener gone')

  if (argv.includes('--docker')) {
    const label = (key, value) => ['--label', `com.docker.compose.${key}=${value}`]
    const ran = spawnSync(
      'docker',
      [
        'run', '-d', '--rm', '--name', 'ports-e2e', '-p', '38320:80', '-p', '127.0.0.1:38321:5432',
        ...label('service', 'web'), ...label('project', 'p'),
        ...label('project.working_dir', current), 'nginx:alpine',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(ran.status, 0, ran.stderr)
    try {
      const docker = probe(current)
      const container = { label: 'web', kind: 'docker', group: 'current-app', isCurrent: true }
      assert.deepEqual(at(docker, 38320), [{ port: 38320, ...container, isLan: true, isWeb: true }])
      assert.deepEqual(at(docker, 38321), [{ port: 38321, ...container, isLan: false, isWeb: false }])
      assert.notEqual(docker.fingerprint, stopped.fingerprint, 'the check missed a container')
    } finally {
      spawnSync('docker', ['stop', '-t', '0', 'ports-e2e'])
    }
  }
  console.log('e2e passed')
} finally {
  for (const child of children) child.kill()
}
