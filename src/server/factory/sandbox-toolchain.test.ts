import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { E2B_TOOLCHAIN } from './e2b-template'
import { SANDBOX_TOOLCHAIN } from './sandbox-toolchain'

const dockerfile = readFileSync(new URL('../../../ops/sandbox/Dockerfile', import.meta.url), 'utf8')

describe('the sandbox toolchain', () => {
  it('is the same in the Docker image and the E2B template', () => {
    expect(E2B_TOOLCHAIN).toEqual(SANDBOX_TOOLCHAIN)
    expect(dockerfile).toContain(`FROM node:${SANDBOX_TOOLCHAIN.node}-`)
    expect(dockerfile).toContain(`corepack prepare pnpm@${SANDBOX_TOOLCHAIN.pnpm} `)
    expect(dockerfile).toContain(`nodedir=${SANDBOX_TOOLCHAIN.nodeHeadersDir}`)
    expect(SANDBOX_TOOLCHAIN.nodeHeaders).toBe(SANDBOX_TOOLCHAIN.node)
  })

  it('names the pnpm the factory itself declares', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(pkg.packageManager).toBe(`pnpm@${SANDBOX_TOOLCHAIN.pnpm}`)
  })
})
