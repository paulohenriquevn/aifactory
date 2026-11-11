// Builds the E2B template the factory's sandboxes start from, out of the same Dockerfile the Docker provider
// uses, so an agent finds the same tools on either. Run it again after changing ops/sandbox/Dockerfile, and
// bump the tag in E2B_TEMPLATE (e2b-sandbox.ts) with it:
//
//   node --env-file=.env.local scripts/build-e2b-template.mts
//
// Reads E2B_API_KEY from the environment and prints the template's name and id.
import { fileURLToPath } from 'node:url'

import { Template } from 'e2b'

import { E2B_TEMPLATE, E2B_TEMPLATE_RESOURCES } from '../src/server/factory/e2b-template.ts'

const dockerfile = fileURLToPath(new URL('../ops/sandbox/Dockerfile', import.meta.url))
const template = Template().fromDockerfile(dockerfile)

const built = await Template.build(template, E2B_TEMPLATE, {
  ...E2B_TEMPLATE_RESOURCES,
  onBuildLogs: (entry) => console.log(String(entry)),
})
console.log(JSON.stringify({ name: built.name, templateId: built.templateId, tags: built.tags }))
