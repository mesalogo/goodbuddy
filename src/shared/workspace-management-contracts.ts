import { z } from 'zod'

const pathSchema = z.string().min(1).max(4096).refine((value) =>
  !value.includes('\0') && !/^(?:[A-Za-z]:|[\\/])/.test(value) &&
  !value.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git'),
'Expected a workspace relative path')
const branchSchema = z.string().min(1).max(1024).refine((value) => !value.startsWith('-') && !value.includes('\0'))
const oidSchema = z.string().regex(/^[a-f0-9]{40,64}$/)

export const workspaceManagementActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('createFile'), path: pathSchema }).strict(),
  z.object({ kind: z.literal('createDirectory'), path: pathSchema }).strict(),
  z.object({ kind: z.literal('move'), path: pathSchema, destination: pathSchema }).strict(),
  z.object({ kind: z.literal('delete'), path: pathSchema }).strict(),
  z.object({ kind: z.literal('properties'), path: pathSchema }).strict(),
  z.object({ kind: z.literal('branches') }).strict(),
  z.object({ kind: z.literal('switchBranch'), branch: branchSchema, remote: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('createBranch'), branch: branchSchema }).strict(),
  z.object({ kind: z.literal('fetch') }).strict(),
  z.object({ kind: z.literal('history'), offset: z.number().int().min(0), head: oidSchema.optional() }).strict(),
  z.object({ kind: z.literal('commitFiles'), oid: oidSchema }).strict(),
  z.object({ kind: z.literal('commitDiff'), oid: oidSchema, path: pathSchema }).strict()
])
export const workspaceManagementRequestSchema = z.object({
  projectId: z.string().uuid(), action: workspaceManagementActionSchema
}).strict()
export const workspaceManagementResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }).strict(),
  z.object({ kind: z.literal('properties'), path: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.number(), modifiedAt: z.string() }).strict(),
  z.object({ kind: z.literal('branches'), current: z.string(), branches: z.array(z.object({ name: z.string(), remote: z.boolean() })) }).strict(),
  z.object({ kind: z.literal('history'), head: oidSchema.optional(), hasMore: z.boolean(), commits: z.array(z.object({ oid: oidSchema, subject: z.string(), author: z.string(), time: z.string(), refs: z.string() })) }).strict(),
  z.object({ kind: z.literal('commitFiles'), files: z.array(z.object({ path: z.string(), status: z.string(), previousPath: z.string().optional() })) }).strict(),
  z.object({ kind: z.literal('commitDiff'), patch: z.string(), truncated: z.boolean() }).strict()
])
export type WorkspaceManagementAction = z.infer<typeof workspaceManagementActionSchema>
export type WorkspaceManagementResult = z.infer<typeof workspaceManagementResultSchema>
