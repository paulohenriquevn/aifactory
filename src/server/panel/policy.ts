import type { RoutePolicyInput } from 'theokit/server/define'

/** Only the signed-in owner. Everything under /api/panel uses it except the login itself. */
export const ownerOnly = ({ subject }: RoutePolicyInput) =>
  subject?.id === 'owner' ? true : { allowed: false as const, reason: 'sign in to the panel' }
