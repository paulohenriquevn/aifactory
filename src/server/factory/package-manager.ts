import type { SandboxBackend } from '@theokit/agents/sandbox'

/**
 * Puts the package manager a repository declares (`packageManager` in package.json) in the user's own corepack
 * cache, under HOME, before any check runs. A child started with only PATH and HOME does not see COREPACK_HOME
 * or the proxy, so it finds the version here or tries to download it with no network. Best effort: a
 * repository that declares none, or a download that fails, leaves the checks to say what is missing.
 */
export async function prepareDeclaredPackageManager(
  backend: SandboxBackend,
  repoDir: string,
): Promise<void> {
  const declared = await backend
    .execute(`node -p "require('${repoDir}/package.json').packageManager || ''"`, {
      timeoutMs: 30_000,
    })
    .catch(() => undefined)
  if (!declared || declared.exitCode !== 0 || !declared.stdout.trim()) return
  await backend
    .execute(`cd ${repoDir} && env -u COREPACK_HOME corepack install`, { timeoutMs: 5 * 60_000 })
    .catch(() => undefined)
}
