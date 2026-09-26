// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  obsidianReadToolNames,
  obsidianScopedDataTools,
  obsidianWriteToolNames
} from './obsidian-tools'
import { scopedDataToolByName, scopedDataTools, scopedReadToolNames } from './scoped-data-tools'

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  default?: unknown
  [key: string]: unknown
}

// Read the actual tools/list catalog without starting stdio or touching a vault.
const upstreamSource = readFileSync(new URL(
  '../../node_modules/@bitbonsai/mcpvault/dist/src/createServer.js', import.meta.url
), 'utf8')
const catalogSource = upstreamSource.match(/const tools = (\[[\s\S]*?\n\s*\]);/)
if (!catalogSource?.[1]) throw new Error('MCPVault tools/list catalog not found')
const upstreamTools = runInNewContext(catalogSource[1]) as {
  name: string
  inputSchema: JsonSchema
}[]

function schemaContract(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaContract)
  if (schema === null || typeof schema !== 'object') return schema
  return Object.fromEntries(Object.entries(schema)
    // These differ intentionally: model-facing wording and strict outer envelopes.
    .filter(([key, value]) => !['description', '$schema', 'additionalProperties', 'propertyNames'].includes(key)
      && !(key === 'required' && Array.isArray(value) && value.length === 0))
    .map(([key, value]) => [key, schemaContract(value)]))
}

describe('Obsidian scoped tools', () => {
  it('includes every upstream tool plus vault discovery in the shared provider catalog', () => {
    expect(upstreamTools).toHaveLength(18)
    expect(obsidianScopedDataTools.map((tool) => tool.name).sort()).toEqual([
      'obsidian_list_vaults', ...upstreamTools.map((tool) => `obsidian_${tool.name}`)
    ].sort())
    expect(new Set(obsidianScopedDataTools.map((tool) => tool.name)).size).toBe(19)
    for (const tool of obsidianScopedDataTools) {
      expect(scopedDataTools).toContain(tool)
      expect(scopedDataToolByName.get(tool.name)).toBe(tool)
    }
  })

  it.each(upstreamTools)('mirrors $name input fields, requiredness, defaults, and constraints', (upstream) => {
    const tool = obsidianScopedDataTools.find((entry) => entry.name === `obsidian_${upstream.name}`)!
    const local = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as JsonSchema
    expect(local.additionalProperties).toBe(false)
    expect(local.properties?.vaultId).toMatchObject({ type: 'string' })
    expect(local.required ?? []).not.toContain('vaultId')
    const properties = { ...local.properties }
    delete properties.vaultId
    expect(schemaContract({ ...local, properties })).toEqual(schemaContract(upstream.inputSchema))

    const minimal = Object.fromEntries((upstream.inputSchema.required ?? []).map((key) => {
      const field = upstream.inputSchema.properties![key]!
      return [key, Array.isArray(field.enum) ? field.enum[0]
        : field.type === 'array' ? [] : field.type === 'object' ? {}
          : field.type === 'number' ? 1 : 'note.md']
    }))
    const defaults = Object.fromEntries(Object.entries(upstream.inputSchema.properties ?? {})
      .filter(([, field]) => 'default' in field)
      .map(([key, field]) => [key, field.default]))
    expect(tool.inputSchema.parse(minimal)).toEqual({ ...minimal, ...defaults })
    expect(tool.inputSchema.parse({ ...minimal, vaultId: 'work' })).toEqual({
      ...minimal, ...defaults, vaultId: 'work'
    })
    expect(tool.inputSchema.safeParse({ ...minimal, readOnly: true }).success).toBe(false)
  })

  it.each([
    ['obsidian_list_vaults', {}],
    ['obsidian_list_directory', { path: '/', prettyPrint: false }],
    ['obsidian_list_all_tags', { prettyPrint: false }],
    ['obsidian_get_vault_stats', { recentCount: 5, prettyPrint: false }]
  ] as const)('allows %s without arguments', (name, expected) => {
    expect(scopedDataToolByName.get(name)!.inputSchema.parse({})).toEqual(expected)
  })

  it('preserves explicit values and arbitrary nested frontmatter', () => {
    const frontmatter = { title: '  Keep spaces  ', nested: { tags: ['one'], enabled: false }, count: 0 }
    expect(scopedDataToolByName.get('obsidian_write_note')!.inputSchema.parse({
      path: 'note.md', content: '', frontmatter, mode: 'append'
    })).toEqual({ path: 'note.md', content: '', frontmatter, mode: 'append' })
    expect(scopedDataToolByName.get('obsidian_update_frontmatter')!.inputSchema.parse({
      path: 'note.md', frontmatter, merge: false
    })).toEqual({ path: 'note.md', frontmatter, merge: false })
    expect(scopedDataToolByName.get('obsidian_search_notes')!.inputSchema.parse({
      query: ' x ', limit: 0, searchContent: false, searchFrontmatter: true,
      caseSensitive: true, pathPrefix: 'Projects', excludePaths: ['Archive'], prettyPrint: true
    })).toEqual({
      query: ' x ', limit: 0, searchContent: false, searchFrontmatter: true,
      caseSensitive: true, pathPrefix: 'Projects', excludePaths: ['Archive'], prettyPrint: true
    })
    for (const trashMode of ['none', 'local', 'system']) {
      expect(scopedDataToolByName.get('obsidian_delete_note')!.inputSchema.parse({
        path: 'note.md', confirmPath: 'note.md', trashMode
      })).toEqual({ path: 'note.md', confirmPath: 'note.md', trashMode })
    }
  })

  it('enforces the upstream batch limit without imposing it on metadata requests', () => {
    const paths = Array.from({ length: 11 }, (_, index) => `${index}.md`)
    expect(scopedDataToolByName.get('obsidian_read_multiple_notes')!.inputSchema.safeParse({ paths }).success).toBe(false)
    expect(scopedDataToolByName.get('obsidian_get_notes_info')!.inputSchema.safeParse({ paths }).success).toBe(true)
    expect(scopedDataToolByName.get('obsidian_manage_tags')!.inputSchema.parse({
      path: 'note.md', operation: 'list'
    })).toEqual({ path: 'note.md', operation: 'list' })
  })

  it('classifies mixed tag management as write and pure listing as read', () => {
    expect(obsidianWriteToolNames).toEqual([
      'obsidian_write_note', 'obsidian_patch_note', 'obsidian_delete_note',
      'obsidian_move_note', 'obsidian_move_file', 'obsidian_update_frontmatter', 'obsidian_manage_tags'
    ])
    expect(obsidianReadToolNames).toHaveLength(12)
    expect(obsidianReadToolNames).toEqual(expect.arrayContaining([
      'obsidian_list_vaults', 'obsidian_list_directory', 'obsidian_list_all_tags'
    ]))
    expect(scopedReadToolNames).toEqual(expect.arrayContaining(obsidianReadToolNames))
    expect(scopedReadToolNames).not.toContain('obsidian_manage_tags')
    for (const tool of obsidianScopedDataTools) {
      if (tool.name !== 'obsidian_list_vaults') expect(tool.description).toContain('obsidian_list_vaults')
      if (tool.access === 'write') expect(tool.description).toContain('explicit target vaultId')
    }
  })
})
