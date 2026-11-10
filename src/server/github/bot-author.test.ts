import { describe, expect, it } from 'vitest'

import { botAuthor } from './bot-author'

describe('botAuthor', () => {
  it('signs commits with the email GitHub gives the App bot, so a squash adds no co-author', () => {
    const author = botAuthor({ GITHUB_APP_SLUG: 'my-app', GITHUB_APP_BOT_USER_ID: '352135739' })

    expect(author).toEqual({
      name: 'my-app[bot]',
      email: '352135739+my-app[bot]@users.noreply.github.com',
    })
  })

  it('refuses to start without the bot user id, naming the script that writes it', () => {
    expect(() => botAuthor({ GITHUB_APP_SLUG: 'my-app' })).toThrow(
      /GITHUB_APP_BOT_USER_ID is not set.*github-app-setup/,
    )
  })

  it('refuses a bot user id that is not a number', () => {
    expect(() =>
      botAuthor({ GITHUB_APP_SLUG: 'my-app', GITHUB_APP_BOT_USER_ID: 'my-app[bot]' }),
    ).toThrow(/GITHUB_APP_BOT_USER_ID must be the numeric id/)
  })

  it('refuses to start without the slug', () => {
    expect(() => botAuthor({ GITHUB_APP_BOT_USER_ID: '1' })).toThrow(/GITHUB_APP_SLUG is not set/)
  })
})
