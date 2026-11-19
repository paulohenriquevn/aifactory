/**
 * The toolchain the sandbox image carries, one place for the Docker image and the E2B template, which are
 * both built from ops/sandbox/Dockerfile. sandbox-toolchain.test.ts fails when the Dockerfile names others.
 */
export const SANDBOX_TOOLCHAIN = {
  node: '22.23.5',
  pnpm: '12.8.1',
  /** The headers are the ones of the image's own Node, in this directory, so node-gyp downloads nothing. */
  nodeHeaders: '22.23.5',
  nodeHeadersDir: '/usr/local',
}
