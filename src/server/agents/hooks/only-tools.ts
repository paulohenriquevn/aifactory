import type { HookHandlers } from '@theokit/agents'

/**
 * The only tools an agent may call. The SDK gives every agent its own built-in tools (a shell, file
 * access) beside the ones declared with `.tool()`, and the assistant runs inside the server's own
 * process, so a built-in it was never meant to have is a shell on the machine that holds the factory's
 * credentials. Anything not named here is refused, and the message tells the model so it stops asking.
 */
export function onlyTools(allowed: readonly string[]): HookHandlers {
  const names = new Set(allowed)
  return {
    pre_tool_call: (ctx) =>
      names.has(ctx.name)
        ? undefined
        : {
            block: true,
            message: `The tool "${ctx.name}" is not available to you. You can only use: ${allowed.join(', ')}.`,
          },
  }
}
