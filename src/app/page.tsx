import { useLocation } from 'react-router'
import { Metadata } from 'theokit/client'

import { ChatView } from './components/chat/ChatView'

/** The empty conversation: where the owner starts, or goes back to, a new chat. */
export default function Page() {
  // A new chat from the menu changes this state, which is what starts the empty conversation over.
  const { state } = useLocation() as { state: { fresh?: number } | null }
  return (
    <>
      <Metadata title="aifactory" description="Converse com a fábrica." />
      <ChatView key={state?.fresh ?? 'new'} />
    </>
  )
}
