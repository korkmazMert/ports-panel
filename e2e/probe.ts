// Runs the mod's own collection in the real engine and prints what it found.
import type { Register } from 'claude-code'

import { collect, listenersNow, run } from './collect'
import { platformOf } from './platforms'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ports-probe', description: 'probe' })

    return next(e)
  })

  on('command.run', { command: 'ports-probe' }, async $ => {
    const platform = platformOf((await $.session.machine()).sysname)
    if (platform === null) return { text: 'PROBE {"error":"unsupported"}' }

    try {
      const start = await $.clock.now()
      const fingerprint = await listenersNow($, platform)
      const checked = await $.clock.now()
      await run($, platform, platform.processes)
      const listed = await $.clock.now()
      const snapshot = await collect($, platform)
      const collected = await $.clock.now()
      const times = {
        check: checked - start,
        processes: listed - checked,
        collect: collected - listed,
      }

      return { text: `PROBE ${JSON.stringify({ fingerprint, snapshot, times })}` }
    } catch (error) {
      return { text: `PROBE ${JSON.stringify({ error: String(error) })}` }
    }
  })
}
