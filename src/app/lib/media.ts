import { useEffect, useState } from 'react'

/** Whether the screen is at least `px` wide. A browser with no way to ask is taken as wide. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}
