import { Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'

import type { GuideId } from '../../../shared/guides'
import { guideFor, GUIDES } from '../../lib/guides'
import { useGuideState } from '../../lib/guide-state'
import { useEscape } from '../../lib/keys'
import { useMinWidth } from '../../lib/media'

import { GuideThread } from './GuideThread'

/**
 * The specialist of the page, beside it. It opens from the bar over the page, takes the width of a column
 * on a wide screen and covers the page on a narrow one, and the page stays where it is. Each guide is
 * started the first time it is opened and then kept, so going to another page and back loses nothing.
 */
export function GuidePanel() {
  const { pathname, search } = useLocation()
  const { open, setOpen, markSeen } = useGuideState()
  const guide = guideFor(pathname)
  const [started, setStarted] = useState<GuideId[]>([])
  const shown = open && guide !== undefined
  // Beside the page when there is room, over it when there is not.
  const wide = useMinWidth(1100)

  useEffect(() => {
    if (!shown || !guide) return
    markSeen(guide.id)
    setStarted((current) => (current.includes(guide.id) ? current : [...current, guide.id]))
  }, [shown, guide, markSeen])

  useEscape(() => {
    if (shown) setOpen(false)
  })

  if (!shown || !guide) return null
  return (
    <aside
      aria-label={guide.name}
      className={`flex flex-col border-l border-white/[0.08] bg-[#0a0a0b] ${wide ? 'relative w-[400px] shrink-0' : 'fixed inset-y-0 right-0 z-40 w-[min(420px,100vw)] shadow-2xl'}`}
    >
      <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.08]">
          <Sparkles className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-medium">{guide.name}</h2>
          <p className="truncate text-xs text-foreground/55">Explica e ajusta esta página</p>
        </div>
        <button
          type="button"
          aria-label="Fechar o guia"
          onClick={() => setOpen(false)}
          className="rounded-lg p-2 text-foreground/80 hover:bg-white/[0.08]"
        >
          <X className="size-[18px]" />
        </button>
      </header>
      {started.map((id) => (
        <GuideThread
          key={id}
          guide={GUIDES[id]}
          active={id === guide.id}
          pathname={pathname}
          search={search}
        />
      ))}
    </aside>
  )
}
