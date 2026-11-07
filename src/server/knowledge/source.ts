import { resolve } from 'node:path'

import type { Database } from '../db'

import { chooseSliceFiles, knowledgePaths, memoryPaths } from './format'
import { Mirror, mirrorDir, type TreeFile } from './mirror'
import { isReserved } from './okf'
import {
  currentPin,
  recordDelivery,
  recordNotes,
  type NewNote,
  type Pin,
  type Recipient,
} from './store'

export type SliceFile = { path: string; content: Buffer }
export type Slice = { files: SliceFile[]; left: string[] }

/**
 * What every agent's sandbox gets the knowledge from. It reads the mirror the main process keeps current, so
 * no sandbox fetches anything and none holds a credential for the knowledge repository.
 */
export type KnowledgeSource = {
  /** The commits to deliver now, or nothing while no knowledge base is ready. */
  pin(): Promise<Pin | undefined>
  /** One project's part of the base at those commits: the global part and its own, never another's. */
  slice(pin: Pin, project: string): Promise<Slice>
  delivered(input: {
    recipient: Recipient
    project: string
    pin: Pin
    files: number
  }): Promise<void>
  keep(notes: NewNote[]): Promise<void>
}

/** Where the mirrors are kept on the host: `FACTORY_KNOWLEDGE_DIR`, or `.state/knowledge` in the checkout. */
export const knowledgeRoot = (env: NodeJS.ProcessEnv = process.env) =>
  env.FACTORY_KNOWLEDGE_DIR || resolve(process.cwd(), '.state/knowledge')

/**
 * The order a slice is filled in, so what matters most survives a full budget: the owner's README, the
 * global rules, the project's rules, the project's note index, its notes newest first, the global notes,
 * and the logs last. The owner's root index.md is left out: the slice gets its own (see sliceIndex).
 */
export function slicePriority(project: string, files: TreeFile[]): TreeFile[] {
  const [readme, log, globalRules, projectRules] = knowledgePaths(project)
  const [globalNotes, projectNotes] = memoryPaths(project)
  const under = (prefix: string) => files.filter((f) => f.path.startsWith(prefix))
  const isLog = (f: TreeFile) => f.path === log || f.path === `${projectNotes}log.md`
  const notes = under(projectNotes).filter((f) => !isReserved(f.path))
  return [
    ...files.filter((f) => f.path === readme),
    ...under(globalRules),
    ...under(projectRules),
    ...files.filter((f) => f.path === `${projectNotes}index.md`),
    ...notes.sort((a, b) => b.path.localeCompare(a.path)),
    ...under(globalNotes),
    ...files.filter(isLog),
  ]
}

export function knowledgeSource(db: Database, root: string = knowledgeRoot()): KnowledgeSource {
  return {
    pin: () => currentPin(db),
    async slice(pin, project) {
      const mirror = new Mirror(mirrorDir(root, pin.repository))
      const rules = await mirror.list(pin.knowledgeSha, knowledgePaths(project))
      const notes = pin.memorySha ? await mirror.list(pin.memorySha, memoryPaths(project)) : []
      const fromMemory = new Set(notes.map((n) => n.path))
      const { chosen, left } = chooseSliceFiles(slicePriority(project, [...rules, ...notes]))
      const files: SliceFile[] = []
      for (const file of chosen) {
        const sha = fromMemory.has(file.path) && pin.memorySha ? pin.memorySha : pin.knowledgeSha
        const content = await mirror.read(sha, file.path)
        if (content) files.push({ path: file.path, content })
      }
      return { files, left }
    },
    delivered: (input) => recordDelivery(db, input),
    async keep(notes) {
      await recordNotes(db, notes)
    },
  }
}
