import { useLocation } from 'react-router'

import type { GuideId } from '../../../shared/guides'
import { guideFor } from '../../lib/guides'

/** How the item of the menu the owner is in looks: clearly lighter than a hover, and heavier in weight. */
export const ACTIVE = 'bg-muted text-foreground font-medium'

/**
 * The place of the factory the owner is in, which is the one to mark in the menu. A page inside a place
 * (a task, a plan) belongs to it, so it is read from the same table the guides use and not from the exact
 * address of the link.
 */
export function usePlace(): GuideId | undefined {
  return guideFor(useLocation().pathname)?.id
}

/** Whether the owner is on the empty conversation, the one "Novo chat" leads to. */
export function useOnNewChat(): boolean {
  return useLocation().pathname === '/'
}
