import { DropdownMenu } from '@usetheo/ui'
import { Check, ChevronDown } from 'lucide-react'

import type { ChatModel } from '../../../shared/panel'
import { MODELS } from '../../lib/chat'

/** Which agent answers, as a small menu in the composer. */
export function ModelPicker({
  model,
  onChange,
}: {
  model: ChatModel
  onChange: (model: ChatModel) => void
}) {
  const current = MODELS.find((m) => m.id === model) ?? MODELS[0]
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Modelo"
          className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[14px] text-foreground/80 hover:bg-muted/60"
        >
          {current.name}
          <ChevronDown className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" side="top" className="min-w-64">
        {MODELS.map((m) => (
          <DropdownMenu.Item key={m.id} onSelect={() => onChange(m.id)} className="items-start">
            <span className="flex-1">
              <span className="block text-[14px]">{m.name}</span>
              <span className="block text-xs text-foreground/50">{m.blurb}</span>
            </span>
            {m.id === model ? <Check className="ml-3 mt-0.5 size-4" /> : null}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
