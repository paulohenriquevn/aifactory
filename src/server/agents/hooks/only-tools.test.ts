import { describe, expect, it } from 'vitest'

import { onlyTools } from './only-tools'

type Hook = (ctx: { name: string; args: Record<string, unknown>; runId: string }) => unknown
const hook = (allowed: string[]) => onlyTools(allowed).pre_tool_call as unknown as Hook
const call = (name: string) => ({ name, args: {}, runId: 'r' })

describe('onlyTools', () => {
  it('lets through the tools it names and nothing else', () => {
    const check = hook(['propose', 'repo_file'])
    expect(check(call('propose'))).toBeUndefined()
    expect(check(call('repo_file'))).toBeUndefined()
    expect(check(call('shell'))).toMatchObject({ block: true })
    expect(check(call('write_file'))).toMatchObject({ block: true })
    expect(check(call('Propose'))).toMatchObject({ block: true })
  })

  it('tells the model which tools it may use, so it stops asking for the others', () => {
    const veto = hook(['propose', 'repo_files'])(call('shell')) as { message: string }
    expect(veto.message).toContain('"shell" is not available')
    expect(veto.message).toContain('propose, repo_files')
  })

  it('refuses everything when nothing is allowed', () => {
    expect(hook([])(call('propose'))).toMatchObject({ block: true })
  })
})
