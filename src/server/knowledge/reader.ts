import type { Database } from '../db'

import { SLICE_MAX_FILE_BYTES } from './format'
import { Mirror, mirrorDir } from './mirror'
import { knowledgeRoot } from './source'
import { currentPin, type Pin } from './store'

const READABLE = /\.(md|markdown|txt|json|ya?ml)$/i
const MAX_HITS = 30
const MAX_FILES = 2_000
const READ_MAX_CHARS = 60_000

export const NO_KNOWLEDGE =
  'No knowledge base is ready: the owner chooses a knowledge repository on the Setup page, and it is read once its MEMORY.md is in the format.'

/** A file of the base and the layer it belongs to: a rule (knowledge/) or a note (memory/). */
const layer = (path: string) => (path.startsWith('memory/') ? 'note, a hint' : 'rule')

/**
 * The knowledge base as the assistants of the panel read it: the mirror, at the commits of the last sync,
 * so it is never more than a minute old. The notes live on the memory branch, the rest on the rules branch.
 */
export class KnowledgeReader {
  constructor(
    private readonly db: Database,
    private readonly root: string = knowledgeRoot(),
  ) {}

  private async open(): Promise<{ pin: Pin; mirror: Mirror } | undefined> {
    const pin = await currentPin(this.db)
    return pin ? { pin, mirror: new Mirror(mirrorDir(this.root, pin.repository)) } : undefined
  }

  /** Lines that contain the words, with where they are, from the rules and the notes of every project. */
  async search(query: string, project?: string): Promise<string> {
    const opened = await this.open()
    if (!opened) return NO_KNOWLEDGE
    const { pin, mirror } = opened
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return 'Give the words to look for.'
    const sources: [string, string][] = [[pin.knowledgeSha, '.']]
    if (pin.memorySha) sources.push([pin.memorySha, 'memory/'])
    const hits: string[] = []
    for (const [sha, path] of sources) {
      const files = (await mirror.list(sha, [path]))
        .filter((f) => READABLE.test(f.path) && f.size <= SLICE_MAX_FILE_BYTES)
        .filter(
          (f) =>
            !project || !/\/projects\//.test(f.path) || f.path.includes(`/projects/${project}/`),
        )
        .slice(0, MAX_FILES)
      for (const file of files) {
        const text = (await mirror.read(sha, file.path))?.toString('utf8') ?? ''
        text.split('\n').forEach((line, i) => {
          const lower = line.toLowerCase()
          if (hits.length < MAX_HITS && words.every((w) => lower.includes(w))) {
            hits.push(`${file.path}:${i + 1} (${layer(file.path)}): ${line.trim().slice(0, 300)}`)
          }
        })
        if (hits.length >= MAX_HITS) break
      }
    }
    const where = `Knowledge base ${pin.repository} at ${pin.knowledgeSha.slice(0, 7)}`
    return hits.length === 0
      ? `${where}: nothing has all of "${query}".`
      : `${where}:\n${hits.join('\n')}`
  }

  /** One file, with the layer it belongs to said first. */
  async read(path: string): Promise<string> {
    const opened = await this.open()
    if (!opened) return NO_KNOWLEDGE
    const { pin, mirror } = opened
    const clean = path.replace(/^\/+/, '')
    if (clean.split('/').some((part) => part === '..' || part === ''))
      return `Not a path in the base: ${path}`
    const sha = clean.startsWith('memory/') ? pin.memorySha : pin.knowledgeSha
    const content = sha ? await mirror.read(sha, clean) : undefined
    if (!content) return `${clean} is not in the knowledge base.`
    const text = content.toString('utf8')
    return [
      `${clean} (${layer(clean)}), from ${pin.repository} at ${sha!.slice(0, 7)}:`,
      '',
      text.length > READ_MAX_CHARS
        ? `${text.slice(0, READ_MAX_CHARS)}\n[cut at ${READ_MAX_CHARS} characters]`
        : text,
    ].join('\n')
  }
}
