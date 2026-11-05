import { Avatar, DropdownMenu, ScrollArea } from '@usetheo/ui'
import {
  FolderGit2,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings2,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router'

import type { GuideId } from '../../../shared/guides'
import type { ChatSummary } from '../../../shared/panel'
import { chatApi, groupChats } from '../../lib/chat'
import { useChats } from '../../lib/chats'

import { ACTIVE, useOnNewChat, usePlace } from './active'

type Icon = ComponentType<{ className?: string }>

const row =
  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-foreground/90 transition-colors hover:bg-white/[0.06]'

/** One place in the factory, in the menu: an icon, a name, and a count when something is waiting. */
function Place({
  id,
  to,
  icon: Icon,
  label,
  count,
}: {
  id: GuideId
  to: string
  icon: Icon
  label: string
  count?: number
}) {
  const active = usePlace() === id
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`${row} ${active ? ACTIVE : ''}`}
    >
      <Icon className={`size-[18px] shrink-0 ${active ? '' : 'opacity-90'}`} />
      <span className="truncate">{label}</span>
      {count ? (
        <span className="ml-auto rounded-full bg-white/10 px-2 text-xs text-foreground/80">
          {count}
        </span>
      ) : null}
    </Link>
  )
}

/** A conversation in the list, with the menu to pin, rename and delete it. */
function ChatRow({ chat }: { chat: ChatSummary }) {
  const { chatId } = useParams()
  const navigate = useNavigate()
  const { reload } = useChats()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(chat.title)
  const active = chatId === chat.id
  const title = chat.title || 'Novo chat'

  async function rename() {
    setEditing(false)
    const next = name.trim()
    if (next !== '' && next !== chat.title) await chatApi.patch(chat.id, { title: next })
    reload()
  }

  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Nome da conversa"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void rename()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="w-full rounded-lg bg-white/10 px-3 py-2 text-[14px] text-foreground outline-none"
      />
    )
  }

  return (
    <div className={`group relative rounded-lg ${active ? ACTIVE : 'hover:bg-white/[0.06]'}`}>
      <NavLink
        to={`/chat/${chat.id}`}
        className="block truncate px-3 py-2 pr-9 text-[14px] text-foreground/90"
      >
        {title}
      </NavLink>
      <DropdownMenu>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Opções de ${title}`}
            className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-foreground/70 hover:bg-white/10 group-hover:block data-[state=open]:block"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" className="min-w-40">
          <DropdownMenu.Item
            onSelect={() => void chatApi.patch(chat.id, { pinned: !chat.pinned }).then(reload)}
          >
            {chat.pinned ? <PinOff className="mr-2 size-4" /> : <Pin className="mr-2 size-4" />}
            {chat.pinned ? 'Desafixar' : 'Fixar'}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setEditing(true)}>
            <Pencil className="mr-2 size-4" />
            Renomear
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            className="text-destructive"
            onSelect={() => {
              if (!window.confirm(`Apagar "${title}"?`)) return
              void chatApi.remove(chat.id).then(() => {
                reload()
                if (active) void navigate('/')
              })
            }}
          >
            <Trash2 className="mr-2 size-4" />
            Apagar
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty?: string
  children?: React.ReactNode
}) {
  return (
    <div className="mt-5">
      <h2 className="px-3 pb-1 text-[14px] text-foreground/60">{title}</h2>
      {children ??
        (empty ? <p className="px-3 py-2 text-[14px] text-foreground/35">{empty}</p> : null)}
    </div>
  )
}

/** The menu on the left: the way to a new conversation, to each part of the factory, and the past chats. */
export function Sidebar({
  onToggle,
  waiting,
  wrong,
  name,
  plan,
  onSignOut,
  startSearching = false,
}: {
  onToggle: () => void
  waiting: number
  wrong: number
  name: string
  plan: string
  onSignOut: () => void
  /** Open with the search box showing, when the owner came from the folded menu's search. */
  startSearching?: boolean
}) {
  const { chats } = useChats()
  const navigate = useNavigate()
  const onNewChat = useOnNewChat()
  const [searching, setSearching] = useState(startSearching)
  const [filter, setFilter] = useState('')
  const { pinned, recent } = groupChats(chats, filter)

  return (
    <aside
      aria-label="Menu"
      className="flex h-full w-[338px] max-w-[40vw] shrink-0 flex-col border-r border-white/[0.08] bg-[#0a0a0b]"
    >
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="text-[17px] font-semibold tracking-tight">aifactory</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Buscar conversas"
            onClick={() => setSearching((on) => !on)}
            className="rounded-lg p-2 text-foreground/80 hover:bg-white/[0.08]"
          >
            <Search className="size-[18px]" />
          </button>
          <button
            type="button"
            aria-label="Recolher o menu"
            onClick={onToggle}
            className="rounded-lg p-2 text-foreground/80 hover:bg-white/[0.08]"
          >
            <PanelLeft className="size-[18px]" />
          </button>
        </div>
      </div>

      <nav aria-label="Principal" className="px-2">
        <Link
          to="/"
          aria-current={onNewChat ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault()
            void navigate('/', { state: { fresh: Date.now() } })
          }}
          className={`${row} ${onNewChat ? ACTIVE : ''}`}
        >
          <SquarePen className="size-[18px] shrink-0" />
          Novo chat
        </Link>
        <div className="mt-3 space-y-0.5">
          <Place id="board" to="/work" icon={LayoutDashboard} label="Quadro" />
          <Place id="plans" to="/plans" icon={ListChecks} label="Planos" />
          <Place id="repositories" to="/repositories" icon={FolderGit2} label="Repositórios" />
          <Place id="inbox" to="/inbox" icon={Inbox} label="Caixa de entrada" count={waiting} />
          <Place id="health" to="/health" icon={HeartPulse} label="Saúde" count={wrong} />
          <Place id="setup" to="/setup" icon={Settings2} label="Configuração" />
        </div>
      </nav>

      {searching ? (
        <div className="px-4 pt-3">
          <input
            autoFocus
            aria-label="Buscar nas conversas"
            placeholder="Buscar nas conversas"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded-lg bg-white/[0.08] px-3 py-2 text-[14px] outline-none placeholder:text-foreground/40"
          />
        </div>
      ) : null}

      <ScrollArea className="mt-1 min-h-0 flex-1 px-2">
        {pinned.length > 0 ? (
          <Section title="Fixados">
            {pinned.map((c) => (
              <ChatRow key={c.id} chat={c} />
            ))}
          </Section>
        ) : null}
        <Section
          title="Recentes"
          empty={filter ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}
        >
          {recent.length > 0 ? recent.map((c) => <ChatRow key={c.id} chat={c} />) : undefined}
        </Section>
      </ScrollArea>

      <div className="border-t border-white/[0.08] p-2">
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="Conta" className={`${row} gap-3 py-2`}>
              <Avatar className="size-8 text-xs">
                <Avatar.Fallback>{name.slice(0, 2).toUpperCase()}</Avatar.Fallback>
              </Avatar>
              <span className="min-w-0">
                <span className="block truncate text-[14px]">{name}</span>
                <span className="block truncate text-xs text-foreground/50">{plan}</span>
              </span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" side="top" className="min-w-52">
            <DropdownMenu.Item onSelect={onSignOut}>Sair</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </aside>
  )
}
