import './globals.css'

import { ThemeProvider, ThemeSwitcher, builtinThemes } from '@theokit/ui'
import { Button } from '@usetheo/ui'
import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import type { HealthReport, InboxItem } from '../shared/panel'

import { post } from './lib/api'
import { useResource } from './lib/live'

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'}`

/** The frame of every page: the nav, and the way to the login for someone who is not signed in. */
export default function RootLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const onLogin = location.pathname === '/login'
  const me = useResource<{ owner: boolean }>('/api/panel/me', { everyMs: 60_000 })
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const health = useResource<HealthReport>('/api/panel/health', { everyMs: 60_000 })

  useEffect(() => {
    if (me.data && !me.data.owner && !onLogin) void navigate('/login', { replace: true })
  }, [me.data, onLogin, navigate])

  const waiting = inbox.data?.items.length ?? 0
  const wrong = health.data?.findings.length ?? 0

  return (
    <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
            <span className="font-semibold">aifactory</span>
            {me.data?.owner ? (
              <>
                <nav className="flex gap-1" aria-label="Main">
                  <NavLink to="/" end className={link}>
                    Board
                  </NavLink>
                  <NavLink to="/plans" className={link}>
                    Plans
                  </NavLink>
                  <NavLink to="/repositories" className={link}>
                    Repositories
                  </NavLink>
                  <NavLink to="/inbox" className={link}>
                    Inbox{waiting > 0 ? ` (${waiting})` : ''}
                  </NavLink>
                  <NavLink to="/health" className={link}>
                    Health{wrong > 0 ? ` (${wrong})` : ''}
                  </NavLink>
                  <NavLink to="/setup" className={link}>
                    Setup
                  </NavLink>
                </nav>
                <div className="ml-auto flex items-center gap-2">
                  <ThemeSwitcher showModeToggle />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void post('/api/panel/logout').then(() => {
                        me.reload()
                        void navigate('/login')
                      })
                    }
                  >
                    Sign out
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">
          {me.data?.owner || onLogin ? (
            <Outlet />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </main>
      </div>
    </ThemeProvider>
  )
}
