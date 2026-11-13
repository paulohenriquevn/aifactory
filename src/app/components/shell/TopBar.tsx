import { useTheme } from '@theokit/ui'
import { Languages, Moon, Sparkles, Sun } from 'lucide-react'
import { NavLink, useLocation } from 'react-router'

import { useCopy } from '../../lib/copy'
import { useGuideState } from '../../lib/guide-state'
import { guideFor } from '../../lib/guides'

/** Where in the app a path is: the conversation, or the factory's own pages. */
export const inWork = (path: string) => !(path === '/' || path.startsWith('/chat/'))

const tab = (active: boolean) =>
  `rounded-full px-7 py-1.5 text-[14px] font-medium transition-colors ${active ? 'bg-background text-foreground' : 'text-foreground/60 hover:text-foreground'}`

/** The bar over the page: the two halves of the app, the guide of the page and the theme. */
export function TopBar() {
  const { mode, toggleMode } = useTheme()
  const { t, language, setLanguage } = useCopy()
  const guide = guideFor(useLocation().pathname)
  const { open, setOpen, seen } = useGuideState()
  const { pathname } = useLocation()
  const work = inWork(pathname)
  return (
    <div className="relative flex h-14 shrink-0 items-center justify-center px-4">
      <div role="tablist" aria-label={t.topBar.part} className="flex rounded-full bg-muted p-1">
        <NavLink to="/" role="tab" aria-selected={!work} className={tab(!work)}>
          {t.topBar.chat}
        </NavLink>
        <NavLink to="/work" role="tab" aria-selected={work} className={tab(work)}>
          {t.topBar.work}
        </NavLink>
      </div>
      <div className="absolute right-4 flex items-center gap-2">
        {guide ? (
          <button
            type="button"
            aria-label={open ? t.topBar.closeGuide(guide.name) : t.topBar.openGuide(guide.name)}
            aria-pressed={open}
            title={guide.name}
            onClick={() => setOpen(!open)}
            className={`relative flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[14px] transition-colors ${open ? 'bg-muted text-foreground' : 'text-foreground/80 hover:bg-muted/60'}`}
          >
            <Sparkles className="size-[16px]" />
            {t.topBar.guide}
            {!seen(guide.id) ? (
              <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-sky-400" />
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t.topBar.switchLanguage}
          title={t.topBar.switchLanguage}
          onClick={() => setLanguage(language === 'en' ? 'pt-BR' : 'en')}
          className="flex items-center gap-1.5 rounded-lg p-2 text-[13px] text-foreground/80 hover:bg-muted/60"
        >
          <Languages className="size-[18px]" />
          {t.topBar.languageName}
        </button>
        <button
          type="button"
          aria-label={mode === 'dark' ? t.topBar.lightTheme : t.topBar.darkTheme}
          onClick={toggleMode}
          className="rounded-lg p-2 text-foreground/80 hover:bg-muted/60"
        >
          {mode === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </button>
      </div>
    </div>
  )
}
