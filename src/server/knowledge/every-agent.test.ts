import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GUIDE_IDS } from '../../shared/guides'
import { assistantTools } from '../factory/assistant'
import { CHAT_SPEC } from '../factory/chat-agent'
import { guideSpec } from '../factory/guides'
import { buildPrompt } from '../factory/harness'
import { planPrompt } from '../factory/plan'
import { reviewPrompt } from '../factory/review'

import { SANDBOX_KNOWLEDGE_DIR } from './format'
import { knowledgeRules } from './prompt'

/** Every source file of the server, without the tests. */
function sources(dir = 'src/server'): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return []
    return [{ path, text: readFileSync(path, 'utf8') }]
  })
}

/**
 * The knowledge base is part of what an agent is, not something each one may opt into: whatever agent the
 * factory runs, in a sandbox or in the panel, reads the same base. These tests fail when an agent is added
 * that would not.
 */
describe('every agent of the factory reads the knowledge base', () => {
  it('in the panel: every assistant is built by buildAssistant, which gives it the base', () => {
    const direct = sources()
      .filter((f) => f.text.includes('AgentBuilder.create('))
      .map((f) => f.path)
    expect(direct).toEqual(['src/server/factory/assistant.ts'])
  })

  it('in the panel: the chat and every guide have the two tools of the base', () => {
    for (const spec of [CHAT_SPEC, ...GUIDE_IDS.map((id) => guideSpec(id))]) {
      expect(Object.keys(assistantTools(spec))).toEqual(
        expect.arrayContaining(['knowledge_search', 'knowledge_read']),
      )
    }
  })

  it('in a sandbox: every file that starts one opens the knowledge feed on it', () => {
    const starters = sources().filter(
      (f) =>
        !f.path.endsWith('factory/sandbox.ts') &&
        /\b(createIsolatedSandbox|restoreIsolatedSandbox)\(/.test(f.text),
    )
    expect(starters.length).toBeGreaterThan(0)
    for (const file of starters) {
      expect({ file: file.path, feed: file.text.includes('KnowledgeFeed.open(') }).toEqual({
        file: file.path,
        feed: true,
      })
    }
  })

  it('in a sandbox: the builder, the reviewer and the planner are told the same about it', () => {
    const rules = knowledgeRules(SANDBOX_KNOWLEDGE_DIR)
    const issue = { repo: 'o/r', issueNumber: 1, title: 't', body: 'b', branch: 'factory/1' }
    const dir = SANDBOX_KNOWLEDGE_DIR
    expect(buildPrompt({ ...issue, knowledgeDir: dir })).toContain(rules)
    expect(reviewPrompt({ ...issue, baseSha: 'abc', knowledgeDir: dir })).toContain(rules)
    expect(planPrompt({ repo: 'o/r', goal: 'g', knowledgeDir: dir })).toContain(rules)
  })

  it('in a sandbox: an agent without a base delivered is told nothing about one', () => {
    const issue = { repo: 'o/r', issueNumber: 1, title: 't', body: 'b', branch: 'factory/1' }
    expect(buildPrompt(issue)).not.toContain(SANDBOX_KNOWLEDGE_DIR)
    expect(reviewPrompt({ ...issue, baseSha: 'abc' })).not.toContain(SANDBOX_KNOWLEDGE_DIR)
    expect(planPrompt({ repo: 'o/r', goal: 'g' })).not.toContain(SANDBOX_KNOWLEDGE_DIR)
  })
})
