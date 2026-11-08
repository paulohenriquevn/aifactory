import { describe, expect, it } from 'vitest'

import { readable } from './repo-reader'

describe('what the assistant may read', () => {
  it('reads the files that say how a project is built and tested', () => {
    for (const path of [
      'package.json',
      'README.md',
      'readme',
      'README.rst',
      'Dockerfile',
      'Gemfile',
      'pnpm-workspace.yaml',
      'pyproject.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'Makefile',
      'Cargo.toml',
      'go.mod',
      'Gemfile',
      'Dockerfile',
      'compose.yaml',
      '.nvmrc',
      '.github/workflows/ci.yml',
      'apps/web/package.json',
      'services/api/requirements.txt',
    ]) {
      expect(readable(path), path).toBe(true)
    }
  })

  it('refuses source code, secrets and anything else that is not a build or test file', () => {
    for (const path of [
      'src/index.ts',
      '.env',
      '.env.local',
      'secrets.json',
      'id_rsa',
      'drizzle/0000_init.sql',
      'package-lock.json',
      'pnpm-lock.yaml',
      'config/credentials.yml',
      '.github/CODEOWNERS',
      '.github/workflows/notes.txt',
      'docs/package.json.bak',
      'package.json.bak',
      'xreadme',
      'readme.md.bak',
      'readme.md5.x',
      'my-requirements.txt',
      'requirements.txt.bak',
      'requirements.md',
      'notpackage.json',
      'Makefile.old',
    ]) {
      expect(readable(path), path).toBe(false)
    }
  })

  it('refuses a path that climbs out of the repository or is not relative', () => {
    for (const path of [
      '../package.json',
      'a/../../package.json',
      '/etc/passwd',
      'package.json\0.txt',
    ]) {
      expect(readable(path), path).toBe(false)
    }
  })

  it('does not take a workflow from outside .github/workflows', () => {
    expect(readable('ci.yml')).toBe(false)
    expect(readable('workflows/ci.yml')).toBe(false)
    expect(readable('x/.github/workflows/ci.yml')).toBe(false)
    expect(readable('.github/workflows/ci.yml.bak')).toBe(false)
    expect(readable('.github/workflows/a/b.yml')).toBe(false)
    expect(readable('.github/workflows/.yml')).toBe(false)
    expect(readable('.github/workflows/ci.yaml')).toBe(true)
  })
})

describe('an absolute path', () => {
  it('is refused even when it names a build file', () => {
    expect(readable('/package.json')).toBe(false)
    expect(readable('/.github/workflows/ci.yml')).toBe(false)
  })
})
