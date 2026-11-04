import { useCallback, useState } from 'react'

export type View = 'board' | 'list'

const KEY = 'aifactory.view'

const read = (): View => {
  try {
    return localStorage.getItem(KEY) === 'list' ? 'list' : 'board'
  } catch {
    return 'board'
  }
}

/** Board or list, remembered for the next visit. A browser that refuses storage still switches. */
export function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(read)
  const choose = useCallback((next: View) => {
    setView(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // The choice holds for this visit only.
    }
  }, [])
  return [view, choose]
}
