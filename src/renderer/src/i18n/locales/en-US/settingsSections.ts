import type { TranslationShape } from '../../resource-types'
import type {
  settingsSections as chineseSettingsSections
} from '../zh-CN/settingsSections'

export const settingsSections = {
  modelDownloadSources: {
    modelscope: 'ModelScope',
    'hugging-face': 'Hugging Face'
  },
  sshHosts: {
    loading: 'Loading SSH hosts…',
    loadFailedTitle: 'Could not load SSH hosts',
    listLabel: 'SSH host list',
    securityNotice:
      'When a host is added or edited, GoodBuddy inspects its host key before sending credentials and running a bounded system probe. The host and encrypted password are saved only after every step succeeds.',
    secureStorageUnavailable:
      'System secure storage is unavailable, so SSH passwords cannot be added or replaced. System SSH Agent authentication remains available.',
    empty: {
      title: 'No SSH hosts configured',
      description:
        'Use the guided flow to verify the host identity, authenticate, and probe the remote system. Cancelled or failed hosts are not retained.'
    },
    fields: {
      name: 'Host name',
      hostname: 'Host address',
      port: 'Port',
      username: 'Username',
      authentication: 'Authentication',
      passwordAction: 'Password handling',
      password: 'SSH password'
    },
    authentication: {
      password: 'Password',
      'system-agent': 'System SSH Agent'
    },
    passwordActions: {
      keep: 'Keep saved password',
      replace: 'Enter a new password'
    },
    passwordHelp:
      'The password is used only for this authentication attempt. After validation succeeds, the Main process writes it to system secure storage. It is never written to command-line arguments, logs, or regular settings files.',
    credentialSources: {
      none: 'Not configured',
      encrypted: 'Encrypted by system secure storage',
      'system-agent': 'Using the system SSH Agent',
      unreadable: 'Saved, but currently unreadable'
    },
    status: {
      credential: 'Credential',
      validation: 'Validation',
      validated: 'Validated and saved',
      needsValidation: 'Revalidation required'
    },
    hostKey: {
      title: 'SSH host key',
      verified: 'Pinned',
      unverified: 'Not verified',
      firstUse: 'This is the first host key observed for this host.',
      matches: 'The observed host key matches the pinned key.',
      changed:
        'The host key changed. The server may have been reinstalled, or this may be a machine-in-the-middle attack.',
      previousFingerprint: 'Previously pinned fingerprint',
      observedFingerprint: 'Observed fingerprint',
      verifyOutOfBand:
        'Verify the SHA-256 fingerprint with an administrator or another trusted channel. Do not accept it solely because the address looks correct.',
      confirmedOutOfBand:
        'I verified this fingerprint through a trusted channel'
    },
    testResult:
      'Connected · {{platform}}/{{architecture}} · {{latency}} ms',
    environment: {
      title: 'Remote environment',
      description:
        'Updating this Host may replace the Agent and Runtime and interrupt active remote work. Host configuration and project files are preserved.',
      loading: 'Loading Agent and Runtime versions…',
      notChecked:
        'Versions have not been checked. This page does not connect automatically; select Refresh versions to check.',
      methodLabel: 'Installation method',
      methodSelectorNamed:
        'Remote environment installation method for {{name}}',
      actions: {
        install: 'Install remote environment',
        installNamed: 'Install the remote environment for {{name}}',
        update: 'Update remote environment',
        updateNamed: 'Update the remote environment for {{name}}',
        reinstall: 'Reinstall',
        reinstallNamed: 'Reinstall the remote environment for {{name}}'
      },
      cancelUpdate: 'Cancel update',
      cancelUpdateNamed: 'Cancel the remote environment update for {{name}}',
      cancelling: 'Cancelling…',
      refresh: 'Refresh versions',
      refreshNamed: 'Refresh remote environment versions for {{name}}',
      progress: {
        preparing: 'Preparing installation…',
        probing: 'Checking the remote Host environment…',
        downloading: 'Transferring the environment package…',
        verifying: 'Verifying the environment package…',
        applying: 'Applying the remote environment…',
        'installing-agent': 'Installing GoodBuddy Agent…',
        'installing-runtime': 'Installing Runtime…',
        'checking-health': 'Checking the remote environment…',
        finalizing: 'Finalizing the remote environment update…',
        complete: 'Remote environment installation complete',
        cancelling: 'Cancelling the remote environment update…'
      },
      methods: {
        auto: 'Automatic',
        'remote-download': 'Host download',
        'goodbuddy-transfer': 'GoodBuddy transfer'
      },
      sources: {
        github: 'GitHub',
        mirror: 'mirror node'
      },
      remoteDownloadUnavailable: {
        'package-unavailable':
          'The current source has no package for this Host. You can still install through GoodBuddy.',
        'missing-tools':
          'The remote Host lacks a system tool required to download or unpack the package. You can still install through GoodBuddy.',
        'home-unwritable':
          'The remote user directory is not writable. Fix its permissions and refresh, or install through GoodBuddy.',
        'insufficient-disk-space':
          'The remote Host does not have enough free space for the package. Free space and refresh, or install through GoodBuddy.',
        'source-unreachable':
          'The remote Host cannot reach the selected source ({{source}}). Check its network and refresh, or install through GoodBuddy.',
        'probe-failed':
          'Could not complete the remote download capability check. Retry the remote-host installation directly, refresh the check, or reinstall through GoodBuddy.'
      },
      remoteDownloadPackageSize: 'Package size: {{size}}',
      errors: {
        updateFailed: 'Could not update the remote environment. Try again.',
        cancelled: 'The remote environment update was cancelled. You can retry.',
        cancelFailed: 'Could not cancel the remote environment update.',
        reinstallFailedSummary:
          'This reinstall did not complete. Checking the current versions again.'
      },
      installed: 'Installed on Host',
      expected: 'Required by GoodBuddy',
      notInstalled: 'Not installed',
      versionDetail: 'Linux · {{architecture}}',
      states: {
        current: 'Version matched',
        'update-available': 'Update available',
        'not-installed': 'Not installed'
      }
    },
    wizard: {
      eyebrow: 'SSH host validation',
      createTitle: 'Add and validate SSH host',
      editTitle: 'Edit and revalidate SSH host',
      description:
        'Confirm connection details, host identity, and authentication in order. This flow runs only a fixed system probe and does not install a remote Agent.',
      progress: 'Step {{current}} of {{total}}',
      stepsLabel: 'SSH host validation steps',
      steps: {
        details: 'Connection',
        hostKey: 'Host identity',
        authentication: 'Authentication',
        success: 'Complete'
      },
      details: {
        title: 'Enter connection details',
        description:
          'The next step performs only a pre-authentication SSH handshake to inspect the host key. It does not send a password or request an SSH Agent signature.',
        passwordUnavailable:
          'System secure storage is unavailable, so only System SSH Agent authentication can be selected.'
      },
      authentication: {
        title: 'Verify authentication and the remote system',
        description:
          'GoodBuddy will trust only the host key you just reviewed and run a fixed system probe with timeout and output limits.',
        agentHelp:
          'The current system SSH Agent will be used. GoodBuddy does not enable Agent Forwarding or forward the Agent to the remote host.',
        testingTitle: 'Authenticating and probing the remote system…',
        testingDescription:
          'The host has not been saved. If authentication fails, you can correct the credential and retry.'
      },
      success: {
        title: 'Host validated and saved',
        description:
          'The host key, credential, and connection details for “{{name}}” were saved atomically.',
        system: 'Remote system',
        latency: 'Latency',
        shell: 'Shell',
        home: 'Home directory'
      }
    },
    removeMessage:
      'Deleting “{{name}}” clears its locally saved connection information and encrypted credential. Related projects are removed locally without connecting to the Host or deleting remote directories or content.',
    removeProjectsHeading: 'Also remove these related project records:',
    actions: {
      add: 'Add host',
      retry: 'Retry',
      edit: 'Edit and revalidate',
      validate: 'Validate and save',
      editNamed: 'Edit {{name}}',
      validateNamed: 'Validate {{name}}',
      inspecting: 'Inspecting…',
      remove: 'Delete',
      confirmRemove: 'Confirm delete',
      cancel: 'Cancel',
      closeDialog: 'Close SSH host validation',
      inspectAndContinue: 'Inspect host key',
      back: 'Back',
      continueToAuthentication: 'Confirm identity and continue',
      trustChangedAndContinue: 'Confirm replacement and continue',
      validateAndSave: 'Validate and save',
      validating: 'Validating…',
      done: 'Done'
    },
    validation: {
      nameRequired: 'Enter a host name',
      hostnameRequired: 'Enter a host address',
      portInvalid: 'Port must be an integer from 1 through 65535',
      usernameRequired: 'Enter a username',
      confirmFingerprint:
        'Verify and confirm the host-key fingerprint through a trusted channel first',
      passwordRequired: 'Enter the SSH password',
      passwordStorageRequired:
        'System secure storage is unavailable, so an SSH password cannot be saved for this configuration. Select System SSH Agent instead.'
    },
    errors: {
      unavailable: 'SSH host settings are unavailable in this build',
      readFailed: 'Could not load SSH hosts',
      inspectFailed: 'Could not inspect the SSH host key',
      validationFailed:
        'SSH authentication or the remote system probe failed',
      removeFailed: 'Could not delete the SSH host',
      environmentUnavailable:
        'Remote environment version service is unavailable',
      environmentReadFailed:
        'Could not read remote environment versions'
    },
    notifications: {
      removed: 'SSH host “{{name}}” deleted',
      environmentUpdated:
        'Remote environment updated for SSH host “{{name}}”'
    }
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
      openDownloadSourceSettings: 'Go to General settings',
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
      remove: 'Remove local model {{name}}',
      downloadProgress: 'Download progress for {{name}}',
      importProgress: 'Import progress for {{name}}'
    },
    tags: {
      recommended: 'Recommended'
    },
    metadata: {
      dimensions: '{{count}} dimensions',
      contextTokens: '{{count}}-token context'
    },
    status: {
      installed: 'Installed',
      availableToDownload: 'Available to download',
      sourceUnavailable: 'Unavailable from current source',
      unknownSize: 'Unknown size'
    },
    operations: {
      installing: 'Installing',
      preparingImport: 'Preparing import',
      preparingDownloadFrom: 'Preparing download from {{source}}',
      importing: 'Importing',
      downloadingFrom: 'Downloading from {{source}}',
      processingFile: 'Processing {{file}}'
    },
    notifications: {
      installed: '{{name}} installed',
      importedZip: '{{name}} imported from ZIP',
      removed: '{{name}} removed'
    },
    sourceUnavailableDescription:
      'The current download source, {{source}}, does not provide the complete verified files for this model. Switch sources or import a ZIP.',
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
      saveRemoteProjectsFailed:
        'Could not save the Remote Projects setting. Try again.',
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
    remoteProjects: {
      title: 'Remote Projects (Technical Preview)',
      description:
        'Enables SSH Host management and GoodBuddy-managed remote projects.',
      enabled: 'Enable Remote Projects',
      agentInventory: {
        title: 'GoodBuddy Agent packages',
        description:
          'Agent packages are released independently and include the Agent, pinned Node, and the remote OpenCode Runtime adapted by GoodBuddy. Opening this page reads only the small signed catalog to show available updates and never downloads an Agent package automatically. Online actions use the source selected under About & Updates.',
        loading: 'Verifying local Agent packages and checking online versions…',
        refresh: 'Refresh package inventory',
        import: 'Import offline package',
        export: 'Export offline package',
        download: 'Download',
        update: 'Check for updates',
        updateTo: 'Update to {{version}}',
        downloadVersion: 'Download {{version}}',
        listLabel: 'Local Agent package inventory',
        summary:
          '{{available}} of {{total}} Linux architectures are available.',
        states: {
          verified: 'Downloaded and verified',
          'not-downloaded': 'Not downloaded',
          invalid: 'Verification failed',
          updateAvailable: 'Update available',
          upToDate: 'Up to date'
        },
        fields: {
          agentVersion: 'Local Agent',
          latestVersion: 'Latest online version',
          architecture: 'Architecture',
          runtimeVersion: 'Remote OpenCode',
          protocol: 'Agent protocol'
        },
        catalog: {
          available:
            'Online versions were checked through the signed catalog. Agent packages are transferred only after you choose Download or Update.',
          unavailable:
            'Could not check online Agent versions: {{error}}. Verified local packages and offline imports remain available. Refresh to try again.'
        },
        progress: {
          catalog: 'Reading the signed release catalog…',
          downloading: 'Downloading the Agent package…',
          verifying: 'Verifying signature and integrity…',
          installing: 'Writing the local cache…'
        },
        notifications: {
          downloaded: 'Linux {{architecture}} Agent package updated',
          imported: 'Agent offline package imported and verified',
          exported: 'Linux {{architecture}} Agent package exported'
        },
        errors: {
          unavailable:
            'Agent package management is not available in this version.',
          readFailed:
            'Could not load Agent packages. Try again.',
          downloadFailed:
            'Agent package download or verification failed',
          importFailed:
            'Agent offline package import or verification failed',
          exportFailed: 'Agent offline package export failed'
        }
      }
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
    title: 'Skills',
    description:
      'Works with direct models, OpenCode, Continue, and DeepSeek Harness',
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
  feedback: {
    entry: {
      title: 'Help improve GoodBuddy',
      description:
        'Report a problem, suggest a feature, or share your experience. We will handle it in our independent feedback system.',
      action: 'Submit feedback'
    },
    dialog: {
      title: 'Submit feedback',
      description:
        'Tell us what happened or what you would like improved. Your draft is preserved if submission fails.'
    },
    categories: {
      bug: 'Problem',
      feature: 'Feature request',
      experience: 'User experience',
      other: 'Other'
    },
    fields: {
      category: 'Feedback type',
      title: 'Title',
      titlePlaceholder: 'Summarize the problem or suggestion',
      description: 'Detailed description',
      descriptionPlaceholder:
        'Describe what happened, what you expected, and any steps needed to reproduce it.',
      contactEmail: 'Contact email (optional)',
      emailPlaceholder: 'user@example.com',
      emailHelp:
        'Used only if we need to contact you for more information.',
      characterCount: '{{count}} / {{maximum}} characters'
    },
    diagnostics: {
      label: 'Attach recent desktop diagnostics',
      description:
        'Off by default. When selected, this adds only timestamps, components, stages, stable error codes, error types, and fixed short messages from recent desktop diagnostics. It does not include conversations, prompts, credentials, file contents, paths, raw provider responses, or remote Agent logs.'
    },
    screenshot: {
      title: 'Screenshot (optional)',
      help:
        'Select or paste one PNG, JPEG, or WebP image, up to 5 MB.',
      fileInput: 'Select a feedback screenshot',
      previewAlt: 'Preview of the feedback screenshot to be sent',
      privacy:
        'Screenshots may contain personal information visible on screen. Review the image before sending.',
      unsupported: 'Only PNG, JPEG, and WebP images are supported.',
      tooLarge: 'The screenshot must be 5 MB or smaller.',
      invalid:
        'The screenshot could not be read or its dimensions exceed the limit.'
    },
    environment: {
      title: 'Application information to be sent',
      version: 'GoodBuddy version',
      system: 'Operating system',
      locale: 'Interface language',
      platforms: {
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux',
        unknown: 'Unknown system'
      }
    },
    privacy:
      'GoodBuddy will send the feedback type, title, description, optional email, app version, operating system, architecture, interface language, and any screenshot you add. Desktop diagnostics are not uploaded by default; a bounded summary is appended to the description only when selected. Conversations, prompts, credentials, file contents, paths, raw provider responses, and remote Agent logs are not sent.',
    validation: {
      titleRequired: 'Enter a feedback title.',
      descriptionMinimum:
        'The detailed description must contain at least 10 characters.',
      descriptionMaximum:
        'The detailed description must be {{maximum}} characters or fewer. Your draft is preserved; shorten it and try again.',
      descriptionMaximumWithDiagnostics:
        'When desktop diagnostics are attached, the detailed description must be {{maximum}} characters or fewer. Your draft is preserved; shorten it and try again.',
      emailInvalid: 'Enter a valid contact email or leave it blank.'
    },
    actions: {
      close: 'Close feedback dialog',
      cancel: 'Cancel',
      submit: 'Submit feedback',
      submitting: 'Submitting…',
      retry: 'Retry submission',
      addScreenshot: 'Add screenshot',
      processingScreenshot: 'Reading screenshot…',
      replaceScreenshot: 'Replace screenshot',
      removeScreenshot: 'Remove screenshot',
      copyReference: 'Copy feedback reference',
      copied: 'Copied',
      done: 'Done'
    },
    success: {
      title: 'Feedback submitted',
      description:
        'Thank you for your feedback. Save this reference for future communication.'
    },
    errors: {
      title: 'Feedback was not submitted',
      'invalid-submission':
        'The submission does not meet the feedback service requirements. Check the fields and screenshot, then try again.',
      'incompatible-client':
        'This GoodBuddy version does not match the feedback service configuration. Update the app and try again.',
      unavailable:
        'The feedback service is temporarily unavailable. Try again later.',
      busy:
        'Another feedback submission is in progress. Wait for it to finish, then try again.',
      'screenshot-too-large':
        'The screenshot or request is too large. Remove it or choose a smaller image, then try again.',
      'rate-limited':
        'Feedback is being submitted too frequently. Try again later.',
      'service-error':
        'The feedback service has a temporary problem. Try again later.',
      network:
        'Could not connect to the feedback service. Check your network and try again.',
      timeout:
        'The feedback service connection timed out. Check your network and try again.',
      'invalid-response':
        'The feedback service returned an invalid result. Try again later.',
      'diagnostics-unavailable':
        'The selected desktop diagnostics could not be read, so no feedback was sent. Your draft and selection are preserved; retry or clear the diagnostics checkbox before submitting.'
    }
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
      openReleasePageFailed: 'Could not open the download page',
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
