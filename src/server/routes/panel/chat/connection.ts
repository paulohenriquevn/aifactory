import { route } from 'theokit/server/define'

import { chatgptConnection, startChatgptLogin } from '../../../factory/chatgpt-login'
import { ownerOnly } from '../../../panel/policy'

/** Whether the owner's ChatGPT subscription is connected, and the code to type while it is being. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => chatgptConnection())
  .build()

/** Starts the device login and answers with the code and the address to open. */
export const POST = route()
  .policy(ownerOnly)
  .handler(async () => startChatgptLogin())
  .build()
