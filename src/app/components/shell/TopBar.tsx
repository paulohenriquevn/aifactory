import { useTheme } from '@theokit/ui'
import { Moon, Sparkles, Sun } from 'lucide-react'
import { NavLink, useLocation } from 'react-router'

import { useGuideState } from '../../lib/guide-state'
import { guideFor } from '../../lib/guides'

/** Where in the app a path is: the conversation, or the factory's own pages. */
export const inWork = (path: string) => !(path === '/' || path.startsWith('/chat/'))

const tab = (active: boolean) =>
  `rounded-full px-7 py-1.5 text-[14px] font-medium transition-colors ${active ? 'bg-background text-foreground' : 'text-foreground/60 hover:text-foreground'}`

/** The bar over the page: the two halves of the app, the guide of the page and the theme. */
export function TopBar() {
  const { mode, toggleMode } = useTheme()
  const guide = guideFor(useLocation().pathname)
  const { open, setOpen, seen } = useGuideState()
  const { pathname } = useLocation()
  const work = inWork(pathname)
  return (
    <div className="relative flex h-14 shrink-0 items-center justify-center px-4">
      <div role="tablist" aria-label="Parte do app" className="flex rounded-full bg-muted p-1">
        <NavLink to="/" role="tab" aria-selected={!work} className={tab(!work)}>
          Chat
        </NavLink>
        <NavLink to="/work" role="tab" aria-selected={work} className={tab(work)}>
          Work
        </NavLink>
      </div>
      <div className="absolute right-4 flex items-center gap-2">
        {guide ? (
          <button
            type="button"
            aria-label={open ? `Fechar o ${guide.name}` : `Abrir o ${guide.name}`}
            aria-pressed={open}
            title={guide.name}
            onClick={() => setOpen(!open)}
            className={`relative flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[14px] transition-colors ${open ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60'}`}
          >
            <Sparkles className="size-[16px]" />
            Guia
            {!seen(guide.id) ? (
              <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-sky-400" />
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={mode === 'dark' ? 'Tema claro' : 'Tema escuro'}
          onClick={toggleMode}
          className="rounded-lg p-2 text-foreground/80 hover:bg-muted/60"
        >
          {mode === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </button>
      </div>
    </div>
  )
}
