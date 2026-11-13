import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

import { en, type Copy } from './en'
import { ptBR } from './pt-BR'

export type Language = 'en' | 'pt-BR'

export const LANGUAGE_KEY = 'aifactory.language'

export const DICTIONARIES: Record<Language, Copy> = { en, 'pt-BR': ptBR }

/** The language to start in: what the owner chose, then the browser's, then English. */
export function detectLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_KEY)
    if (stored === 'en' || stored === 'pt-BR') return stored
  } catch {
    // A browser that keeps nothing falls through to the browser's language.
  }
  const browser = typeof navigator === 'undefined' ? '' : (navigator.language ?? '')
  return browser.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
}

export type CopyState = {
  t: Copy
  language: Language
  setLanguage: (language: Language) => void
}

const Context = createContext<CopyState>({ t: en, language: 'en', setLanguage: () => {} })

/** Gives the panel its text in the owner's language and remembers the choice in the browser. */
export function CopyProvider({ children }: { children: ReactNode }) {
  const [language, set] = useState<Language>(detectLanguage)
  const value = useMemo<CopyState>(
    () => ({
      t: DICTIONARIES[language],
      language,
      setLanguage: (next) => {
        set(next)
        try {
          window.localStorage.setItem(LANGUAGE_KEY, next)
        } catch {
          // The choice holds for this visit even when the browser keeps nothing.
        }
      },
    }),
    [language],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useCopy(): CopyState {
  return useContext(Context)
}
