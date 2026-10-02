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

// PERF-16: SQLite belongs to a dedicated data process (utilityProcess); Main
// only routes messages. Files that imported DatabaseSync from 'node:sqlite'
// (including `import type`) on 2026-10-02. Shrink only.
const databaseSyncAllowlist = [
  'src/agent-daemon/agent-model-gateway.ts',
  'src/agent-daemon/event-journal.ts',
  'src/agent-daemon/installation-cleanup.ts',
  'src/agent-daemon/runtime-owner-registry.ts',
  'src/agent-daemon/semantic-prompt-store.ts',
  'src/main/agent/runtime-session-binding-store.ts',
  'src/main/assistant/assistant-database.ts',
  'src/main/assistant/assistant-storage-upgrade.ts',
  'src/main/assistant/story-graph-reader.ts',
  'src/main/assistant/subagent-progress-storage.ts',
  'src/main/assistant/supervision-experiences.ts',
  'src/main/assistant/supervision-review-store.ts',
  'src/main/assistant/supervision-stories.ts',
  'src/main/assistant/supervision-suggestions.ts',
  'src/main/assistant/supervision-timeline.ts',
  'src/main/conversation-attachment-storage.ts',
  'src/main/knowledge/external/external-knowledge-store.ts',
  'src/main/knowledge/knowledge-database.ts',
  'src/shared/node/private-sqlite-database.ts'
]

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
const databaseSyncRestriction = [{
  name: 'node:sqlite',
  importNames: ['DatabaseSync'],
  message: 'DatabaseSync may only be used by the data process (PERF-16); other code must go through its async interface (PERF-15). The allowlist in eslint.config.js must only shrink.'
}]
const syncFsRestriction = ['node:fs', 'fs', 'original-fs'].map(name => ({ name, importNames: syncFsFunctions, message: syncFsMessage }))
// Files under src/main (non-test) that used synchronous fs APIs on 2026-10-02. Shrink only.
const mainSyncFsAllowlist = [
  'src/main/agent/paged-output-store.ts',
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
// 2026-10-02, ceiling rounded up to the next 100. Only ever lower this number.
const appTsxMaxLines = 11700

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
  // Rules a (DatabaseSync) and b (sync fs) share `no-restricted-imports`, and a
  // later flat-config block replaces an earlier block's options for the same
  // rule. The blocks below therefore partition the files so that each file
  // gets exactly the restrictions it is subject to.
  // DatabaseSync outside the data process (all of src, both value and type imports).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', ...databaseSyncAllowlist],
    rules: { 'no-restricted-imports': ['error', { paths: databaseSyncRestriction }] }
  },
  // Synchronous fs in Main: files not allowlisted for either rule get both restrictions.
  {
    files: ['src/main/**/*.ts'],
    ignores: ['**/*.test.ts', ...mainSyncFsAllowlist, ...databaseSyncAllowlist],
    rules: { 'no-restricted-imports': ['error', { paths: [...databaseSyncRestriction, ...syncFsRestriction] }] }
  },
  // Main files allowlisted for DatabaseSync but not for sync fs.
  {
    files: databaseSyncAllowlist.filter(file => file.startsWith('src/main/')),
    ignores: mainSyncFsAllowlist,
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
