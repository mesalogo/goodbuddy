import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// ---------------------------------------------------------------------------
// Architecture ratchets (docs/roadmap/product-performance-experience-improvement-plan.md,
// batch 3C, PERF-17). Existing code still violates these rules, so each rule
// carries an allowlist of the files that violated it when the rule was added.
// The allowlists must ONLY SHRINK: remove a file once it is fixed, never add
// one. New code that needs the forbidden API belongs in the place the plan
// assigns it (data process, async fs, domain store, layout shell).
// ---------------------------------------------------------------------------

// Concrete SQLite implementations, executed by storage owners or the remote Agent.
// Type imports do not grant permission to execute SQLite.
const databaseSyncAllowlist = [
  'src/agent-daemon/agent-model-gateway.ts',
  'src/agent-daemon/event-journal.ts',
  'src/agent-daemon/installation-cleanup.ts',
  'src/agent-daemon/runtime-owner-registry.ts',
  'src/agent-daemon/semantic-prompt-store.ts',
  'src/main/agent/runtime-session-binding-store.ts',
  'src/main/assistant/assistant-database.ts',
  'src/main/assistant/assistant-storage-upgrade.ts',
  'src/main/conversation-attachment-storage.ts',
  'src/main/knowledge/external/external-knowledge-store.ts',
  'src/main/knowledge/knowledge-database.ts',
  'src/shared/node/private-sqlite-database.ts'
]

// Explicit execution contexts, not a src/main or *worker* naming exemption.
const sqliteExecutionContexts = [
  'src/agent-daemon/agent-owned-acp-prompt.ts',
  'src/agent-daemon/daemon.ts',
  'src/agent-daemon/direct-linux-stdio-process-owner.ts',
  'src/agent-daemon/index.ts',
  'src/agent-daemon/runtime-composition.ts',
  'src/main/desktop-storage-owner.ts',
  'src/main/desktop-storage-files.ts',
  'src/main/desktop-storage-runtime-operations.ts',
  'src/main/desktop-storage-entry.ts',
  'src/main/desktop-storage-runtime-host-fixture.ts',
  'src/main/readonly-query-worker.ts',
  'src/main/assistant-storage-worker.ts',
  'src/main/agent/private-sqlite-database.ts'
]

// Match known module entry points, including the legacy opener re-export. This
// guards imports rather than trying to infer arbitrary transitive call graphs.
const sqliteValueImports = {
  'node:sqlite': ['DatabaseSync'],
  'private-sqlite-database': ['openPrivateSqliteDatabase', 'PreparedPrivateSqliteDatabaseFile'],
  'assistant-database': ['AssistantDatabase'],
  'knowledge-database': ['KnowledgeDatabase'],
  'external-knowledge-store': ['ExternalKnowledgeStore'],
  'conversation-attachment-storage': ['ConversationAttachmentStorage'],
  'runtime-session-binding-store': ['SqliteRuntimeSessionBindingStore'],
  'agent-model-gateway': ['AgentModelCallLedger'],
  'event-journal': ['EventJournal'],
  'runtime-owner-registry': ['RuntimeOwnerRegistry'],
  'semantic-prompt-store': ['SemanticPromptStore'],
  'assistant-storage-upgrade': ['getPendingAssistantStorageUpgrade', 'upgradeAssistantStorage'],
  'desktop-storage-owner': ['DesktopStorageOwner'],
  'desktop-storage-files': ['openDesktopStorageFiles'],
  'desktop-storage-runtime-operations': ['DesktopStorageRuntimeOwner']
}
const sqliteExecutionRule = {
  meta: { type: 'problem', schema: [], messages: {
    owner: 'SQLite value access belongs in an explicit storage owner, worker or remote Agent context (SA-07). Main must use the async storage interface; type imports are allowed.'
  } },
  create(context) {
    function check(node, source, specifiers) {
      if (node.importKind === 'type' || node.exportKind === 'type') return
      const path = source?.type === 'TemplateLiteral' && source.expressions.length === 0
        ? source.quasis[0].value.cooked : source?.value
      if (typeof path !== 'string') return
      const name = path.split('/').at(-1).replace(/\.(?:[cm]?[jt]s)$/, '')
      const restricted = /(?:^|\/)agent-daemon(?:\/index(?:\.[cm]?[jt]s)?)?$/.test(path)
        ? ['AgentModelCallLedger', 'EventJournal', 'RuntimeOwnerRegistry', 'SemanticPromptStore']
        : sqliteValueImports[name]
      if (!restricted) return
      if (!specifiers || specifiers.length === 0 || specifiers.some(specifier => {
        if (specifier.importKind === 'type' || specifier.exportKind === 'type') return false
        const imported = specifier.imported ?? specifier.local
        return !['ImportSpecifier', 'ExportSpecifier'].includes(specifier.type)
          || restricted.includes(imported?.name ?? imported?.value)
      })) context.report({ node, messageId: 'owner' })
    }
    return {
      ImportDeclaration: node => check(node, node.source, node.specifiers),
      ExportNamedDeclaration: node => check(node, node.source, node.specifiers),
      ExportAllDeclaration: node => check(node, node.source),
      ImportExpression: node => check(node, node.source),
      CallExpression: node => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') check(node, node.arguments[0])
      },
      TSImportEqualsDeclaration: node => check(node, node.moduleReference.expression)
    }
  }
}

// PERF-15/PERF-16 rule 1: Main must not block its event loop on file IO.
// Synchronous fs functions; also caught as `fs.xxxSync` member access.
const syncFsFunctions = [
  'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'closeSync', 'copyFileSync', 'cpSync',
  'existsSync', 'fchmodSync', 'fchownSync', 'fdatasyncSync', 'fstatSync', 'fsyncSync', 'ftruncateSync',
  'futimesSync', 'globSync', 'lchmodSync', 'lchownSync', 'linkSync', 'lstatSync', 'lutimesSync',
  'mkdirSync', 'mkdtempSync', 'opendirSync', 'openSync', 'readdirSync', 'readFileSync', 'readlinkSync',
  'readSync', 'readvSync', 'realpathSync', 'renameSync', 'rmdirSync', 'rmSync', 'statfsSync', 'statSync',
  'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync', 'writeSync', 'writevSync'
]
const syncFsMessage = 'Synchronous fs APIs block the Main event loop (PERF-17). Use node:fs/promises, or move the work to the data process (PERF-16).'
const syncFsRestriction = ['node:fs', 'fs', 'original-fs'].map(name => ({ name, importNames: syncFsFunctions, message: syncFsMessage }))
// Files under src/main (non-test) that used synchronous fs APIs on 2026-10-02. Shrink only.
const mainSyncFsAllowlist = [
  'src/main/assistant/assistant-database.ts',
  'src/main/assistant/assistant-storage-upgrade.ts',
  'src/main/conversation-attachment-storage.ts',
  'src/main/magic-notes/magic-note-storage.ts',
  'src/main/portable-user-data.ts',
  'src/main/remote-agent/control-plane-package-installer.ts',
  'src/main/windows-notification-identity.ts'
]

// PERF-13 rule 2: IPC subscriptions live in domain stores (*.ts), components
// subscribe to stores through selectors. React component files (*.tsx) that
// subscribed directly to window.goodbuddy.*.on* on 2026-10-02. Shrink only.
const rendererIpcSubscriptionAllowlist = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/DocumentResultPreview.tsx',
  'src/renderer/src/MagicNotesPanel.tsx',
  'src/renderer/src/MagicNotesWorkspace.tsx',
  'src/renderer/src/RightAssistantSidebar.tsx',
  'src/renderer/src/StaticHtmlPreview.tsx'
]
const rendererIpcSubscriptionMessage = 'Components must not subscribe to window.goodbuddy.*.on* directly (PERF-17). Move the subscription into a domain store and read it with a selector (PERF-13).'

// PERF-13 goal: App.tsx shrinks to a layout shell. 11,635 lines on
// 2026-10-02; 9,567 on 2026-10-03 after moving persistence, refresh and agent
// events out; 7,904 after moving the composer, route callbacks and the task
// store out. Ceiling rounded up to the next 100. Only ever lower this number.
const appTsxMaxLines = 8000

export default tseslint.config(
  {
    ignores: [
      '.agent-resources/**',
      '.remote-runtime-resources/**',
      '.runtime-resources/**',
      'coverage/**',
      'dist/**',
      'docs/**/*-demo.*',
      'docs/**/*-demo-*.js',
      'docs/**/vendor/**',
      'node_modules/**',
      'out/**',
      'temp/**',
      'shareserver/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ['build/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },
  {
    files: ['sites/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    files: ['sites/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ['**/*.test.{ts,tsx}', 'vitest.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.vitest
      }
    }
  },
  // --- Architecture ratchets (PERF-17), see allowlists at the top. ---------
  {
    files: ['src/**/*.{ts,tsx,js,mjs,cjs}'],
    ignores: ['**/*.test.{ts,tsx,js}', ...databaseSyncAllowlist, ...sqliteExecutionContexts],
    plugins: { architecture: { rules: { 'sqlite-execution-context': sqliteExecutionRule } } },
    rules: { 'architecture/sqlite-execution-context': 'error' }
  },
  // Synchronous fs in Main.
  {
    files: ['src/main/**/*.ts'],
    ignores: ['**/*.test.ts', ...mainSyncFsAllowlist],
    rules: { 'no-restricted-imports': ['error', { paths: syncFsRestriction }] }
  },
  // `fs.readFileSync(...)` style access through a namespace/default import.
  {
    files: ['src/main/**/*.ts'],
    ignores: ['**/*.test.ts', ...mainSyncFsAllowlist],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: `MemberExpression[object.name=/^(fs|nodeFs|fsSync|originalFs)$/][property.name=/^(${syncFsFunctions.join('|')})$/]`,
        message: syncFsMessage
      }]
    }
  },
  // Direct IPC subscriptions in renderer components.
  {
    files: ['src/renderer/src/**/*.tsx'],
    ignores: ['**/*.test.tsx', ...rendererIpcSubscriptionAllowlist],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name=/^on[A-Z]/] > MemberExpression.callee MemberExpression[object.name='window'][property.name='goodbuddy']",
        message: rendererIpcSubscriptionMessage
      }]
    }
  },
  // App.tsx size ceiling.
  {
    files: ['src/renderer/src/App.tsx'],
    rules: {
      'max-lines': ['error', { max: appTsxMaxLines, skipBlankLines: false, skipComments: false }]
    }
  }
)
