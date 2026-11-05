import { Avatar, DropdownMenu } from '@usetheo/ui'
import {
  Factory,
  FolderGit2,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  PanelLeft,
  Pin,
  Search,
  Settings2,
  SquarePen,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { NavLink, useNavigate } from 'react-router'

type Icon = ComponentType<{ className?: string }>

const button =
  'relative grid size-9 place-items-center rounded-lg text-foreground/90 transition-colors hover:bg-white/[0.08]'

/** A place of the factory, as an icon: its name is the tooltip and the label a screen reader reads. */
function Place({
  to,
  icon: Icon,
  label,
  dot,
}: {
  to: string
  icon: Icon
  label: string
  dot?: boolean
}) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      className={({ isActive }) => `${button} ${isActive ? 'bg-white/[0.09]' : ''}`}
    >
      <Icon className="size-5" />
      {dot ? (
        <span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-sky-400" />
      ) : null}
    </NavLink>
  )
}

/**
 * The menu when it is folded: a narrow strip of icons, the way it looks in the app it is modelled on. The
 * logo brings the whole menu back (and shows the fold icon while the pointer is over it); search, pinned and
 * conversations open the menu too, because that is where they are; the places of the factory stay one
 * click away; the account stays at the bottom.
 */
export function Rail({
  onExpand,
  waiting,
  wrong,
  name,
  onSignOut,
}: {
  onExpand: (search?: boolean) => void
  waiting: number
  wrong: number
  name: string
  onSignOut: () => void
}) {
  const navigate = useNavigate()
  return (
    <aside
      aria-label="Menu recolhido"
      className="flex h-full w-[52px] shrink-0 flex-col items-center border-r border-white/[0.08] bg-[#0a0a0b] py-2.5"
    >
      <button
        type="button"
        aria-label="Mostrar o menu"
        title="Mostrar o menu"
        onClick={() => onExpand()}
        className={`group ${button} mb-1`}
      >
        <Factory className="size-6 group-hover:hidden" />
        <PanelLeft className="hidden size-5 group-hover:block" />
      </button>

      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          aria-label="Novo chat"
          title="Novo chat"
          onClick={() => void navigate('/', { state: { fresh: Date.now() } })}
          className={`${button} bg-white/[0.09]`}
        >
          <SquarePen className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Buscar conversas"
          title="Buscar conversas"
          onClick={() => onExpand(true)}
          className={button}
        >
          <Search className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Fixados"
          title="Fixados"
          onClick={() => onExpand()}
          className={button}
        >
          <Pin className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Conversas"
          title="Conversas"
          onClick={() => onExpand()}
          className={button}
        >
          <MessageCircle className="size-5" />
        </button>
      </div>

      <nav
        aria-label="Principal"
        className="mt-3 flex flex-col items-center gap-1 border-t border-white/[0.08] pt-3"
      >
        <Place to="/work" icon={LayoutDashboard} label="Quadro" />
        <Place to="/plans" icon={ListChecks} label="Planos" />
        <Place to="/repositories" icon={FolderGit2} label="Repositórios" />
        <Place to="/inbox" icon={Inbox} label="Caixa de entrada" dot={waiting > 0} />
        <Place to="/health" icon={HeartPulse} label="Saúde" dot={wrong > 0} />
        <Place to="/setup" icon={Settings2} label="Configuração" />
      </nav>

      <div className="mt-auto">
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Conta"
              title={name}
              className="grid size-9 place-items-center rounded-full hover:bg-white/[0.08]"
            >
              <Avatar className="size-8 text-xs">
                <Avatar.Fallback>{name.slice(0, 2).toUpperCase()}</Avatar.Fallback>
              </Avatar>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" side="right" className="min-w-40">
            <DropdownMenu.Item onSelect={onSignOut}>Sair</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </aside>
  )
}
