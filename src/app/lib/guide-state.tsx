import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

import type { GuideId } from '../../shared/guides'
import type { ChatModel } from '../../shared/panel'

const OPEN_KEY = 'aifactory.guide.open'
const SEEN_KEY = 'aifactory.guide.seen'
const MODEL_KEY = 'aifactory.guide.model'

export type GuideState = {
  open: boolean
  setOpen: (open: boolean) => void
  /** The model a guide starts on: the one the owner used last. */
  model: ChatModel
  setModel: (model: ChatModel) => void
  /** Whether the owner has opened the guide of this page before. */
  seen: (id: GuideId) => boolean
  markSeen: (id: GuideId) => void
}

const Context = createContext<GuideState>({
  open: false,
  setOpen: () => {},
  model: 'openrouter',
  setModel: () => {},
  seen: () => true,
  markSeen: () => {},
})

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A browser that keeps nothing still has a guide that works for this visit.
  }
}

function readSeen(): GuideId[] {
  try {
    const parsed: unknown = JSON.parse(read(SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as GuideId[]) : []
  } catch {
    return []
  }
}

/** Whether the guide is open and which ones the owner has met, kept in the browser. */
export function GuideProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(() => read(OPEN_KEY) === '1')
  const [seen, setSeen] = useState<GuideId[]>(readSeen)
  const [model, setModelState] = useState<ChatModel>(() =>
    read(MODEL_KEY) === 'codex' ? 'codex' : 'openrouter',
  )

  const value = useMemo<GuideState>(
    () => ({
      open,
      setOpen: (next) => {
        setOpenState(next)
        write(OPEN_KEY, next ? '1' : '0')
      },
      model,
      setModel: (next) => {
        setModelState(next)
        write(MODEL_KEY, next)
      },
      seen: (id) => seen.includes(id),
      markSeen: (id) =>
        setSeen((current) => {
          if (current.includes(id)) return current
          const next = [...current, id]
          write(SEEN_KEY, JSON.stringify(next))
          return next
        }),
    }),
    [open, seen, model],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export const useGuideState = () => useContext(Context)
