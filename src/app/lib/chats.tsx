import { createContext, useContext, useMemo, type ReactNode } from 'react'

import type { ChatSummary } from '../../shared/panel'

import { useResource } from './live'

type Chats = { chats: ChatSummary[]; reload: () => void }

const Context = createContext<Chats>({ chats: [], reload: () => {} })

/** The conversations, loaded once for the whole page: the side menu lists them, the chat updates them. */
export function ChatsProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  // Nothing to load for someone who is not signed in: the call would only be refused.
  const { data, reload } = useResource<{ chats: ChatSummary[] }>(
    enabled ? '/api/panel/chats' : '/api/panel/me',
    { stream: false, everyMs: 60_000 },
  )
  const value = useMemo(
    () => ({ chats: enabled && data && 'chats' in data ? data.chats : [], reload }),
    [enabled, data, reload],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export const useChats = () => useContext(Context)
