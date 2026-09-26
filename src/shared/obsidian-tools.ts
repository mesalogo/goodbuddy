import { z } from 'zod'
import type { ScopedDataToolDefinition } from './scoped-data-tools'

const vaultId = z.string().optional().describe(
  'Vault ID returned by obsidian_list_vaults. May be omitted when only one vault is available.'
)
const path = z.string().describe('Path to the note relative to vault root')
const prettyPrint = z.boolean().default(false).describe('Format JSON response with indentation')
const vaultSelection = ' When multiple vaults are available, first call obsidian_list_vaults and select the intended vault using vaultId.'
const writeVaultSelection = vaultSelection + ' Writes require an explicit target vaultId when multiple vaults are available; ask the user if the target is unclear.'

// Mirror MCPVault 0.16.0 tools/list inputs. Defaults remain optional on input;
// strictness applies only to the argument envelope, not frontmatter keys.
export const obsidianScopedDataTools = [
  {
    name: 'obsidian_list_vaults',
    displayName: 'List Obsidian vaults',
    title: 'List available Obsidian vaults',
    description: 'List available Obsidian vaults and their IDs. Call this first when multiple vaults are available, then pass the intended vaultId to other Obsidian tools. Writes require an explicit target vaultId when multiple vaults are available; ask the user if the target is unclear.',
    summary: 'Discover available vaults and select a target.',
    access: 'read',
    inputSchema: z.object({}).strict()
  },
  {
    name: 'obsidian_read_note',
    displayName: 'Read Obsidian note',
    title: 'Read an Obsidian note',
    description: 'Read a note and its frontmatter from the vault.' + vaultSelection,
    summary: 'Read note content and frontmatter.',
    access: 'read',
    inputSchema: z.object({ vaultId, path, prettyPrint }).strict()
  },
  {
    name: 'obsidian_write_note',
    displayName: 'Write Obsidian note',
    title: 'Write an Obsidian note',
    description: 'Create or write a note. mode defaults to overwrite; use append or prepend to add content. Supply frontmatter when needed.' + writeVaultSelection,
    summary: 'Write, append, or prepend note content.',
    access: 'write',
    inputSchema: z.object({
      vaultId, path,
      content: z.string().describe('Content of the note'),
      frontmatter: z.record(z.string(), z.unknown()).optional().describe('Frontmatter object'),
      mode: z.enum(['overwrite', 'append', 'prepend']).default('overwrite')
    }).strict()
  },
  {
    name: 'obsidian_patch_note',
    displayName: 'Patch Obsidian note',
    title: 'Replace text in an Obsidian note',
    description: 'Replace an exact string, including whitespace and line breaks, without rewriting the entire note. Multiple matches fail unless replaceAll is true.' + writeVaultSelection,
    summary: 'Replace exact text in a note.',
    access: 'write',
    inputSchema: z.object({
      vaultId, path,
      oldString: z.string().describe('Exact string to replace, including whitespace and line breaks'),
      newString: z.string().describe('Replacement string'),
      replaceAll: z.boolean().default(false)
    }).strict()
  },
  {
    name: 'obsidian_list_directory',
    displayName: 'List Obsidian directory',
    title: 'List files and directories in an Obsidian vault',
    description: 'List files and directories, including non-note filenames. Omit path to list the vault root.' + vaultSelection,
    summary: 'Browse vault files and directories.',
    access: 'read',
    inputSchema: z.object({
      vaultId,
      path: z.string().default('/').describe('Path relative to vault root'),
      prettyPrint
    }).strict()
  },
  {
    name: 'obsidian_delete_note',
    displayName: 'Delete Obsidian note',
    title: 'Delete an Obsidian note',
    description: 'Delete a note. confirmPath must exactly match path. trashMode defaults to none (permanent deletion); local moves to the vault .trash and system moves to OS trash.' + writeVaultSelection,
    summary: 'Delete a note using the selected trash mode.',
    access: 'write',
    inputSchema: z.object({
      vaultId, path,
      confirmPath: z.string().describe('Must exactly match path to confirm deletion'),
      trashMode: z.enum(['none', 'local', 'system']).default('none')
    }).strict()
  },
  {
    name: 'obsidian_search_notes',
    displayName: 'Search Obsidian notes',
    title: 'Search Obsidian note content or frontmatter',
    description: 'Search notes by text, optionally including frontmatter, restricting to pathPrefix, or excluding subtrees with excludePaths. Results default to 5; upstream caps results at 20.' + vaultSelection,
    summary: 'Search notes in a vault or subtree.',
    access: 'read',
    inputSchema: z.object({
      vaultId,
      query: z.string().describe('Search query text'),
      limit: z.number().default(5).describe('Maximum results (default 5, upstream maximum 20)'),
      searchContent: z.boolean().default(true),
      searchFrontmatter: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      pathPrefix: z.string().optional().describe('Restrict search to this directory prefix, e.g. Projects/2026'),
      excludePaths: z.array(z.string()).optional().describe('Directory prefixes to exclude, e.g. Archive or meta'),
      prettyPrint
    }).strict()
  },
  {
    name: 'obsidian_move_note',
    displayName: 'Move Obsidian note',
    title: 'Move or rename an Obsidian note',
    description: 'Move or rename a note within the vault. Existing destinations are not overwritten unless overwrite is true.' + writeVaultSelection,
    summary: 'Move or rename a note.',
    access: 'write',
    inputSchema: z.object({
      vaultId,
      oldPath: z.string().describe('Current path of the note'),
      newPath: z.string().describe('New path for the note'),
      overwrite: z.boolean().default(false)
    }).strict()
  },
  {
    name: 'obsidian_move_file',
    displayName: 'Move Obsidian file',
    title: 'Move or rename any file in an Obsidian vault',
    description: 'Move or rename any file, including binary attachments, within the vault. Files only, not directories. confirmOldPath and confirmNewPath must exactly match oldPath and newPath.' + writeVaultSelection,
    summary: 'Move or rename a file with path confirmation.',
    access: 'write',
    inputSchema: z.object({
      vaultId,
      oldPath: z.string().describe('Current path of the file'),
      newPath: z.string().describe('New path for the file'),
      confirmOldPath: z.string().describe('Must exactly match oldPath'),
      confirmNewPath: z.string().describe('Must exactly match newPath'),
      overwrite: z.boolean().default(false)
    }).strict()
  },
  {
    name: 'obsidian_read_multiple_notes',
    displayName: 'Read multiple Obsidian notes',
    title: 'Read up to ten Obsidian notes',
    description: 'Read up to 10 notes in a batch. Content and frontmatter are included by default; disable either when only the other is needed.' + vaultSelection,
    summary: 'Read a batch of notes.',
    access: 'read',
    inputSchema: z.object({
      vaultId,
      paths: z.array(z.string()).max(10).describe('Note paths to read'),
      includeContent: z.boolean().default(true),
      includeFrontmatter: z.boolean().default(true),
      prettyPrint
    }).strict()
  },
  {
    name: 'obsidian_update_frontmatter',
    displayName: 'Update Obsidian frontmatter',
    title: 'Update note frontmatter without changing content',
    description: 'Update frontmatter while preserving note content. merge defaults to true; set false to replace existing frontmatter.' + writeVaultSelection,
    summary: 'Merge or replace note frontmatter.',
    access: 'write',
    inputSchema: z.object({
      vaultId, path,
      frontmatter: z.record(z.string(), z.unknown()).describe('Frontmatter object to update'),
      merge: z.boolean().default(true)
    }).strict()
  },
  {
    name: 'obsidian_get_notes_info',
    displayName: 'Get Obsidian note metadata',
    title: 'Get metadata for Obsidian notes',
    description: 'Get metadata for multiple notes without reading their full content.' + vaultSelection,
    summary: 'Read metadata for note paths.',
    access: 'read',
    inputSchema: z.object({
      vaultId,
      paths: z.array(z.string()).describe('Note paths to get metadata for'),
      prettyPrint
    }).strict()
  },
  {
    name: 'obsidian_get_frontmatter',
    displayName: 'Get Obsidian frontmatter',
    title: 'Read an Obsidian note\'s frontmatter',
    description: 'Extract frontmatter from a note without returning its content.' + vaultSelection,
    summary: 'Read only note frontmatter.',
    access: 'read',
    inputSchema: z.object({ vaultId, path, prettyPrint }).strict()
  },
  {
    name: 'obsidian_manage_tags',
    displayName: 'Manage Obsidian tags',
    title: 'Add, remove, or list tags on an Obsidian note',
    description: 'Add, remove, or list tags on one note. Supply tags for add and remove; omit tags for list.' + writeVaultSelection,
    summary: 'Manage tags on a note.',
    access: 'write',
    inputSchema: z.object({
      vaultId, path,
      operation: z.enum(['add', 'remove', 'list']),
      tags: z.array(z.string()).optional().describe('Tags, required by upstream for add and remove operations')
    }).strict()
  },
  {
    name: 'obsidian_get_vault_stats',
    displayName: 'Get Obsidian vault statistics',
    title: 'Get Obsidian vault statistics and recent files',
    description: 'Get total notes, folders, size, and recently modified files to understand vault scope before batch operations. recentCount defaults to 5; upstream caps it at 20.' + vaultSelection,
    summary: 'Read vault totals and recent files.',
    access: 'read',
    inputSchema: z.object({
      vaultId,
      recentCount: z.number().default(5).describe('Recent files to return (default 5, upstream maximum 20)'),
      prettyPrint
    }).strict()
  },
  {
    name: 'obsidian_list_all_tags',
    displayName: 'List Obsidian tags',
    title: 'List all tags across an Obsidian vault',
    description: 'List frontmatter tags and inline hashtags with occurrence counts, deduplicated and sorted by frequency. Use this to discover existing tags before organizing notes.' + vaultSelection,
    summary: 'Discover vault tags and their counts.',
    access: 'read',
    inputSchema: z.object({ vaultId, prettyPrint }).strict()
  },
  {
    name: 'obsidian_wiki_link',
    displayName: 'Read Obsidian wiki link',
    title: 'Resolve and read an Obsidian wiki link',
    description: 'Read the note referenced by a wiki link, e.g. [[Document Name|Display]] or [[folder/Document Name]]. Display text and #fragments are ignored. Do not include the .md extension. Duplicate basenames resolve vault-root first, then alphabetically by path, with alternatives reported.' + vaultSelection,
    summary: 'Resolve a wiki link to note content.',
    access: 'read',
    inputSchema: z.object({
      vaultId,
      document: z.string().describe('Document name or wiki link; omit .md because upstream appends it'),
      prettyPrint
    }).strict()
  },
  {
    name: 'obsidian_get_note_outline',
    displayName: 'Get Obsidian note outline',
    title: 'Get an Obsidian note\'s heading structure',
    description: 'Get headings with levels, text, and line numbers. Use this first for large notes, then obsidian_read_note_lines to read the section needed.' + vaultSelection,
    summary: 'Read heading structure and line numbers.',
    access: 'read',
    inputSchema: z.object({ vaultId, path, prettyPrint }).strict()
  },
  {
    name: 'obsidian_read_note_lines',
    displayName: 'Read Obsidian note lines',
    title: 'Read a line range from an Obsidian note',
    description: 'Read an inclusive, 1-indexed line range. Use after obsidian_get_note_outline to retrieve only the section needed.' + vaultSelection,
    summary: 'Read selected lines of a note.',
    access: 'read',
    inputSchema: z.object({
      vaultId, path,
      startLine: z.number().describe('First line to read (1-indexed, inclusive)'),
      endLine: z.number().describe('Last line to read (1-indexed, inclusive)'),
      prettyPrint
    }).strict()
  }
] as const satisfies readonly ScopedDataToolDefinition[]

export const obsidianReadToolNames = obsidianScopedDataTools
  .filter((tool) => tool.access === 'read')
  .map((tool) => tool.name)

export const obsidianWriteToolNames = obsidianScopedDataTools
  .filter((tool) => tool.access === 'write')
  .map((tool) => tool.name)
