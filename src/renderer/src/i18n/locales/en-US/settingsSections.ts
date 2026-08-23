import type { TranslationShape } from '../../resource-types'
import type {
  settingsSections as chineseSettingsSections
} from '../zh-CN/settingsSections'

export const settingsSections = {
  modelDownloadSources: {
    modelscope: 'ModelScope',
    'hugging-face': 'Hugging Face'
  },
  speech: {
    title: 'Speech models',
    description:
      'Model weights are not bundled. Download them as needed or move them offline with ZIP archives.',
    openModelsDirectory: 'Open models directory',
    modelSelector: 'Current speech model',
    modelSelectorDescription:
      'Choose an installed model, then select Save settings to switch speech recognition models.',
    modelSelectorDownloadDescription:
      'This model is not installed. Download it or import it from a ZIP archive first.',
    pendingSelection:
      'The model change is pending. Select Save settings to apply it.',
    catalogUnavailable: 'No speech model catalog is available.',
    loading: 'Loading speech models…',
    errors: {
      serviceUnavailable:
        'Speech model services are not available in this version',
      readFailed: 'Could not load speech models',
      operationFailed: 'The speech model operation failed'
    },
    quality: {
      basic: 'Basic quality',
      balanced: 'Balanced quality',
      high: 'High quality'
    },
    speed: {
      fast: 'Fast',
      balanced: 'Balanced speed',
      slow: 'Slower'
    },
    family: {
      sensevoice: 'SenseVoice',
      paraformer: 'Paraformer',
      whisper: 'Whisper'
    },
    operations: {
      installing: 'Verifying and installing',
      preparingImport: 'Preparing import',
      preparingDownloadFrom: 'Preparing to download from {{source}}',
      importing: 'Importing',
      downloadingFrom: 'Downloading from {{source}}',
      processingFile: 'Processing {{file}}'
    },
    status: {
      inUse: 'In use',
      pendingSave: 'Pending save',
      installed: 'Installed',
      manualImport: 'Manual import',
      availableToDownload: 'Available to download',
      sourceUnavailable: 'Unavailable from current source',
      unknownSize: 'Unknown size'
    },
    tags: {
      recommended: 'Recommended'
    },
    actions: {
      cancel: 'Cancel',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      download: 'Download',
      openDownloadSourceSettings: 'Open General settings',
      importZip: 'Import ZIP',
      exportZip: 'Export ZIP'
    },
    accessibility: {
      cancelOperation: 'Cancel the {{name}} operation',
      deleteModel: 'Delete {{name}}',
      downloadModel: 'Download {{name}}',
      importModelZip: 'Import {{name}} from a ZIP archive',
      exportModelZip: 'Export {{name}} as a ZIP archive',
      downloadProgress: '{{name}} download progress',
      openRepository: 'Open the {{source}} repository for {{name}}'
    },
    notifications: {
      installed: '{{name}} installed',
      importedZip: '{{name}} imported from ZIP',
      exportedZip: '{{name}} exported as ZIP',
      removed: 'Speech model deleted'
    },
    sourceUnavailableDescription:
      '{{source}} does not currently provide the complete verified files for this model. You can still import a ZIP archive or explicitly change the source in General settings.',
    languages: {
      中文: 'Chinese',
      粤语: 'Cantonese',
      英语: 'English',
      日语: 'Japanese',
      韩语: 'Korean',
      多语言: 'Multilingual'
    },
    catalog: {
      'sensevoice-small-int8': {
        displayName: 'SenseVoiceSmall INT8',
        description:
          'Fast Chinese speech recognition with Cantonese, English, Japanese, and Korean support, optimized for local CPUs.'
      },
      'whisper-tiny-multilingual': {
        displayName: 'Whisper Tiny (Multilingual)',
        description:
          'A compact multilingual OpenAI Whisper Tiny alternative that supports Chinese and many other languages.'
      },
      'paraformer-bilingual-zh-en-int8': {
        displayName: 'Paraformer Chinese-English INT8',
        description:
          'Fast offline Mandarin and English recognition for primarily Chinese dictation with occasional English.'
      },
      'paraformer-trilingual-zh-yue-en-int8': {
        displayName: 'Paraformer Chinese-Cantonese-English INT8',
        description:
          'Offline Mandarin, Cantonese, and English recognition for multilingual and Cantonese input.'
      },
      'whisper-small-multilingual-int8': {
        displayName: 'Whisper Small (Multilingual) INT8',
        description:
          'A balanced multilingual model with much better recognition quality than Tiny for general dictation.'
      },
      'whisper-medium-multilingual-int8': {
        displayName: 'Whisper Medium (Multilingual) INT8',
        description:
          'A high-quality multilingual model for situations where accuracy matters more than slower CPU inference.'
      }
    }
  },
  embedding: {
    label: 'Embedding model',
    title: 'Embedding model connections',
    description:
      'Choose and configure the built-in local model or an OpenAI-compatible service for vector retrieval.',
    enabled: 'Enable vector retrieval',
    currentConnection: 'Current connection',
    connections: {
      heading: 'Connections',
      listLabel: 'Embedding model connection list',
      empty: 'No embedding model connections are available.',
      types: {
        builtin: 'GoodBuddy built-in connection',
        'openai-compatible': 'OpenAI-compatible connection'
      },
      current: 'Currently in use',
      model: 'Model: {{model}}',
      endpoint: 'Endpoint: {{endpoint}}',
      credentialConfigured: 'Credentials configured',
      credentialMissing: 'Credentials not configured',
      status: 'Status: {{status}}',
      modelLabel: 'Model',
      statusLabel: 'Status'
    },
    actions: {
      addCustom: 'Add custom',
      test: 'Test',
      delete: 'Delete',
      download: 'Download',
      cancel: 'Cancel',
      importZip: 'Import ZIP',
      remove: 'Remove model',
      clearCredential: 'Clear credential',
      clearAfterSave: 'Credential will be cleared on save'
    },
    accessibility: {
      select: 'Edit embedding connection {{name}}',
      test: 'Test embedding connection {{name}}',
      delete: 'Delete embedding connection {{name}}',
      download: 'Download {{name}}',
      cancel: 'Cancel download for {{name}}',
      import: 'Import {{name}} from ZIP',
      remove: 'Remove local model {{name}}'
    },
    fields: {
      name: 'Name',
      endpoint: 'Embedding API URL',
      model: 'Model name',
      authentication: 'Authentication',
      noAuthentication: 'No authentication',
      apiKey: 'API Key (optional)',
      apiKeyPlaceholder:
        'Leave blank for a local service without authentication',
      configuredPlaceholder: 'Configured — enter a new value to replace'
    },
    endpointDestination: {
      local:
        'Knowledge chunks and queries will be sent to {{host}} on this device.',
      network:
        'Indexing sends knowledge chunks to {{host}}; retrieval sends queries.'
    },
    model: {
      heading: 'Current embedding model',
      configured: 'Configured model',
      provider: 'Provider: {{provider}}',
      credentialConfigured: 'Credentials configured',
      credentialMissing: 'Credentials not configured',
      endpoint: 'Endpoint: '
    },
    diagnostic: {
      success: 'Test succeeded',
      failed: 'Test failed',
      result:
        'The service returned a {{dimensions}}-dimensional vector in {{latency}} ms.',
      checkedAt: 'Tested: {{date}}',
      remedy: 'Suggested action: {{remedy}}',
      testing: 'Testing…',
      test: 'Test embedding model',
      notice:
        'The test sends one real request to the current service and does not change the knowledge index.'
    }
  },
  roles: {
    title: 'Roles and prompts',
    description: 'Manage chat roles and their trusted system prompts',
    newRole: 'New role',
    notice:
      'An individual role can use an assigned model. Synthesis mode and expert teams always inherit the default model.',
    listLabel: 'Role list',
    listTitle: 'Roles',
    editRole: 'Edit role {{name}}',
    noDescription: 'No description',
    details: 'Role details',
    fields: {
      name: 'Role name',
      description: 'Role description',
      systemPrompt: 'System prompt',
      systemPromptHelp:
        'Sent to the text model as trusted instructions. Do not include API keys or private data. {{count}} / 20,000 characters entered.',
      modelConnection: 'Model connection',
      modelConnectionAria: 'Role model connection',
      inheritDefault: 'Inherit default model',
      inheritDefaultNamed: 'Inherit default model ({{name}})',
      unavailableConnection: 'Previous model connection is unavailable',
      modelHelp:
        'An inherited model follows changes to the default connection. An assigned connection applies only to this role.',
      modelFallbackNamed:
        'The assigned model connection is unavailable. The runtime will fall back to the default model “{{name}}”. Select an available connection or inherit the default model.',
      modelFallback:
        'The assigned model connection is unavailable. The runtime will fall back to the current default model. Select an available connection or inherit the default model.',
      routingKeywords: 'Routing keywords',
      routingSeparator: ', ',
      routingPlaceholder:
        'For example: code review, TypeScript, performance analysis',
      routingHelp:
        'Separate keywords with commas or line breaks. They are normalized and deduplicated when saved. Up to 32 keywords, each 2–48 characters.'
    },
    validation: {
      tooManyKeywords: 'Use no more than 32 routing keywords.',
      invalidKeyword: 'Keyword “{{keyword}}” must be 2–48 characters.'
    },
    errors: {
      readFailed: 'Could not load roles',
      saveFailed: 'Could not save the role',
      deleteFailed: 'Could not delete the role'
    },
    delete: {
      confirmAria: 'Confirm deletion of role {{name}}',
      label: 'Delete role',
      triggerAria: 'Delete role {{name}}',
      message:
        'After deletion, this role will be removed from chat selection and expert teams.'
    },
    actions: {
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save role',
      create: 'Create role'
    },
    empty:
      'No roles yet. Create a role to configure its system prompt.'
  },
  platformFeatures: {
    loading: 'Loading platform feature settings…',
    errors: {
      serviceUnavailable:
        'Application settings are not available in this version',
      readFailed: 'Could not load platform feature settings',
      saveMagicNotesFailed: 'Could not save Magic Notes settings. Try again.',
      saveIncompleteTodoCountFailed:
        'Could not save the incomplete to-do count setting. Try again.',
      saveCommentModeFailed:
        'Could not save the AI comment mode. Try again.',
      saveCommentFormatFailed:
        'Could not save the AI comment format. Try again.',
      saveModelDownloadSourceFailed:
        'Could not save the model download source. Try again.'
    },
    label: 'Platform feature options',
    tabs: {
      ariaLabel: 'Platform feature settings',
      general: 'General',
      magicNotes: 'Magic Notes'
    },
    shortcut: {
      title: 'Global quick access',
      description:
        'Show or hide GoodBuddy while another application is active.',
      enabled: 'Enable global shortcut',
      accelerator: 'Shortcut',
      recorderHelp:
        'Focus this field and press a key combination, or enter an Electron accelerator such as CommandOrControl+Shift+Space.',
      reset: 'Reset to default',
      save: 'Save shortcut',
      saving: 'Saving…',
      saved: 'Global shortcut updated',
      loading: 'Loading shortcut status…',
      status: {
        registered: 'Registered: {{shortcut}}',
        disabled: 'The global shortcut is disabled.',
        conflict:
          'Another application is using this shortcut. Record a different combination and save it.',
        failed:
          'The system could not register this shortcut. Record another combination or check system shortcut settings.'
      },
      errors: {
        serviceUnavailable:
          'Shortcut settings are not available in this version',
        readFailed: 'Could not load shortcut settings. Try again.',
        invalidAccelerator:
          'Enter a valid key combination that includes a modifier.',
        conflict:
          'Another application is using this shortcut. Record a different combination and try again.',
        registrationFailed:
          'The system could not register this shortcut. Choose another combination or check system shortcut settings.',
        saveFailed:
          'The shortcut could not be saved. The previous working shortcut is still active. Try again.'
      }
    },
    modelDownloadSource: {
      title: 'Model download source',
      description:
        'Choose the platform for future GoodBuddy-managed local model downloads. Installed models, ZIP imports, Ollama models, and app updates are not affected.',
      options: {
        modelscope:
          'Default. Use when your network prioritizes access to ModelScope.',
        'hugging-face':
          'Use when your network can access Hugging Face reliably.'
      },
      notification: 'Model download source changed to {{source}}.'
    },
    magicNotes: {
      title: 'Magic Notes',
      description:
        'Off by default. Enable it to capture notes and to-dos and analyze content with AI.',
      showEntry: 'Show Magic Notes',
      showIncompleteTodoCount: 'Show incomplete to-do count',
      showIncompleteTodoCountHelp:
        'Shows the number of incomplete to-dos beside Magic Notes in the primary navigation. Counts above 99 appear as 99+.',
      commentMode: 'AI comment mode',
      commentModeAria: 'Magic Notes AI comment mode',
      modes: {
        immediate: 'Immediate',
        afterSaveAuto: 'Automatic after save',
        afterSaveManual: 'Manual after save'
      },
      commentModeHelp:
        'Immediate mode comments on an unsaved draft 5 seconds after you press Enter and stop typing. Automatic mode comments after saving. Manual mode comments only after you select Analyze with AI.',
      commentFormat: 'AI comment format',
      commentFormatAria: 'Magic Notes AI comment format',
      formats: {
        combined: 'Long-form + points',
        narrative: 'Long-form',
        structured: 'Points'
      },
      commentFormatHelp:
        'By default, AI generates both a streaming long-form comment and structured points. You can keep only one format instead.'
    }
  },
  skills: {
    runtimeLabels: {
      model: 'Model',
      opencode: 'OpenCode',
      continue: 'Continue',
      'deepseek-harness': 'DeepSeek Harness'
    },
    errors: {
      readFailed: 'Could not load Skills',
      operationFailed: 'The Skill operation failed'
    },
    actions: {
      importDirectory: 'Import Skill directory',
      importZip: 'Import Skill ZIP',
      delete: 'Delete'
    },
    listLabel: 'Skills list',
    notice:
      'Newly imported Skills are enabled by default and assigned to the direct model, OpenCode, Continue, and DeepSeek Harness.',
    loading: 'Loading Skills…',
    source: {
      builtin: 'Built in',
      imported: 'Imported'
    },
    versionMissing: 'Version not specified',
    enableAria: 'Enable {{name}}',
    enabled: 'Enabled',
    disabled: 'Disabled',
    assignedTo: 'Assigned to',
    deleteAria: 'Delete {{name}}'
  },
  updates: {
    label: 'Update settings',
    errors: {
      serviceUnavailable:
        'Version checks are not available in this version',
      readSettingsFailed: 'Could not load application settings',
      saveSettingsFailed: 'Could not save update settings',
      saveSourceFailed: 'Could not save the update source',
      checkFailed: 'Version check failed',
      network: '{{fallback}}. Check the system status and try again.',
      sourceNetwork:
        '{{fallback}}: Could not connect to update source "{{source}}". Check your network or proxy and try again.'
    },
    loadingAppInfo: 'Loading application information…',
    source: {
      label: 'Update source',
      description:
        'Used for manual checks, startup checks, and the download page.',
      options: {
        github: 'GitHub (default)',
        mirror: 'Mirror node'
      },
      names: {
        github: 'GitHub',
        mirror: 'Mirror node'
      }
    },
    checkOnStartup: 'Check for updates at startup',
    actions: {
      checking: 'Checking…',
      checkNow: 'Check for updates now',
      openDownloadPage: 'Open download page'
    },
    result: {
      available: 'New version {{version}} is available',
      current: 'You have the latest version',
      target: 'Current: {{version}} · {{platform}}/{{arch}}',
      safety:
        'Verify the file name and SHA-256 on the release page before downloading. GoodBuddy never downloads or runs installers automatically.'
    }
  }
} satisfies TranslationShape<typeof chineseSettingsSections>
