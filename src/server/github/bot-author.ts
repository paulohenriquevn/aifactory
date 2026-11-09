/**
 * The identity the factory commits as. GitHub authors the App's own merges with
 * `<id>+<slug>[bot]@users.noreply.github.com`; a commit with any other email counts as a second
 * author, and every squash then gains a `Co-authored-by` trailer for the bot itself.
 */
export function botAuthor(env: NodeJS.ProcessEnv): { name: string; email: string } {
  const slug = env.GITHUB_APP_SLUG
  if (!slug) throw new Error('GITHUB_APP_SLUG is not set')
  const id = env.GITHUB_APP_BOT_USER_ID
  if (!id) {
    throw new Error(
      `GITHUB_APP_BOT_USER_ID is not set: it is the id of the user ${slug}[bot], which scripts/github-app-setup.mjs writes`,
    )
  }
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `GITHUB_APP_BOT_USER_ID must be the numeric id of the user ${slug}[bot], not ${JSON.stringify(id)}`,
    )
  }
  return { name: `${slug}[bot]`, email: `${id}+${slug}[bot]@users.noreply.github.com` }
}
