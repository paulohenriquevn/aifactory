import { Button } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import { get, post } from '../../lib/api'
import type { Connection } from '../../lib/chat'

/**
 * Connects the owner's ChatGPT subscription: the button asks for a code, the owner types it at the address,
 * and the page asks every few seconds whether the credential is there yet.
 */
export function ChatgptConnect({ onConnected }: { onConnected: () => void }) {
  const [state, setState] = useState<Connection['login']>({ status: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (state.status !== 'waiting') return
    const timer = setInterval(() => {
      void get<Connection>('/api/panel/chat/connection').then((c) => {
        if (c.connected) onConnected()
        else setState(c.login)
      })
    }, 3000)
    return () => clearInterval(timer)
  }, [state.status, onConnected])

  async function start() {
    setBusy(true)
    try {
      setState(await post<Connection['login']>('/api/panel/chat/connection'))
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Conectar o ChatGPT"
      className="mb-3 rounded-2xl border border-border bg-muted p-4 text-[14px]"
    >
      <p className="text-foreground">
        Conecte a sua assinatura do ChatGPT para conversar com este modelo.
      </p>
      {state.status === 'waiting' ? (
        <p className="mt-2 text-foreground/80">
          Abra{' '}
          <a href={state.verificationUri} target="_blank" rel="noreferrer" className="underline">
            {state.verificationUri}
          </a>{' '}
          e digite o código{' '}
          <strong className="font-mono tracking-wider text-foreground">{state.userCode}</strong>.
          Esta página percebe sozinha quando você terminar.
        </p>
      ) : (
        <Button className="mt-3" size="sm" disabled={busy} onClick={() => void start()}>
          Conectar o ChatGPT
        </Button>
      )}
      {state.status === 'error' ? (
        <p role="alert" className="mt-2 text-destructive">
          Não deu certo: {state.message}
        </p>
      ) : null}
    </section>
  )
}
