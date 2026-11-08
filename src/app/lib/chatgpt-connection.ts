import { useCallback, useEffect, useState } from 'react'

import type { ChatModel } from '../../shared/panel'

import { get } from './api'
import type { Connection } from './chat'

/** Whether the owner still has to connect the ChatGPT subscription before this model can answer. */
export function useChatgptConnection(model: ChatModel) {
  const [connection, setConnection] = useState<Connection>()
  const recheck = useCallback(() => {
    void get<Connection>('/api/panel/chat/connection').then(setConnection)
  }, [])
  useEffect(() => {
    if (model === 'codex') recheck()
  }, [model, recheck])
  return {
    needsConnection: model === 'codex' && connection !== undefined && !connection.connected,
    recheck,
  }
}
