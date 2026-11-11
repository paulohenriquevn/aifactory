/**
 * The E2B template the factory's sandboxes start from, built from ops/sandbox/Dockerfile by
 * scripts/build-e2b-template.mts. The tag moves with the Dockerfile, so a sandbox never starts from an
 * image older than the code that expects it.
 */
export const E2B_TEMPLATE = 'aifactory-sandbox:3'

/**
 * What each sandbox gets. A run builds and tests a pnpm monorepo, which needs about what the Docker
 * provider gives a container (3 CPUs, 5 GB); E2B's free plan allows up to 8 vCPUs and 8 GiB.
 */
export const E2B_TEMPLATE_RESOURCES = { cpuCount: 4, memoryMB: 8192 }
