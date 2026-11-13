import './globals.css'

import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'

import type { HealthReport, InboxItem } from '../shared/panel'

import { GuidePanel } from './components/guide/GuidePanel'
import { Rail } from './components/shell/Rail'
import { Sidebar } from './components/shell/Sidebar'
import { inWork, TopBar } from './components/shell/TopBar'
import { post } from './lib/api'
import { ChatsProvider } from './lib/chats'
import { GuideProvider } from './lib/guide-state'
import { useResource } from './lib/live'

const HIDDEN_KEY = 'aifactory.menu.hidden'

/** Whether the owner hid the menu last time, kept in the browser. */
function useMenuHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, set] = useState(() => {
    try {
      return window.localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  return [
    hidden,
    (next) => {
      set(next)
      try {
        window.localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
      } catch {
        // A browser that keeps nothing still has a menu that works for this visit.
      }
    },
  ]
}

/** The frame of every page: the menu on the left, the bar on top, and the way to the login. */
export default function RootLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const onLogin = location.pathname === '/login'
  const me = useResource<{ owner: boolean; name?: string }>('/api/panel/me', { everyMs: 60_000 })
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const health = useResource<HealthReport>('/api/panel/health', { everyMs: 60_000 })
  const [menuHidden, setMenuHidden] = useMenuHidden()
  const [searchOnOpen, setSearchOnOpen] = useState(false)

  useEffect(() => {
    if (me.data && !me.data.owner && !onLogin) void navigate('/login', { replace: true })
  }, [me.data, onLogin, navigate])

  const signedIn = me.data?.owner === true
  const signOut = () =>
    void post('/api/panel/logout').then(() => {
      me.reload()
      void navigate('/login')
    })

  return (
    <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
      <ChatsProvider enabled={signedIn}>
        <GuideProvider>
          <div className="flex h-screen bg-background text-foreground">
            {signedIn ? (
              menuHidden ? (
                <Rail
                  onExpand={(search = false) => {
                    setSearchOnOpen(search)
                    setMenuHidden(false)
                  }}
                  waiting={inbox.data?.items.length ?? 0}
                  wrong={health.data?.findings.length ?? 0}
                  name={me.data?.name ?? 'dono'}
                  onSignOut={signOut}
                />
              ) : (
                <Sidebar
                  onToggle={() => {
                    setSearchOnOpen(false)
                    setMenuHidden(true)
                  }}
                  startSearching={searchOnOpen}
                  waiting={inbox.data?.items.length ?? 0}
                  wrong={health.data?.findings.length ?? 0}
                  name={me.data?.name ?? 'dono'}
                  plan="dono da fábrica"
                  onSignOut={signOut}
                />
              )
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              {signedIn ? <TopBar /> : null}
              <main className="min-h-0 flex-1 overflow-y-auto">
                {signedIn && inWork(location.pathname) ? (
                  <div className="mx-auto max-w-[1800px] px-6 pb-10 pt-2">
                    <Outlet />
                  </div>
                ) : signedIn || onLogin ? (
                  <Outlet />
                ) : (
                  <p className="p-6 text-sm text-muted-foreground">Carregando…</p>
                )}
              </main>
            </div>
            {signedIn ? <GuidePanel /> : null}
          </div>
        </GuideProvider>
      </ChatsProvider>
    </ThemeProvider>
  )
}
