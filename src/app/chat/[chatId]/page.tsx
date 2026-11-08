import { useParams } from 'react-router'
import { Metadata } from 'theokit/client'

import { ChatView } from '../../components/chat/ChatView'

/** A conversation that was kept, reopened with what was said in it. */
export default function Page() {
  const { chatId } = useParams()
  return (
    <>
      <Metadata title="aifactory" description="Converse com a fábrica." />
      <ChatView key={chatId} chatId={chatId} />
    </>
  )
}
