import { z } from 'zod'

const check = z.object({ name: z.string().max(40), command: z.string().max(600) })

/** What may be changed on a repository, validated once at the boundary: the page's route and the guide's tool share it. */
export const repositoryPatchSchema = z.object({
  enabled: z.boolean().optional(),
  checks: z.array(check).max(20).nullable().optional(),
  egress: z.array(z.string().max(253)).max(50).optional(),
  baseBranch: z.string().max(100).nullable().optional(),
  releaseBranch: z.string().max(100).nullable().optional(),
  askQuestions: z.boolean().optional(),
  harness: z.string().max(40).nullable().optional(),
  reviewer: z.string().max(40).nullable().optional(),
  releaseMode: z.enum(['manual', 'trial', 'auto']).nullable().optional(),
})
