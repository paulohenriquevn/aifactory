import { parse, stringify } from 'yaml'

/**
 * The Open Knowledge Format, version 0.2: what the factory writes and how it reads a bundle someone else
 * wrote. The specification is https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
 * (read at commit ad30107). A bundle is a folder of markdown files, each a concept with YAML front matter
 * whose only required key is `type`; `index.md` and `log.md` are reserved at every level.
 *
 * The factory is a strict producer and a tolerant consumer, as the specification asks (§11): it writes only
 * conformant files, and it reads a bundle with missing front matter, unknown types or broken links, saying
 * what does not conform instead of refusing it.
 */
export const OKF_VERSION = '0.2'

const RESERVED = new Set(['index.md', 'log.md'])
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export type Frontmatter = Record<string, unknown>

/** One markdown file read as a concept, with what keeps it from conforming when something does. */
export type Concept = { frontmatter?: Frontmatter; body: string; problem?: string }

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Whether a path is one of the reserved files, at any level. */
export const isReserved = (path: string) => RESERVED.has(baseName(path))

/** Whether a path is a concept document: a markdown file that is not reserved. */
export const isConceptPath = (path: string) => /\.md$/i.test(path) && !isReserved(path)

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]

/** Whether a text starts with a closed `---` block. */
export const hasFrontMatter = (text: string) => FENCE.test(text)

/** The YAML of a leading `---` block, or why it is not a mapping. Undefined when there is no block. */
function leadingYaml(
  text: string,
): { data?: Frontmatter; body: string; problem?: string } | undefined {
  const match = FENCE.exec(text)
  if (!match) return undefined
  const body = text.slice(match[0].length)
  let data: unknown
  try {
    data = parse(match[1])
  } catch (error) {
    return { body, problem: `has front matter that is not YAML (${firstLine(error)})` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { body, problem: 'has front matter that is not a mapping' }
  }
  return { data: data as Frontmatter, body }
}

/** A concept document: its front matter and body, and why it does not conform when it does not. */
export function readConcept(text: string): Concept {
  const block = leadingYaml(text)
  if (!block) return { body: text, problem: 'has no front matter' }
  if (!block.data) return { body: block.body, problem: block.problem }
  const type = block.data.type
  if (typeof type !== 'string' || type.trim() === '') {
    return { frontmatter: block.data, body: block.body, problem: 'has no type in its front matter' }
  }
  return { frontmatter: block.data, body: block.body }
}

/** A front matter value as text, when it is a string or a number. */
export function textField(frontmatter: Frontmatter | undefined, key: string): string | undefined {
  const value = frontmatter?.[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/** Why the root `index.md` does not declare this version, or nothing when it does. */
export function rootIndexProblem(text: string | undefined): string | undefined {
  if (text === undefined) return 'index.md is missing at the root'
  const block = leadingYaml(text)
  if (block?.problem) return `index.md at the root ${block.problem}`
  const version = textField(block?.data, 'okf_version')
  if (version === undefined) return 'index.md at the root does not say okf_version'
  if (version !== OKF_VERSION) {
    return `index.md at the root says okf_version ${version}; the factory writes ${OKF_VERSION}`
  }
  return undefined
}

/** What in a bundle does not conform: the root index, then each concept document, in the order given. */
export function conformance(
  rootIndex: string | undefined,
  files: { path: string; text: string }[],
): string[] {
  const problems: string[] = []
  const root = rootIndexProblem(rootIndex)
  if (root) problems.push(root)
  for (const file of files) {
    if (!isConceptPath(file.path)) continue
    const problem = readConcept(file.text).problem
    if (problem) problems.push(`${file.path} ${problem}`)
  }
  return problems
}

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/**
 * The trust tier of a concept (§5.3): unverified without `verified`, human-reviewed once a `human:` actor
 * verified it, machine-confirmed otherwise. A single mapping counts as a list of one (§5.2).
 */
export function trustTier(frontmatter: Frontmatter | undefined): TrustTier {
  const verified = frontmatter?.verified
  const events: unknown[] = Array.isArray(verified) ? verified : [verified]
  const actors = events
    .map((event) => (event as { by?: unknown } | null)?.by)
    .filter((by): by is string => typeof by === 'string')
  if (actors.length === 0) return 'unverified'
  return actors.some((by) => by.startsWith('human:')) ? 'human-reviewed' : 'machine-confirmed'
}

/** A concept document: the front matter as YAML, whatever its values hold, then the body. */
export function renderConcept(frontmatter: Frontmatter, body: string): string {
  return `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body.trim()}\n`
}

export type IndexEntry = { title: string; href: string; description?: string }
export type IndexSection = { heading: string; entries: IndexEntry[] }

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** One list item of an index (§8): `* [title](href) - description`. */
export function indexLine(entry: IndexEntry): string {
  const title = oneLine(entry.title).replace(/[[\]\\]/g, (c) => `\\${c}`)
  const description = entry.description ? oneLine(entry.description) : ''
  return `* [${title}](${encodeURI(entry.href)})${description ? ` - ${description}` : ''}`
}

/**
 * An `index.md` (§8): sections of links, and no front matter but `okf_version` at the root of a bundle.
 */
export function renderIndex(sections: IndexSection[], options: { root?: boolean } = {}): string {
  const lines = options.root ? ['---', `okf_version: "${OKF_VERSION}"`, '---', ''] : []
  for (const section of sections) {
    lines.push(`# ${oneLine(section.heading)}`, '', ...section.entries.map(indexLine), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * A `log.md` (§9) with entries added under the day they happened, newest day first. A log that already
 * has a section for the day gets the entries at the top of it; any other text is kept as it was.
 */
export function logWith(
  existing: string | undefined,
  title: string,
  date: string,
  entries: string[],
): string {
  const items = entries.map((entry) => `* ${oneLine(entry)}`)
  const heading = `## ${date}`
  if (existing === undefined) return [`# ${oneLine(title)}`, '', heading, ...items, ''].join('\n')
  const rows = existing.trimEnd().split('\n')
  const first = rows.findIndex((row) => row.startsWith('## '))
  if (first === -1) rows.push('', heading, ...items)
  else if (rows[first] === heading) rows.splice(first + 1, 0, ...items)
  else rows.splice(first, 0, heading, ...items, '')
  return `${rows.join('\n')}\n`
}
