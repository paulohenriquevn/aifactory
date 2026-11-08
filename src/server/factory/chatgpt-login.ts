import { homedir } from 'node:os'

import {
  CODEX_PROVIDER,
  loginWithDevice,
  readStoredOAuth,
  type CredentialStoreConfig,
} from '@theokit/agents/auth'

/**
 * The owner's ChatGPT subscription as the assistant's model. The framework's `openai-chatgpt` provider
 * reads its credential from this store, so the login must write there and nowhere else. It is the OpenAI
 * device login: the owner opens an address, types a short code, and the credential is kept (0600) and
 * refreshed by the framework. It is not the factory's own Codex login, which belongs to the agent that
 * builds, because a refresh token rotates and two users of one login would invalidate each other.
 */
export const CHATGPT_STORE: CredentialStoreConfig = {
  home: homedir(),
  dirName: '.theokit',
  fileName: 'auth.json',
  homeEnvVar: 'THEOKIT_AUTH_HOME',
}

export type LoginState =
  | { status: 'idle' }
  | { status: 'waiting'; userCode: string; verificationUri: string }
  | { status: 'error'; message: string }

export type ChatgptConnection = { connected: boolean; login: LoginState }

export type LoginDeps = {
  login?: typeof loginWithDevice
  read?: typeof readStoredOAuth
  env?: NodeJS.ProcessEnv
}

let current: LoginState = { status: 'idle' }

/** Whether a ChatGPT credential is kept, and where a login in progress is. */
export function chatgptConnection(deps: LoginDeps = {}): ChatgptConnection {
  const read = deps.read ?? readStoredOAuth
  const stored = read(CHATGPT_STORE, deps.env ?? process.env)
  const connected = stored !== undefined
  // A login that finished leaves its credential behind; what it showed is no longer worth showing.
  if (connected && current.status === 'waiting') current = { status: 'idle' }
  return { connected, login: current }
}

/**
 * Starts the device login and returns the code to show, without waiting for the owner: the framework polls
 * until they approve, and a later `chatgptConnection` finds the credential. A login already waiting is
 * returned as it is, so pressing the button twice does not make two.
 */
export async function startChatgptLogin(deps: LoginDeps = {}): Promise<LoginState> {
  if (current.status === 'waiting') return current
  const login = deps.login ?? loginWithDevice
  const method = CODEX_PROVIDER.methods.find((m) => m.type === 'oauth')
  if (!method) {
    current = { status: 'error', message: 'the framework has no ChatGPT login method' }
    return current
  }
  const shown = new Promise<LoginState>((resolve) => {
    void login(
      CODEX_PROVIDER,
      method,
      CHATGPT_STORE,
      {
        onPrompt: ({ userCode, verificationUri }) => {
          current = { status: 'waiting', userCode, verificationUri }
          resolve(current)
        },
      },
      { env: deps.env ?? process.env },
    )
      .then(() => {
        current = { status: 'idle' }
      })
      .catch((error: unknown) => {
        current = {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
        resolve(current)
      })
  })
  return shown
}

/** For tests: forget a login in progress. */
export function resetChatgptLogin() {
  current = { status: 'idle' }
}
