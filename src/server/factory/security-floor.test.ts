import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  addedLines,
  auditFindings,
  auditWeakening,
  isTestFile,
  parseAudit,
  parseGitleaks,
  redacted,
  scanText,
  secretFindings,
  securityFloor,
  sensitivePaths,
  WHOLE_DIFF,
  type AddedLine,
} from './security-floor'

// Fake values in the documented formats, built in pieces so that no scanner, GitHub's included, reads a key here.
const AWS_KEY = 'AKIA' + 'Z7QXRM2BTKD5PL6W'

const diffOf = (file: string, lines: string[], start = 1) =>
  [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},0 +${start},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n')

const leak = (over: object = {}) => ({
  RuleID: 'aws-access-token',
  Description: 'AWS',
  StartLine: 1,
  EndLine: 1,
  StartColumn: 19,
  EndColumn: 38,
  Match: 'AKI...',
  Secret: 'AKI...',
  File: '',
  ...over,
})
const report = (...leaks: object[]) => ({ report: JSON.stringify(leaks) })

const advisory = (id: string, module: string, severity: string, over: object = {}) => ({
  id: 1,
  github_advisory_id: id,
  module_name: module,
  severity,
  title: `${module} is vulnerable`,
  url: `https://github.com/advisories/${id}`,
  patched_versions: '>=2.0.0',
  findings: [{ version: '1.0.0', paths: ['.>x'] }],
  ...over,
})
const pnpmAudit = (...advisories: ReturnType<typeof advisory>[]) =>
  JSON.stringify({
    advisories: Object.fromEntries(advisories.map((a, i) => [String(1000 + i), a])),
    metadata: {},
  })

const clean = { report: '[]' }

describe('the lines a diff adds', () => {
  it('names each with its file and its line in the new file, and skips what it removes or keeps', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,3 +3,3 @@ function x() {',
      ' kept',
      '-removed',
      '+added one',
      '+++ looks like a header',
      '\\ No newline at end of file',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old',
      'diff --git a/sp ace.ts b/sp ace.ts',
      '--- /dev/null',
      '+++ "b/sp ace.ts"',
      '@@ -0,0 +1 @@',
      '+new',
    ].join('\n')
    expect(addedLines(diff)).toEqual([
      { file: 'src/a.ts', line: 4, text: 'added one' },
      { file: 'src/a.ts', line: 5, text: '++ looks like a header' },
      { file: 'sp ace.ts', line: 1, text: 'new' },
    ])
  })

  it('is nothing for a diff with no hunk', () => {
    expect(
      addedLines('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ'),
    ).toEqual([])
    expect(addedLines('')).toEqual([])
  })
})

describe('what the secret scanner reads', () => {
  it('is the added lines, with a blank line between places that are not next to each other', () => {
    const added: AddedLine[] = [
      { file: 'a', line: 1, text: 'one' },
      { file: 'a', line: 2, text: 'two' },
      { file: 'a', line: 9, text: 'nine' },
      { file: 'b', line: 10, text: 'ten' },
    ]
    const { text, origin } = scanText(added)
    expect(text).toBe('one\ntwo\n\nnine\n\nten')
    expect(origin).toEqual([added[0], added[1], undefined, added[2], undefined, added[3]])
  })
})

describe('a secret the diff adds', () => {
  const diff = diffOf('src/config.ts', ['const region = "x"', `const awsKeyId = "${AWS_KEY}"`], 7)

  it('blocks, with the file and the line it is on, and never says the value', () => {
    const floor = securityFloor({
      diff,
      changedFiles: ['src/config.ts'],
      secrets: report(leak({ StartLine: 2, EndLine: 2, StartColumn: 20, EndColumn: 39 })),
    })
    expect(floor.blocked).toBe(true)
    expect(floor.findings).toEqual([
      {
        kind: 'secret',
        file: 'src/config.ts',
        line: 8,
        severity: 'critical',
        detail: 'aws-access-token: AKI… (20 characters)',
        fix: expect.stringContaining('revoke it'),
      },
    ])
    expect(JSON.stringify(floor)).not.toContain(AWS_KEY)
    expect(JSON.stringify(floor)).not.toContain(AWS_KEY.slice(4))
  })

  it('keeps at most four characters even of a value the scanner did not redact', () => {
    expect(redacted(leak({ Secret: AWS_KEY }))).toBe('AKIA… (20 characters)')
    expect(redacted(leak({ StartLine: 3, EndLine: 7 }))).toBe('AKI… (5 lines)')
  })

  it('passes a diff the scanner found nothing in', () => {
    expect(securityFloor({ diff, changedFiles: ['src/config.ts'], secrets: clean })).toEqual({
      blocked: false,
      findings: [],
    })
  })

  it('lets a test file add a JWT, and nothing else: a key in a test still blocks', () => {
    const inTest = diffOf('src/auth.test.ts', ['const jwt = "x"', 'const key = "y"'])
    const findings = secretFindings(
      report(leak({ RuleID: 'jwt', StartLine: 1 }), leak({ StartLine: 2, EndLine: 2 })),
      addedLines(inTest),
    )
    expect(findings.map((f) => [f.detail.split(':')[0], f.line])).toEqual([['aws-access-token', 2]])
    const inCode = secretFindings(report(leak({ RuleID: 'jwt' })), addedLines(diff))
    expect(inCode).toHaveLength(1)
  })

  it('blocks when the scanner did not run, and when its report cannot be read', () => {
    for (const scan of [{ failed: 'gitleaks not found' }, { report: 'oops' }, { report: '{}' }]) {
      const floor = securityFloor({ diff, changedFiles: [], secrets: scan })
      expect(floor.blocked, JSON.stringify(scan)).toBe(true)
      expect(floor.findings[0]).toMatchObject({
        kind: 'secret',
        file: WHOLE_DIFF,
        severity: 'critical',
      })
      expect(floor.findings[0].detail).toMatch(/the secret scan did not run/)
    }
    expect(
      securityFloor({ diff, changedFiles: [], secrets: { failed: 'gitleaks not found' } })
        .findings[0].detail,
    ).toContain('gitleaks not found')
  })

  it('names the whole diff for a leak on a line it cannot place', () => {
    const [finding] = secretFindings(report(leak({ StartLine: 40, EndLine: 40 })), addedLines(diff))
    expect(finding.file).toBe(WHOLE_DIFF)
    expect(finding.line).toBeUndefined()
  })

  it('reads only a real gitleaks report', () => {
    expect(parseGitleaks(JSON.stringify([leak()]))).toHaveLength(1)
    expect(() => parseGitleaks(JSON.stringify([{ RuleID: 'x' }]))).toThrow(/not a gitleaks report/)
  })
})

describe('the advisories the change adds', () => {
  const lockfile = 'pnpm-lock.yaml'
  const picomatch = advisory('GHSA-fc5q-39xc-vjpf', 'picomatch', 'high')

  it('blocks on a high advisory the head has and the base does not, with what would fix it', () => {
    const floor = securityFloor({
      diff: '',
      changedFiles: [],
      secrets: clean,
      audit: { lockfile, base: pnpmAudit(), head: pnpmAudit(picomatch) },
    })
    expect(floor.blocked).toBe(true)
    expect(floor.findings).toEqual([
      {
        kind: 'advisory',
        file: lockfile,
        severity: 'high',
        detail:
          'GHSA-fc5q-39xc-vjpf in picomatch (high): picomatch is vulnerable https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
        fix: 'Move picomatch to a patched version (>=2.0.0).',
      },
    ])
  })

  it('blocks on a critical one, lists a moderate or low one without blocking, and says when none is patched', () => {
    const findings = auditFindings({
      lockfile,
      base: pnpmAudit(),
      head: pnpmAudit(
        advisory('GHSA-aaaa-bbbb-cccc', 'a', 'critical', { patched_versions: undefined }),
        advisory('GHSA-dddd-eeee-ffff', 'b', 'moderate'),
        advisory('GHSA-gggg-hhhh-jjjj', 'c', 'low'),
      ),
    })
    expect(findings.map((f) => f.severity)).toEqual(['critical', 'moderate', 'low'])
    expect(findings[0].fix).toMatch(/No patched version/)
    const moderate = securityFloor({
      diff: '',
      changedFiles: [],
      secrets: clean,
      audit: {
        lockfile,
        base: pnpmAudit(),
        head: pnpmAudit(advisory('GHSA-dddd-eeee-ffff', 'b', 'moderate')),
      },
    })
    expect(moderate.blocked).toBe(false)
  })

  it('does not block on an advisory the base already has: it is the base, not the change', () => {
    const floor = securityFloor({
      diff: '',
      changedFiles: [],
      secrets: clean,
      audit: { lockfile, base: pnpmAudit(picomatch), head: pnpmAudit(picomatch) },
    })
    expect(floor).toEqual({ blocked: false, findings: [] })
  })

  it('counts the same advisory in another package as new, and one advisory once', () => {
    const findings = auditFindings({
      lockfile,
      base: pnpmAudit(picomatch),
      head: pnpmAudit(picomatch, { ...picomatch, module_name: 'micromatch' }, picomatch),
    })
    expect(findings.map((f) => f.detail.split(' (')[0])).toEqual([
      'GHSA-fc5q-39xc-vjpf in micromatch',
    ])
  })

  it('counts a severity it does not know as critical', () => {
    const [finding] = auditFindings({
      lockfile,
      base: pnpmAudit(),
      head: pnpmAudit(advisory('GHSA-kkkk-mmmm-nnnn', 'x', 'severe')),
    })
    expect(finding.severity).toBe('critical')
  })

  it('blocks when either audit cannot be read, saying which', () => {
    for (const [base, head, which] of [
      ['not json', pnpmAudit(), 'base'],
      [pnpmAudit(), '{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE"}}', 'head'],
    ]) {
      const floor = securityFloor({
        diff: '',
        changedFiles: [],
        secrets: clean,
        audit: { lockfile, base, head },
      })
      expect(floor.blocked).toBe(true)
      expect(floor.findings[0].detail).toContain(`audit of the ${which} could not be read`)
    }
  })

  it('has nothing to say for a repository with no lockfile it audits', () => {
    expect(auditFindings(undefined)).toEqual([])
  })

  it("reads npm's newer format too, where an advisory is an object in `via`", () => {
    const npm = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        picomatch: {
          severity: 'high',
          via: [
            {
              source: 1102341,
              name: 'picomatch',
              title: 'ReDoS',
              url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
              severity: 'high',
            },
          ],
        },
        vite: { severity: 'high', via: ['picomatch'] },
        other: { severity: 'low', via: [{ source: 7, name: 'other', severity: 'low' }] },
      },
    })
    expect(parseAudit(npm)).toEqual([
      {
        id: 'GHSA-fc5q-39xc-vjpf',
        module: 'picomatch',
        severity: 'high',
        title: 'ReDoS',
        url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
      },
      { id: '7', module: 'other', severity: 'low', title: '' },
    ])
  })

  it("reads pnpm's format, taking the GHSA from the url or the id when the advisory names none", () => {
    const audit = JSON.stringify({
      advisories: {
        '1': advisory('', 'a', 'low', { github_advisory_id: undefined }),
        '2': advisory('', 'b', 'low', { github_advisory_id: undefined, url: undefined, id: 42 }),
        '3': advisory('', 'c', 'low', {
          github_advisory_id: undefined,
          url: undefined,
          id: undefined,
        }),
      },
    })
    const ids = parseAudit(audit).map((a) => a.id)
    expect(ids[1]).toBe('42')
    expect(ids[2]).toBe('3')
    expect(
      parseAudit(
        pnpmAudit(
          advisory('', 'a', 'low', {
            github_advisory_id: undefined,
            url: 'https://github.com/advisories/GHSA-abcd-efgh-ijkm',
          }),
        ),
      )[0].id,
    ).toBe('GHSA-abcd-efgh-ijkm')
  })
})

describe('a change that weakens the audit', () => {
  it('blocks an ignore list, an audit level or an ignore flag in a manifest, a workflow or a script', () => {
    const lines: [string, string][] = [
      ['package.json', '    "auditConfig": {'],
      ['package.json', '      "ignoreGhsas": ["GHSA-fc5q-39xc-vjpf"]'],
      ['pnpm-workspace.yaml', 'auditConfig:'],
      ['pnpm-workspace.yaml', '  ignoreCves: [CVE-2026-1]'],
      ['.npmrc', 'audit-level=critical'],
      ['.github/workflows/ci.yml', '      - run: pnpm audit --audit-level critical'],
      ['.github/workflows/ci.yml', '      - run: pnpm audit --ignore GHSA-x'],
      ['scripts/check.sh', 'pnpm audit --ignore-unfixable'],
    ]
    const added = lines.map(([file, text], i) => ({ file, line: i + 1, text }))
    const findings = auditWeakening(added)
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(findings[1]).toMatchObject({
      kind: 'advisory',
      file: 'package.json',
      severity: 'high',
      detail: expect.stringContaining('weakens the dependency audit'),
    })
  })

  it('does not count code or tests that only name those words', () => {
    const added = [
      { file: 'src/floor.ts', line: 1, text: 'const words = /ignoreGhsas/' },
      { file: 'test/fixtures/package.json', line: 1, text: '"ignoreGhsas": []' },
      { file: 'package.json', line: 2, text: '"scripts": { "audit": "pnpm audit --json" }' },
    ]
    expect(auditWeakening(added)).toEqual([])
  })

  it('blocks the floor', () => {
    const floor = securityFloor({
      diff: diffOf('.npmrc', ['audit-level=none']),
      changedFiles: ['.npmrc'],
      secrets: clean,
    })
    expect(floor.blocked).toBe(true)
  })
})

describe('a change to a sensitive path', () => {
  it('is listed for the agent to read, and never blocks', () => {
    const changed = [
      '.github/workflows/ci.yml',
      'src/server/auth/session.ts',
      'src/crypto.ts',
      'src/secrets.ts',
      'src/github/token-cache.ts',
      'ops/sandbox/egress.py',
      'src/factory/docker-sandbox.ts',
      'src/plain.ts',
    ]
    const floor = securityFloor({ diff: '', changedFiles: changed, secrets: clean })
    expect(floor.blocked).toBe(false)
    expect(floor.findings.map((f) => f.file)).toEqual([
      '.github/workflows/ci.yml',
      'src/server/auth/session.ts',
      'src/crypto.ts',
      'src/secrets.ts',
      'src/github/token-cache.ts',
      'ops/sandbox/egress.py',
      'src/factory/docker-sandbox.ts',
    ])
    expect(floor.findings.every((f) => f.kind === 'sensitive_path' && f.severity === 'info')).toBe(
      true,
    )
  })

  it('lists a lockfile that changed with no manifest, and not one that changed with its manifest', () => {
    expect(sensitivePaths(['pnpm-lock.yaml'])[0].detail).toMatch(/no manifest changed/)
    expect(sensitivePaths(['pnpm-lock.yaml', 'packages/a/package.json'])).toEqual([])
    expect(sensitivePaths(['pnpm-lock.yaml', 'pnpm-workspace.yaml'])).toEqual([])
    expect(sensitivePaths(['package-lock.json', 'README.md'])).toHaveLength(1)
    expect(sensitivePaths(['svc/go.sum', 'go.mod'])).toHaveLength(1)
    expect(sensitivePaths(['svc/go.sum', 'svc/go.mod'])).toEqual([])
    expect(sensitivePaths(['Cargo.lock', 'crates/x/Cargo.toml'])).toEqual([])
  })
})

describe('a test file', () => {
  it('is one under a test folder or named for tests', () => {
    for (const path of ['a.test.ts', 'src/a.spec.js', 'test/x.ts', 'src/__tests__/y.ts', 'tests/z'])
      expect(isTestFile(path), path).toBe(true)
    for (const path of ['src/testing.ts', 'src/contest/a.ts', 'latest.ts'])
      expect(isTestFile(path), path).toBe(false)
  })
})

describe('the floor sees everything', () => {
  // Nothing a change or a caller says may make the floor see less: no allowlist, ignore list or lower level.
  const sources = ['security-floor.ts', 'security-scan.ts'].map((name) => ({
    name,
    text: readFileSync(new URL(name, import.meta.url), 'utf8'),
  }))

  it('takes no allowlist, ignore list or level in any function', () => {
    const signature = /(?:function\s+\w+|=>)\s*\(([^)]*)\)|function\s+\w+\s*\(([^)]*)\)/g
    for (const { name, text } of sources) {
      const params = [...text.matchAll(signature)].map((m) => m[1] ?? m[2] ?? '').join(' ')
      expect(params, name).not.toMatch(/allow|ignore|exempt|skip|level|threshold|baseline|except/i)
      for (const m of text.matchAll(/export type (\w+) = \{([^}]*)\}/g)) {
        expect(m[2], `${name} ${m[1]}`).not.toMatch(/allow|ignore|exempt|skip|level|baseline/i)
      }
    }
  })

  it('never hands gitleaks a baseline, an ignore file or a config of the repository', () => {
    const scan = sources.find((s) => s.name === 'security-scan.ts')?.text ?? ''
    expect(scan).toContain("'--ignore-gitleaks-allow'")
    expect(scan).not.toMatch(/--baseline-path|'-b'|--gitleaks-ignore-path|'-i'|'--config'|'-c'/)
  })
})
