// The theme provider writes CSS custom properties that jsdom's parser cannot read. It is jsdom's
// limit and not a fault of the page, and it would drown the real errors in the test output.
const original = console.error
console.error = (...args: unknown[]) => {
  const first = args[0]
  const message = first instanceof Error ? first.message : String(first)
  if (message.includes('Could not parse CSS stylesheet')) return
  original(...args)
}
