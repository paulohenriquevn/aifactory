import { Button, Input } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import type { ClaudeLoginState } from '../../shared/panel'
import { del, get, post } from '../lib/api'

/**
 * Changing the Claude Code account without leaving the panel. The owner opens a link signed in to the
 * account they want, copies the code the page shows, and pastes it here; the panel checks that the account
 * really answers before it keeps anything. The token never comes back to the page.
 */
export function ClaudeAccount({ onChanged }: { onChanged: () => void }) {
  const [login, setLogin] = useState<ClaudeLoginState>({ status: 'idle' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [retried, setRetried] = useState<string>()

  // A login started before the page was reloaded is still waiting for its code.
  useEffect(() => {
    let alive = true
    get<ClaudeLoginState>('/api/panel/claude/login')
      .then((state) => alive && setLogin(state))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function act(run: () => Promise<ClaudeLoginState>) {
    setBusy(true)
    try {
      const next = await run()
      setLogin(next)
      if (next.status === 'done') onChanged()
    } catch (error) {
      setLogin({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  async function retryWaiting() {
    setBusy(true)
    try {
      const { started } = await post<{ started: number; skipped: number }>(
        '/api/panel/retry-waiting',
      )
      setRetried(
        started === 0
          ? 'Nenhuma tarefa estava esperando.'
          : `${started} ${started === 1 ? 'tarefa começou' : 'tarefas começaram'} de novo.`,
      )
    } catch (error) {
      setRetried(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const start = () => act(() => post<ClaudeLoginState>('/api/panel/claude/login'))
  const cancel = () => {
    setCode('')
    return act(() => del<ClaudeLoginState>('/api/panel/claude/login'))
  }
  const send = () =>
    act(async () => {
      const next = await post<ClaudeLoginState>('/api/panel/claude/login/code', { code })
      setCode('')
      return next
    })

  return (
    <section
      aria-label="Trocar a conta do Claude Code"
      className="rounded-lg border border-border bg-card p-3 text-sm"
    >
      {login.status === 'idle' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground">
            A conta do Claude Code estourou o limite, ou você quer usar outra? Entre com a outra
            conta aqui.
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            Entrar com outra conta
          </Button>
        </div>
      ) : null}

      {login.status === 'waiting' ? (
        <ol className="space-y-3">
          <li>
            <span className="font-medium">1.</span> Abra a página de login e entre na conta que quer
            usar. Se o navegador já estiver numa conta, saia dela antes ou use uma janela anônima.{' '}
            <Button asChild size="sm" className="ml-1">
              <a href={login.url} target="_blank" rel="noreferrer">
                Abrir a página de login
              </a>
            </Button>
          </li>
          <li>
            <span className="font-medium">2.</span> A página vai mostrar um código. Copie e cole
            aqui:
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                aria-label="Código da página de login"
                value={code}
                placeholder="Cole o código inteiro, com o #"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value)}
                className="min-w-72 flex-1 font-mono"
              />
              <Button size="sm" disabled={busy || code.trim() === ''} onClick={() => void send()}>
                Conectar
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                Cancelar
              </Button>
            </div>
          </li>
        </ol>
      ) : null}

      {login.status === 'checking' ? (
        <p role="status" className="text-muted-foreground">
          Conferindo a conta com uma chamada de teste. Pode levar até um minuto.
        </p>
      ) : null}

      {login.status === 'done' ? (
        <div className="space-y-2">
          <p role="status" className="text-foreground">
            Pronto: a fábrica já usa a conta nova, sem reiniciar nada. Testei com uma chamada e ela
            respondeu.
          </p>
          {retried ? (
            <p role="status" className="text-muted-foreground">
              {retried}
            </p>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void retryWaiting()}
            >
              Refazer as tarefas que esperavam a conta
            </Button>
          )}
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
