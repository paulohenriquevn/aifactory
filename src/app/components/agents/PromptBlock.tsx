import { Button } from '@usetheo/ui'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import type { AgentPrompt } from '../../../shared/panel'
import { markCount, pieces } from '../../lib/agents'

const STYLE = {
  plain: '',
  mark: 'rounded bg-sky-400/15 px-0.5 text-sky-300',
  hit: 'rounded bg-yellow-300/30 text-foreground',
} as const

/**
 * One block of instructions, whole, in a box that can be read and copied. The ‹marks› of a template are
 * coloured, so it is clear which parts are the same every time and which are filled in for each task.
 */
export function PromptBlock({ prompt, query }: { prompt: AgentPrompt; query: string }) {
  const [copied, setCopied] = useState(false)
  const marks = markCount(prompt.text)

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // A browser that refuses the clipboard leaves the text there to select by hand.
    }
  }

  return (
    <section aria-label={prompt.title} className="rounded-xl border border-border bg-card">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{prompt.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{prompt.when}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copy()}
          aria-label={`Copiar: ${prompt.title}`}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </header>
      <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-foreground/90">
        {pieces(prompt.text, query).map((piece, i) => (
          <span key={i} className={STYLE[piece.kind]}>
            {piece.text}
          </span>
        ))}
      </pre>
      {prompt.template ? (
        <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Modelo: o que está em <span className={STYLE.mark}>‹azul›</span> muda a cada tarefa (
          {marks} {marks === 1 ? 'lugar' : 'lugares'}); o resto é igual sempre.
        </footer>
      ) : null}
    </section>
  )
}
