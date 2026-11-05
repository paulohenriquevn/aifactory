import { DropdownMenu } from '@usetheo/ui'
import { ArrowUp, ListChecks, Plus, Square, TriangleAlert, FilePlus2 } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

/** What the "+" offers: a way to start a message that would otherwise take a sentence to word. */
const STARTS = [
  { icon: FilePlus2, label: 'Abrir uma issue', text: 'Quero abrir uma issue para ' },
  { icon: ListChecks, label: 'Planejar um objetivo', text: 'Quero planejar este objetivo: ' },
  { icon: TriangleAlert, label: 'Ver o que travou', text: 'Quais tarefas travaram e por quê?' },
]

/**
 * The box a message is written in: one row that grows with the text, the "+" at the left, the model and
 * the send button at the right. Enter sends and Shift+Enter breaks the line.
 */
export function PillComposer({
  value,
  onValueChange,
  onSubmit,
  running,
  onStop,
  trailing,
  placeholder,
}: {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => void
  running: boolean
  onStop: () => void
  trailing?: ReactNode
  placeholder: string
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim() !== '' && !running

  // The box is one line until the text needs more, and stops growing at eight.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 8 * 24)}px`
  }, [value])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit(value)
      }}
      className="flex items-end gap-1 rounded-[28px] border border-white/10 bg-[#161617] px-2.5 py-2"
    >
      <DropdownMenu>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Mais ações"
            className="mb-0.5 shrink-0 rounded-full p-2 text-foreground/80 hover:bg-white/[0.08]"
          >
            <Plus className="size-5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" side="top" className="min-w-56">
          {STARTS.map(({ icon: Icon, label, text }) => (
            <DropdownMenu.Item
              key={label}
              onSelect={() => {
                onValueChange(text)
                requestAnimationFrame(() => box.current?.focus())
              }}
            >
              <Icon className="mr-2 size-4" />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
      <textarea
        ref={box}
        rows={1}
        value={value}
        aria-label="Mensagem"
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSend) onSubmit(value)
          }
        }}
        className="max-h-48 min-h-6 flex-1 resize-none self-center bg-transparent px-2 py-1.5 text-[15px] leading-6 text-foreground outline-none placeholder:text-foreground/45"
      />
      <div className="mb-0.5 flex shrink-0 items-center gap-1">
        {trailing}
        {running ? (
          <button
            type="button"
            aria-label="Parar"
            onClick={onStop}
            className="grid size-9 place-items-center rounded-full bg-foreground text-background"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Enviar"
            disabled={!canSend}
            className="grid size-9 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-25"
          >
            <ArrowUp className="size-[18px]" />
          </button>
        )}
      </div>
    </form>
  )
}
