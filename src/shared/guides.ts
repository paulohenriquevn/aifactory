/**
 * The specialists of the panel: one for each place in the menu that is not the chat. The list is shared
 * because the page picks a guide by the place the owner is in, and the server builds one agent for each.
 */
export const GUIDE_IDS = ['board', 'plans', 'repositories', 'inbox', 'health', 'setup'] as const

export type GuideId = (typeof GUIDE_IDS)[number]

/** Where the agent of a guide is served: one per model, as for the chat. */
export const guidePath = (id: GuideId, model: 'openrouter' | 'codex' = 'openrouter') =>
  `/api/agents/guide-${id}${model === 'codex' ? '-codex' : ''}`
