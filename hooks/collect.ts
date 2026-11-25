import type { EngineInterface } from 'claude-code'

import type { Snapshot } from '../types'
import { parseCwds } from './platforms'
import type { Platform } from './platforms'
import { buildSnapshot, CONTAINER_FORMAT, foldersFromCommands, isTool, parseContainers } from './ports'
import type { Container, Process } from './ports'

export function run($: EngineInterface, platform: Platform, argv: string[]) {
  return $.process.run(argv, { timeoutMs: platform.timeoutMs })
}

// Only a folder found in a repo is kept: one outside may become a repo later.
const roots = new Map<string, string>()
// One spelling per repo: Windows ignores case and takes either slash.
const spellings = new Map<string, string>()

async function rootOf($: EngineInterface, platform: Platform, path: string) {
  const known = roots.get(path)
  if (known !== undefined) return known

  const copy = await $.vcs.detect({ path }).catch(() => null)
  if (copy === null) return null

  const root = copy.mainRoot ?? copy.root
  const key = platform.keyOf(root)
  const spelling = spellings.get(key) ?? root
  spellings.set(key, spelling)
  roots.set(path, spelling)

  return spelling
}

/** A few ms, where a full look takes over a hundred. Null: nothing to compare. */
export async function listenersNow($: EngineInterface, platform: Platform) {
  try {
    const { exitCode, stdout } = await run($, platform, platform.check)

    return exitCode === 0 ? platform.fingerprint(stdout) : null
  } catch {
    return null
  }
}

async function listListeners($: EngineInterface, platform: Platform) {
  const { exitCode, stdout, stderr } = await run($, platform, platform.listeners)

  // lsof exits 1 both for "none" and for an error.
  if (exitCode !== 0 && stdout === '' && stderr !== '') throw new Error('listing ports failed')

  return platform.parseListeners(stdout)
}

async function listProcesses($: EngineInterface, platform: Platform) {
  const { stdout } = await run($, platform, platform.processes)

  return platform.parseProcesses(stdout)
}

async function readCwd($: EngineInterface, pid: number) {
  // Not there: the process has ended, or is another user's.
  const found = await $.fs.stat(`/proc/${pid}/cwd`, { resolve: true }).catch(() => null)

  return found?.realPath === undefined ? [] : [found.realPath]
}

async function listFolders(
  $: EngineInterface,
  platform: Platform,
  pids: number[],
  processes: Map<number, Process>,
): Promise<Map<number, string[]>> {
  if (pids.length === 0) return new Map()
  if (platform.folders === 'commands') return foldersFromCommands(pids, processes)
  if (platform.folders === 'proc') {
    return new Map(await Promise.all(pids.map(async pid => [pid, await readCwd($, pid)] as const)))
  }

  // A process that ended meanwhile makes it exit 1; the others are still listed.
  const argv = ['lsof', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']
  const { stdout } = await run($, platform, argv)

  return new Map([...parseCwds(stdout)].map(([pid, cwd]) => [pid, [cwd]]))
}

/** Null: Docker is installed and does not answer. */
async function listContainers($: EngineInterface, platform: Platform): Promise<Container[] | null> {
  try {
    const listed = await run($, platform, ['docker', 'ps', '-q', '--no-trunc'])
    if (listed.exitCode !== 0) return null

    const ids = listed.stdout.split(/\r?\n/).filter(id => id !== '')
    if (ids.length === 0) return []

    // A container removed meanwhile makes it exit 1; the others are still printed.
    const argv = ['docker', 'inspect', '--format', CONTAINER_FORMAT, ...ids]
    const inspected = await run($, platform, argv)

    return parseContainers(inspected.stdout)
  } catch (error) {
    const isInstalled = !(error instanceof Error && error.message.includes('ENOENT'))

    return isInstalled ? null : []
  }
}

export async function collect($: EngineInterface, platform: Platform): Promise<Snapshot> {
  const [listeners, processes, containers, currentFolder] = await Promise.all([
    listListeners($, platform),
    listProcesses($, platform),
    listContainers($, platform),
    $.session.root(),
  ])
  const services = new Set(
    listeners.flatMap(({ pid }) => (pid === null || isTool(pid, processes) ? [] : [pid])),
  )
  const folders = await listFolders($, platform, [...services], processes)
  const places = new Set([
    ...[...folders.values()].flat(),
    ...(containers ?? []).filter(({ ports }) => ports.length > 0).map(({ dir }) => dir),
  ])
  places.delete('/')
  places.delete('')

  const found = await Promise.all(
    [...places].map(async place => [place, await rootOf($, platform, place)] as const),
  )

  return buildSnapshot({
    listeners,
    folders,
    processes,
    containers,
    roots: new Map(found.filter((pair): pair is [string, string] => pair[1] !== null)),
    currentRoot: await rootOf($, platform, currentFolder),
  })
}
