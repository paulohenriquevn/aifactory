import type { AgentEntry } from '../../shared/panel'

export const GROUPS: { id: AgentEntry['group']; title: string; about: string }[] = [
  { id: 'factory', title: 'Constroem o código', about: 'Rodam num sandbox isolado' },
  {
    id: 'panel',
    title: 'Conversam com você',
    about: 'Rodam no servidor, com ferramentas limitadas',
  },
]

const norm = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** What a search looks in: the name, what the agent does, its model, its tools and every word it is told. */
function haystack(agent: AgentEntry): string {
  return norm(
    [
      agent.name,
      agent.role,
      agent.engine.value,
      ...agent.tools.map((t) => t.name),
      ...agent.prompts.flatMap((p) => [p.title, p.text]),
    ].join('\n'),
  )
}

/** The agents that mention what was typed, accents and capitals aside. An empty search keeps them all. */
export function filterAgents(agents: AgentEntry[], query: string): AgentEntry[] {
  const needle = norm(query.trim())
  return needle === '' ? agents : agents.filter((a) => haystack(a).includes(needle))
}

export type Piece = { text: string; kind: 'plain' | 'mark' | 'hit' }

/**
 * A prompt cut into pieces to draw: the ‹marks› where a task's own data goes, and the places a search matched.
 * A match inside a mark counts as a mark, so the two never overlap.
 */
export function pieces(text: string, query = ''): Piece[] {
  const needle = norm(query.trim())
  const out: Piece[] = []
  for (const part of text.split(/(‹[^›]*›)/)) {
    if (part.startsWith('‹') && part.endsWith('›')) {
      out.push({ text: part, kind: 'mark' })
      continue
    }
    if (needle === '') {
      if (part) out.push({ text: part, kind: 'plain' })
      continue
    }
    // Compare without accents, but cut the original: accents decompose to the same number of letters here.
    const folded = norm(part)
    let from = 0
    for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, from)) {
      if (at > from) out.push({ text: part.slice(from, at), kind: 'plain' })
      out.push({ text: part.slice(at, at + needle.length), kind: 'hit' })
      from = at + needle.length
    }
    if (from < part.length) out.push({ text: part.slice(from), kind: 'plain' })
  }
  return out
}

/** How many ‹marks› a prompt has: the places the data of each task goes. */
export const markCount = (text: string) => (text.match(/‹[^›]*›/g) ?? []).length
