import { z } from 'zod'

/**
 * The deterministic floor of the security review (#241): what blocks a change whatever an agent says. A secret
 * the diff adds, a high or critical advisory the head has and the base does not, a change that weakens the
 * dependency audit, and a scan that could not run all block. A change to a sensitive path does not: it is a
 * finding of severity `info` for the security agent to read.
 *
 * Every function here decides and reads nothing; `security-scan.ts` reads the diff and the audits in the sandbox
 * and runs the secret scanner. No function takes a list of what to skip or a level to lower: nothing a change
 * or a caller says makes the floor see less.
 */

export type SecuritySeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info'

export type SecurityFinding = {
  kind: 'secret' | 'advisory' | 'sensitive_path'
  file: string
  line?: number
  severity: SecuritySeverity
  /** What was found. A secret is named by its rule, its first characters and its length, never its value. */
  detail: string
  fix?: string
}

export type SecurityFloor = { blocked: boolean; findings: SecurityFinding[] }

/** A line the diff adds, at its line number in the new file. */
export type AddedLine = { file: string; line: number; text: string }

/** What the secret scanner said: its JSON report, or why it did not run. */
export type SecretScan = { report: string } | { failed: string }

/** The output of `pnpm audit --json` (or `npm audit --json`) on the base and on the head, for one lockfile. */
export type AuditOutputs = { lockfile: string; base: string; head: string }

export type FloorInput = {
  diff: string
  changedFiles: string[]
  secrets: SecretScan
  /** Undefined when the repository has no lockfile the factory audits. */
  audit?: AuditOutputs
}

/** Where the floor reports what is about the whole diff rather than one file. */
export const WHOLE_DIFF = '(diff)'

const BLOCKING: SecuritySeverity[] = ['critical', 'high']

/** The floor's verdict over every input: blocked when any finding is high or critical. */
export function securityFloor(input: FloorInput): SecurityFloor {
  const added = addedLines(input.diff)
  const findings = [
    ...secretFindings(input.secrets, added),
    ...auditFindings(input.audit),
    ...auditWeakening(added),
    ...sensitivePaths(input.changedFiles),
  ]
  return { blocked: findings.some((f) => BLOCKING.includes(f.severity)), findings }
}

// ---------------------------------------------------------------------------------------------------------
// The diff

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** A path as git prints it after `+++ `: `b/<path>`, quoted when it has unusual characters, or /dev/null. */
function newPath(header: string): string | undefined {
  const raw = header.slice(4).replace(/\t.*$/, '')
  const path = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  return path.startsWith('b/') ? path.slice(2) : undefined
}

/** Every line a unified diff adds, with its file and its line number in the new file. */
export function addedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = []
  let file: string | undefined
  let line = 0
  let inHunk = false
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false
      file = undefined
    } else if (!inHunk && text.startsWith('+++ ')) {
      file = newPath(text)
    } else if (HUNK.test(text)) {
      inHunk = true
      line = Number(HUNK.exec(text)?.[1])
    } else if (inHunk && file !== undefined && text.startsWith('+')) {
      added.push({ file, line, text: text.slice(1) })
      line += 1
    } else if (inHunk && text.startsWith(' ')) {
      line += 1
    }
  }
  return added
}

/**
 * What the secret scanner reads: the added lines only, so a secret the change removes or leaves alone is not
 * the change's. A blank line separates lines that are not next to each other in one file, so a value that spans
 * lines (a private key) is read whole and two places are never read as one. `origin[i]` is where line `i + 1`
 * of the text came from, undefined for a separator.
 */
export function scanText(added: AddedLine[]): { text: string; origin: (AddedLine | undefined)[] } {
  const lines: string[] = []
  const origin: (AddedLine | undefined)[] = []
  added.forEach((entry, i) => {
    const previous = added[i - 1]
    if (previous && (previous.file !== entry.file || previous.line + 1 !== entry.line)) {
      lines.push('')
      origin.push(undefined)
    }
    lines.push(entry.text)
    origin.push(entry)
  })
  return { text: lines.join('\n'), origin }
}

/** A file only tests read: one under a test folder, or named `*.test.*` or `*.spec.*`. */
export function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path)
}

// ---------------------------------------------------------------------------------------------------------
// Secrets

const LEAK = z.object({
  RuleID: z.string(),
  StartLine: z.number().int(),
  EndLine: z.number().int(),
  StartColumn: z.number().int(),
  EndColumn: z.number().int(),
  Secret: z.string(),
})
type Leak = z.infer<typeof LEAK>

/** Gitleaks' JSON report. Throws when it is not one: a report the floor cannot read is not a clean one. */
export function parseGitleaks(report: string): Leak[] {
  const parsed = z.array(LEAK).safeParse(JSON.parse(report))
  if (!parsed.success)
    throw new Error(`not a gitleaks report: ${parsed.error.message.slice(0, 300)}`)
  return parsed.data
}

/**
 * At most the first four characters the scanner left in clear (it is run with partial redaction), and the
 * length. Gitleaks counts the columns of a line after the first from the newline before it, which shifts both
 * ends by one and leaves the length right; a value over several lines is said in lines.
 */
export function redacted(leak: Leak): string {
  const prefix = leak.Secret.replace(/\.\.\.$/, '').slice(0, 4)
  const size =
    leak.StartLine === leak.EndLine
      ? `${leak.EndColumn - leak.StartColumn + 1} characters`
      : `${leak.EndLine - leak.StartLine + 1} lines`
  return `${prefix}… (${size})`
}

const SECRET_FIX =
  'Take the value out of the change, revoke it where it was issued, and read it from the environment or a secret store.'

/** A JWT in a test is a fixture: it is the one kind a test file may add. */
const TEST_FIXTURE_RULES = ['jwt']

function leakFinding(leak: Leak, origin: (AddedLine | undefined)[]): SecurityFinding | undefined {
  const from = origin[leak.StartLine - 1]
  if (from && TEST_FIXTURE_RULES.includes(leak.RuleID) && isTestFile(from.file)) return undefined
  return {
    kind: 'secret',
    file: from?.file ?? WHOLE_DIFF,
    ...(from ? { line: from.line } : {}),
    severity: 'critical',
    detail: `${leak.RuleID}: ${redacted(leak)}`,
    fix: SECRET_FIX,
  }
}

/** The secrets the diff adds. A scan that did not run, or a report that does not parse, blocks. */
export function secretFindings(scan: SecretScan, added: AddedLine[]): SecurityFinding[] {
  const failure = (reason: string): SecurityFinding[] => [
    {
      kind: 'secret',
      file: WHOLE_DIFF,
      severity: 'critical',
      detail: `the secret scan did not run, so the change is not known to be free of secrets: ${reason}`,
      fix: 'Make gitleaks runnable on the factory host (FACTORY_GITLEAKS names the binary) and run the review again.',
    },
  ]
  if ('failed' in scan) return failure(scan.failed)
  let leaks: Leak[]
  try {
    leaks = parseGitleaks(scan.report)
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
  const { origin } = scanText(added)
  return leaks.flatMap((leak) => leakFinding(leak, origin) ?? [])
}

// ---------------------------------------------------------------------------------------------------------
// Advisories

export type Advisory = {
  /** The GHSA id when the audit gives one, else its own id. */
  id: string
  module: string
  severity: string
  title: string
  url?: string
  patched?: string
}

const OLD_FORMAT = z.object({
  advisories: z.record(
    z.string(),
    z.object({
      id: z.union([z.number(), z.string()]).optional(),
      github_advisory_id: z.string().optional(),
      module_name: z.string(),
      severity: z.string(),
      title: z.string().default(''),
      url: z.string().optional(),
      patched_versions: z.string().optional(),
    }),
  ),
})

const VIA = z.object({
  source: z.union([z.number(), z.string()]).optional(),
  name: z.string(),
  title: z.string().default(''),
  url: z.string().optional(),
  severity: z.string(),
})
const NEW_FORMAT = z.object({
  vulnerabilities: z.record(
    z.string(),
    z.object({ via: z.array(z.union([z.string(), VIA])).default([]) }),
  ),
})

const ghsaOf = (url: string | undefined) => url?.match(/GHSA(?:-[0-9a-z]{4}){3}/)?.[0]

/**
 * The advisories in the JSON of `pnpm audit --json`, which keeps npm's older `advisories` object, or of
 * `npm audit --json`, whose `vulnerabilities` name each advisory in `via` (a string there is a package that is
 * vulnerable only through another, and is not an advisory of its own). Throws for anything else, an error
 * report included: an audit the floor cannot read is not a clean one.
 */
export function parseAudit(output: string): Advisory[] {
  let json: unknown
  try {
    json = JSON.parse(output)
  } catch {
    throw new Error(`the audit printed no JSON: ${output.trim().slice(0, 300) || '(nothing)'}`)
  }
  const old = OLD_FORMAT.safeParse(json)
  if (old.success) {
    return Object.entries(old.data.advisories).map(([key, a]) => ({
      id: a.github_advisory_id ?? ghsaOf(a.url) ?? String(a.id ?? key),
      module: a.module_name,
      severity: a.severity,
      title: a.title,
      ...(a.url ? { url: a.url } : {}),
      ...(a.patched_versions ? { patched: a.patched_versions } : {}),
    }))
  }
  const fresh = NEW_FORMAT.safeParse(json)
  if (fresh.success) {
    return Object.values(fresh.data.vulnerabilities).flatMap((v) =>
      v.via.flatMap((via) =>
        typeof via === 'string'
          ? []
          : [
              {
                id: ghsaOf(via.url) ?? String(via.source ?? via.url ?? via.title),
                module: via.name,
                severity: via.severity,
                title: via.title,
                ...(via.url ? { url: via.url } : {}),
              },
            ],
      ),
    )
  }
  throw new Error(`not the JSON of pnpm audit or npm audit: ${output.trim().slice(0, 300)}`)
}

const keyOf = (a: Advisory) => `${a.module}\u0000${a.id}`
const SEVERITIES: SecuritySeverity[] = ['critical', 'high', 'moderate', 'low']
const severityOf = (value: string): SecuritySeverity =>
  SEVERITIES.find((s) => s === value.toLowerCase()) ?? 'critical'

function advisoryFinding(lockfile: string, a: Advisory): SecurityFinding {
  return {
    kind: 'advisory',
    file: lockfile,
    severity: severityOf(a.severity),
    detail: `${a.id} in ${a.module} (${a.severity}): ${a.title}${a.url ? ` ${a.url}` : ''}`,
    ...(a.patched
      ? { fix: `Move ${a.module} to a patched version (${a.patched}).` }
      : { fix: `No patched version is named: remove or replace ${a.module}, or wait for one.` }),
  }
}

function unreadableAudit(lockfile: string, which: string, error: unknown): SecurityFinding {
  return {
    kind: 'advisory',
    file: lockfile,
    severity: 'critical',
    detail: `the dependency audit of the ${which} could not be read, so the advisories the change adds are not known: ${error instanceof Error ? error.message : String(error)}`,
    fix: 'Make the audit run (the registry reachable, the lockfile valid) and run the review again.',
  }
}

/**
 * The advisories the head has and the base does not, each with its own severity: a high or critical one blocks.
 * An advisory the base already has is not the change's, so it is not listed (it is the base's to fix). An audit
 * that cannot be read blocks, the base's too, since then nothing says which advisories are new. An advisory
 * whose severity is not one the floor knows counts as critical.
 */
export function auditFindings(audit: AuditOutputs | undefined): SecurityFinding[] {
  if (!audit) return []
  let base: Advisory[]
  let head: Advisory[]
  try {
    base = parseAudit(audit.base)
  } catch (error) {
    return [unreadableAudit(audit.lockfile, 'base', error)]
  }
  try {
    head = parseAudit(audit.head)
  } catch (error) {
    return [unreadableAudit(audit.lockfile, 'head', error)]
  }
  const before = new Set(base.map(keyOf))
  const seen = new Set<string>()
  return head.flatMap((a) => {
    const key = keyOf(a)
    if (before.has(key) || seen.has(key)) return []
    seen.add(key)
    return [advisoryFinding(audit.lockfile, a)]
  })
}

/**
 * What turns an audit off or down: pnpm's `auditConfig` and its ignore lists, an audit level, and the flags that
 * ignore an advisory. Only a person may add an exception (#241), so a change that adds one is blocked.
 */
const WEAKENS_AUDIT =
  /\b(auditConfig|ignoreCves|ignoreGhsas|ignoreUnfixable|auditLevel|audit-level|ignore-unfixable)\b|\baudit\b.*\s--ignore\b/i

/** The files where an audit is configured or run: manifests, workspace and package manager settings, CI and scripts. */
function configuresAudit(path: string): boolean {
  const name = path.split('/').at(-1) ?? path
  return (
    /\.(json|ya?ml|toml|sh)$/i.test(name) ||
    ['.npmrc', '.yarnrc', 'Makefile', 'Justfile', 'justfile', 'Dockerfile'].includes(name)
  )
}

/** The added lines that weaken the dependency audit, outside tests. */
export function auditWeakening(added: AddedLine[]): SecurityFinding[] {
  return added
    .filter((a) => configuresAudit(a.file) && !isTestFile(a.file) && WEAKENS_AUDIT.test(a.text))
    .map((a) => ({
      kind: 'advisory' as const,
      file: a.file,
      line: a.line,
      severity: 'high' as const,
      detail: `the change weakens the dependency audit: ${a.text.trim().slice(0, 200)}`,
      fix: 'Remove it. An advisory is fixed, replaced or waited on; only a person may add an exception, with a reason and an expiry.',
    }))
}

// ---------------------------------------------------------------------------------------------------------
// Sensitive paths

/** Each lockfile and the manifests whose change explains it. A JavaScript manifest may be in any package. */
const LOCKFILES: Record<string, { manifests: string[]; anywhere: boolean }> = {
  'pnpm-lock.yaml': { manifests: ['package.json', 'pnpm-workspace.yaml'], anywhere: true },
  'package-lock.json': { manifests: ['package.json'], anywhere: true },
  'npm-shrinkwrap.json': { manifests: ['package.json'], anywhere: true },
  'yarn.lock': { manifests: ['package.json'], anywhere: true },
  'bun.lock': { manifests: ['package.json'], anywhere: true },
  'bun.lockb': { manifests: ['package.json'], anywhere: true },
  'Cargo.lock': { manifests: ['Cargo.toml'], anywhere: true },
  'go.sum': { manifests: ['go.mod'], anywhere: false },
  'poetry.lock': { manifests: ['pyproject.toml'], anywhere: false },
  'uv.lock': { manifests: ['pyproject.toml'], anywhere: false },
  'Gemfile.lock': { manifests: ['Gemfile'], anywhere: false },
}

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function lockfileAlone(path: string, changed: string[]): boolean {
  const lock = LOCKFILES[nameOf(path)]
  if (!lock) return false
  return !changed.some(
    (other) =>
      lock.manifests.includes(nameOf(other)) && (lock.anywhere || dirOf(other) === dirOf(path)),
  )
}

/** A path named for authentication, cryptography, secrets, tokens, egress or the sandbox, in a folder or the file. */
const SENSITIVE_NAME = /auth|crypto|secret|token|egress|sandbox/i

function sensitiveReason(path: string, changed: string[]): string | undefined {
  if (path.startsWith('.github/')) return "changes the repository's automation under .github/"
  if (lockfileAlone(path, changed))
    return 'changes a lockfile while no manifest changed: dependencies moved with no declared reason'
  if (SENSITIVE_NAME.test(path))
    return 'touches code named for authentication, cryptography, secrets, tokens, egress or the sandbox'
  return undefined
}

/** The changed files the security agent must read: never blocking, always listed. */
export function sensitivePaths(changed: string[]): SecurityFinding[] {
  return changed.flatMap((file) => {
    const reason = sensitiveReason(file, changed)
    return reason
      ? [{ kind: 'sensitive_path' as const, file, severity: 'info' as const, detail: reason }]
      : []
  })
}
