import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { withLeaseHeartbeat } from '../factory/lease'
import { effectiveEnv } from '../factory/settings'
import { proofDeps } from '../panel/deps'
import { runProof } from '../panel/prove'

export default defineJob('prove-checks', {
  input: z.object({ repository: z.string().max(201), at: z.string().max(40) }),
  // A proof that could not run says so on the repository, and the owner asks for it again. Running it a
  // second time on its own would start another sandbox for a proposal that may have been replaced.
  maxAttempts: 1,
  async handler({ input, extendLease }) {
    // The lease is two minutes and the checks may take the whole life of a sandbox: renew it meanwhile.
    await withLeaseHeartbeat(extendLease, async () => {
      await runProof(proofDeps(await effectiveEnv(getDb())), input)
      console.log(JSON.stringify({ event: 'checks_proof_finished', ...input }))
    })
  },
})
