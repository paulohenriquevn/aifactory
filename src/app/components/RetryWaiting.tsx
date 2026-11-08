import { Button } from '@usetheo/ui'
import { useState } from 'react'

import { post } from '../lib/api'

/** Starts again the tasks that stopped to wait for an agent account, once a new one is connected. */
export function RetryWaiting() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()

  async function retry() {
    setBusy(true)
    try {
      const { started } = await post<{ started: number; skipped: number }>(
        '/api/panel/retry-waiting',
      )
      setResult(
        started === 0
          ? 'Nenhuma tarefa estava esperando.'
          : `${started} ${started === 1 ? 'tarefa começou' : 'tarefas começaram'} de novo.`,
      )
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return result ? (
    <p role="status" className="text-muted-foreground">
      {result}
    </p>
  ) : (
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retry()}>
      Refazer as tarefas que esperavam a conta
    </Button>
  )
}
