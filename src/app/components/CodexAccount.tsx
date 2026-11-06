import { Button } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import type { CodexConnection } from '../../shared/panel'
import { del, get, post } from '../lib/api'

import { RetryWaiting } from './RetryWaiting'

const LOGIN_URL = '/api/panel/codex/login'
const failed = (error: unknown): CodexConnection => ({
  account: { connected: false },
  login: { status: 'error', message: error instanceof Error ? error.message : String(error) },
})

/**
 * Changing the factory's Codex account without leaving the panel. The owner opens an address signed in to
 * the ChatGPT account they want and types the code shown here; the page asks every few seconds how it went.
 * The panel checks that the account answers before it keeps it, and no token ever reaches the page.
 */
export function CodexAccount({ onChanged }: { onChanged: () => void }) {
  const [conn, setConn] = useState<CodexConnection>()
  const [busy, setBusy] = useState(false)
  const status = conn?.login.status

  useEffect(() => {
    let alive = true
    get<CodexConnection>(LOGIN_URL)
      .then((next) => alive && setConn(next))
      .catch((error: unknown) => alive && setConn(failed(error)))
    return () => {
      alive = false
    }
  }, [])

  // While the owner approves, and while the account is checked, the page asks how it is going.
  useEffect(() => {
    if (status !== 'waiting' && status !== 'checking') return
    const timer = setInterval(() => {
      get<CodexConnection>(LOGIN_URL)
        .then((next) => {
          setConn(next)
          if (next.login.status === 'done') onChanged()
        })
        .catch((error: unknown) => setConn(failed(error)))
    }, 3000)
    return () => clearInterval(timer)
  }, [status, onChanged])

  async function act(run: () => Promise<CodexConnection>) {
    setBusy(true)
    try {
      setConn(await run())
    } catch (error) {
      setConn(failed(error))
    } finally {
      setBusy(false)
    }
  }
  const start = () => act(() => post<CodexConnection>(LOGIN_URL))
  const cancel = () => act(() => del<CodexConnection>(LOGIN_URL))

  if (!conn) return null
  const { account, login } = conn

  return (
    <section
      aria-label="Trocar a conta do Codex"
      className="rounded-lg border border-border bg-card p-3 text-sm"
    >
      {login.status === 'idle' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {account.connected
              ? `Conectado${account.email ? ` como ${account.email}` : ''}${account.plan ? ` (plano ${account.plan})` : ''}. A conta estourou o limite, ou você quer usar outra? Entre com a outra conta aqui.`
              : account.problem
                ? `O login do Codex que está aqui não pode ser usado: ${account.problem}`
                : 'O Codex ainda não tem uma conta do ChatGPT. Entre com ela aqui.'}
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            {account.connected ? 'Entrar com outra conta' : 'Conectar o Codex'}
          </Button>
        </div>
      ) : null}

      {login.status === 'waiting' ? (
        <div className="space-y-2">
          <p>
            Abra{' '}
            <a href={login.verificationUri} target="_blank" rel="noreferrer" className="underline">
              {login.verificationUri}
            </a>{' '}
            na conta do ChatGPT que quer usar e digite o código{' '}
            <strong className="font-mono tracking-wider">{login.userCode}</strong>. Se o navegador
            já estiver em outra conta, saia dela antes ou use uma janela anônima. Esta página
            percebe sozinha quando você terminar.
          </p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {login.status === 'checking' ? (
        <p role="status" className="text-muted-foreground">
          Conferindo a conta com uma chamada de teste. Pode levar até dois minutos.
        </p>
      ) : null}

      {login.status === 'done' ? (
        <div className="space-y-2">
          <p role="status" className="text-foreground">
            Pronto: a fábrica já usa a conta nova
            {account.connected && account.email ? ` (${account.email})` : ''}, sem reiniciar nada.
            Testei com uma chamada e ela respondeu.
          </p>
          <RetryWaiting />
        </div>
      ) : null}

      {login.status === 'error' ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">
            {login.message}
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            Tentar de novo
          </Button>
        </div>
      ) : null}
    </section>
  )
}
