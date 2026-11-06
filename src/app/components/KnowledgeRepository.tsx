import { Button, Input } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import type { KnowledgeChoice, KnowledgeStatus } from '../../shared/knowledge'
import type { RepositoriesView } from '../../shared/panel'
import { get, post, put } from '../lib/api'

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '—')
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR') : 'ainda não')

/**
 * Choosing the repository that is the knowledge base. The factory fetches it every minute and every agent
 * reads it, in a sandbox or in the panel; the factory writes its own notes to a branch of its own and never
 * to the one chosen here.
 */
export function KnowledgeRepository({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<KnowledgeStatus>()
  const [choices, setChoices] = useState<string[]>([])
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [proposed, setProposed] = useState<string>()

  useEffect(() => {
    let alive = true
    get<KnowledgeStatus>('/api/panel/knowledge')
      .then((s) => {
        if (!alive) return
        setStatus(s)
        setRepository(s.repository ?? '')
        setBranch(s.branch ?? '')
      })
      .catch(
        (error: unknown) =>
          alive && setProblem(String(error instanceof Error ? error.message : error)),
      )
    get<RepositoriesView>('/api/panel/repositories')
      .then(
        (view) =>
          alive && setChoices(view.repositories.filter((r) => r.reachable).map((r) => r.fullName)),
      )
      .catch(() => alive && setChoices([]))
    return () => {
      alive = false
    }
  }, [])

  async function act(run: () => Promise<KnowledgeStatus | undefined>) {
    setBusy(true)
    setProblem(undefined)
    try {
      const next = await run()
      if (next) setStatus(next)
      onChanged()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const save = (choice: KnowledgeChoice) =>
    act(() => put<KnowledgeStatus>('/api/panel/knowledge', choice))
  const propose = () =>
    act(async () => {
      const pull = await post<{ url: string }>('/api/panel/knowledge/template')
      setProposed(pull.url)
      return get<KnowledgeStatus>('/api/panel/knowledge')
    })

  const options =
    status?.repository && !choices.includes(status.repository)
      ? [status.repository, ...choices]
      : choices

  return (
    <section
      aria-label="Base de conhecimento"
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <p className="text-muted-foreground">
        Um repositório seu que todos os agentes consultam, no sandbox e no painel. As regras ficam
        em <code>knowledge/</code> e só mudam por pull request seu. A fábrica busca o repositório a
        cada minuto e grava as próprias notas na branch{' '}
        <code>{status?.memoryBranch ?? 'factory-memory'}</code>, nunca na sua.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 flex-1">
          <span className="text-muted-foreground">Repositório</span>
          <select
            aria-label="Repositório da base de conhecimento"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground"
          >
            <option value="">Nenhum</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="w-48">
          <span className="text-muted-foreground">Branch das regras</span>
          <Input
            aria-label="Branch das regras"
            value={branch}
            placeholder="a padrão"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setBranch(e.target.value)}
            className="mt-1 font-mono"
          />
        </label>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void save({ repository: repository || null, branch: branch.trim() || null })
          }
        >
          {busy ? 'Conferindo…' : 'Salvar'}
        </Button>
      </div>

      {problem ? (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      ) : null}

      {status?.repository ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Regras</dt>
          <dd className="font-mono">
            {status.readBranch ?? status.branch ?? 'branch padrão'} @ {short(status.knowledgeSha)}
          </dd>
          <dt>Notas</dt>
          <dd className="font-mono">
            {status.memoryBranch} @ {short(status.memorySha)} · {status.writtenNotes} gravadas,{' '}
            {status.pendingNotes} esperando
          </dd>
          <dt>Última busca</dt>
          <dd>{when(status.syncedAt)}</dd>
          {status.error ? (
            <>
              <dt>Falhou</dt>
              <dd className="text-destructive">
                {status.error} ({when(status.errorAt)}). Os agentes seguem lendo o último commit
                bom.
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {status?.formatProblem ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1">
            Os agentes ainda não leem este repositório: {status.formatProblem}. A fábrica pode abrir
            um pull request com a estrutura, sem mexer no que já existe.
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void propose()}>
            Propor a estrutura
          </Button>
        </div>
      ) : null}
      {proposed ? (
        <p role="status">
          Pull request aberto:{' '}
          <a
            href={proposed}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {proposed}
          </a>
          . Depois do merge, a fábrica passa a ler o repositório em até um minuto.
        </p>
      ) : null}
    </section>
  )
}
