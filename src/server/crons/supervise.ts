import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { supervise } from '../factory/supervise'

/**
 * Checks the factory itself every five minutes: work that stopped moving, and things waiting for
 * something that is gone. It reports and never acts; a person resolves a finding from the panel.
 */
export default defineCron('supervise', {
  schedule: '*/5 * * * *',
  async handler() {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'supervise_not_configured', error: String(error) }))
      return
    }
    const provider = deps.sandbox
    const result = await supervise({
      db: getDb(),
      // A provider that cannot be asked leaves the snapshot check out, and nothing gets resolved by that.
      listSnapshots: provider.listSnapshots?.bind(provider),
    })
    if (result.opened.length > 0 || result.resolved.length > 0) {
      console.log(JSON.stringify({ event: 'supervise', ...result }))
    }
  },
})
