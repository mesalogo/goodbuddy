import type { TranslationShape } from '../../resource-types'
import type { settings as chineseSettings } from '../zh-CN/settings'

export const settings = {
  modelDownloadSources: {
    modelscope: 'ModelScope',
    'hugging-face': 'Hugging Face'
  },
  center: {
    title: 'Settings',
    description:
      'Manage models, Runtimes, platform capabilities, message channels, and local data.',
    close: 'Close settings',
    categoriesAriaLabel: 'Settings categories'
  },
  categories: {
    appearance: {
      label: 'Appearance',
      navigationDescription: 'Theme, language, and branding',
      description: 'Theme, language, and brand customization'
    },
    platformFeatures: {
      label: 'Platform features',
      navigationDescription: 'Workspace features and navigation',
      description: 'Choose which features appear in your GoodBuddy workspace'
    },
    model: {
      label: 'Model connections',
      navigationDescription:
        'LLMs, embedding and rerank models, and credentials',
      description: 'LLMs, embedding and rerank models, and credentials'
    },
    contextControl: {
      label: 'Context control',
      navigationDescription:
        'Direct model history compression and recent raw context',
      description:
        'Manage compression thresholds, recent raw context, and the summary model for direct models'
    },
    documentParsing: {
      label: 'Document parsing',
      navigationDescription: 'Attachments, knowledge, and local OCR',
      description:
        'Configure extraction, conversion, and OCR for chat attachments and knowledge imports'
    },
    runtime: {
      label: 'Agent Runtime',
      navigationDescription:
        'Configure Agent Runtimes, the default workspace, and native capabilities',
      description:
        'Configure Agent Runtimes, the default workspace, and native capabilities'
    },
    sshHosts: {
      label: 'Hosts and remote execution',
      navigationDescription:
        'SSH hosts, identity verification, and connection probes',
      description:
        'Manage SSH hosts, pin host keys, and verify remote execution environments'
    },
    security: {
      label: 'Security and data',
      navigationDescription: 'Tool policies and local privacy',
      description: 'Tool policies and local privacy'
    },
    channels: {
      label: 'Message channels',
      navigationDescription: 'WeChat, WeCom, and DingTalk',
      description:
        'Configure connections, workspaces, message backends, and default modes'
    },
    roles: {
      label: 'Roles and prompts',
      navigationDescription: 'Roles, descriptions, and system prompts',
      description: 'Roles, descriptions, and system prompts'
    },
    skills: {
      label: 'Skills',
      navigationDescription: 'Built-in and custom capabilities',
      description:
        'Works with direct models, OpenCode, Continue, and DeepSeek Harness'
    },
    mcp: {
      label: 'MCP',
      navigationDescription: 'Tool servers and credentials',
      description:
        'View built-in tools and MCP servers, and manage external MCP servers'
    },
    about: {
      label: 'About and updates',
      navigationDescription: 'Version checks and downloads',
      description:
        'Checks the selected official update source and never installs automatically'
    }
  },
  actions: {
    testing: 'Testing…',
    saveAndTestModel: 'Save and test model',
    saveAndTestRuntime: 'Save and test {{runtime}}',
    saving: 'Saving…',
    saveSettings: 'Save settings',
    testingParsing: 'Parsing…',
    select: 'Select',
    selectFile: 'Select file',
    clear: 'Clear',
    openConfigFile: 'Open config file',
    revealInFolder: 'Show in folder',
    openConfigDirectory: 'Open {{runtime}} config folder',
    detecting: 'Detecting…',
    redetectRuntime: 'Detect {{runtime}} again',
    addCustom: 'Add custom connection',
    deleteConnection: 'Delete connection',
    clearAfterSave: 'Clear after saving',
    clearCredential: 'Clear credential',
    done: 'Done',
    cancel: 'Cancel',
    clearing: 'Clearing…',
    clearLocalData: 'Clear local data'
  },
  unsaved: {
    close:
      'These settings have unsaved changes. Save them first, or confirm that you want to discard them before closing Settings.',
    navigation:
      'These settings have unsaved changes. Save them first, or confirm that you want to discard them before changing categories.',
    keepEditing: 'Keep editing',
    discardAndClose: 'Discard changes and close',
    discardAndNavigate: 'Discard changes and continue'
  },
  errors: {
    readSettings: 'Could not load settings',
    detectRuntimes: 'Could not detect Agent Runtimes',
    readEmbeddingStatus: 'Could not load embedding model status',
    requireModelConnection: 'Configure at least one model connection',
    refreshEmbeddingAfterSave:
      'Settings were saved, but the vector model status could not be refreshed',
    speechModelsUnavailable:
      'Speech model services are not available in this version',
    saveSettings: 'Could not save settings',
    testModel: 'Model connection test failed',
    testRuntime: 'Runtime connection test failed',
    embeddingDiagnosticUnavailable:
      'Vector diagnostics are unavailable',
    testEmbedding: 'Vector model test failed',
    manageEmbeddingModel: 'Embedding model operation failed',
    selectFile: 'Could not select the file',
    openRuntimeConfig: 'Could not open the Runtime configuration',
    selectWorkspace: 'Could not select the workspace folder',
    retainModelConnection: 'Keep at least one model connection',
    clearLocalData: 'Could not clear local data',
    documentParsingUnavailable: 'Document parsing is unavailable',
    readDocumentParsing: 'Could not load document parsing settings',
    saveDocumentParsing: 'Could not save document parsing settings',
    testDocumentParsing: 'Document parsing test failed',
    manageDocumentOcrModel: 'OCR model operation failed'
  },
  notifications: {
    settingsSaved: 'Settings saved',
    connectionSucceeded: 'Connected: {{label}}',
    modelGenerationTestSucceeded:
      'Real generation test passed: {{label}}',
    documentParsingSaved: 'Document parsing settings saved',
    documentParsingTestSucceeded: 'Document parsing test completed'
  },
  credentials: {
    none: 'Not configured',
    encrypted: 'Encrypted in secure system storage',
    environment: 'Provided by an environment variable',
    unreadable: 'Saved, but currently unreadable',
    configuredPlaceholder: 'Configured; leave blank to keep it',
    enterApiKey: 'Enter API Key',
    noAuthentication: 'No authentication',
    noAuthenticationDescription:
      'No authentication is required; no API Key will be sent',
    savedForConnection:
      'Authentication is currently disabled; the saved API Key remains stored with this connection'
  },
  runtime: {
    configCard: {
      title: '{{runtime}} configuration',
      fileLabel: 'Configuration file',
      pathAriaLabel: '{{runtime}} configuration file path',
      pathPlaceholder: 'Select a trusted local {{runtime}} configuration file',
      unsavedHint:
        'Save settings to open this file or reveal it in its folder.'
    },
    detection: {
      ready: 'Ready',
      notReady: 'Not ready · {{detail}}',
      unavailable: 'Not ready',
      detecting: 'Detecting…',
      notDetected: 'Not detected',
      statusLabel: 'Status:',
      pathLabel: 'Path:',
      versionLabel: 'Version:',
      detailLabel: 'Detection details:',
      details: {
        bundled: 'Bundled {{runtime}}{{versionSuffix}} is ready',
        configured: 'Custom {{runtime}}{{versionSuffix}} is ready',
        automatic:
          'Automatically detected {{runtime}}{{versionSuffix}}'
      }
    },
    workspace: {
      title: 'Default workspace',
      description:
        'Agents use this location only when the current project has no root folder',
      directoryLabel: 'Default workspace folder'
    },
    bundledDescription:
      'Bundled GoodBuddy Runtime that follows the text model connection by default',
    runtimeLabel: 'Runtime:',
    modelConfigurationLabel: 'Model configuration:',
    bundledRuntime: 'GoodBuddy bundled {{runtime}}',
    ownConfiguration: 'Use the {{runtime}} configuration',
    followGoodBuddy: 'Follow GoodBuddy · {{name}} ({{model}})',
    noCompatibleModel: 'No compatible text model is configured',
    permissions:
      'Choose Ask or Execute in a conversation. Ask can use only read-only capabilities allowed by the current Runtime. Execute can use enabled tools, and records tool calls in Activity.',
    customization: {
      title: 'Capabilities and defaults',
      description:
        'Configure this Runtime’s defaults and inspect its built-in capabilities. The inventory excludes Skills assigned by GoodBuddy and temporary MCP servers.',
      refresh: 'Refresh capability inventory',
      retry: 'Retry',
      loading: 'Loading capability inventory…',
      unsaved:
        'There are unsaved Runtime customization changes. Use “Save settings” at the top right to save everything together.',
      discard: 'Discard customization changes',
      unsavedClose:
        'Save or discard the Runtime customization changes before closing Settings.',
      enabled: 'Enabled',
      disabled: 'Disabled',
      errors: {
        load: 'Could not load capability inventory',
        save: 'Could not save Runtime customization'
      },
      inventory: {
        tabsAriaLabel: 'Capability inventory',
        agents: 'Agents',
        tools: 'Tools',
        skills: 'Skills',
        mcp: 'MCP',
        commands: 'Commands',
        rules: 'Rules',
        prompts: 'Prompts',
        resources: 'Resources',
        lsp: 'LSP',
        formatters: 'Formatters',
        empty: 'None detected',
        emptyDescription:
          'The current Runtime did not report any capabilities in this category.',
        unsupported: 'Not supported by this Runtime',
        toolsUnsupported:
          'This Runtime does not support static discovery of Tools',
        toolModes: 'Ask: {{ask}} · Execute: {{execute}}',
        toolKind: {
          read: 'Read',
          write: 'File modification',
          shell: 'Command execution',
          network: 'Network access',
          agent: 'Agent orchestration',
          interaction: 'User interaction',
          other: 'Other'
        },
        toolSource: {
          runtime: 'Runtime built-in',
          plugin: 'Runtime plugin',
          mcp: 'MCP',
          skill: 'Skill',
          unknown: 'Unknown source'
        },
        toolAccess: {
          allowed: 'Available',
          blocked: 'Unavailable',
          conditional: 'Request-dependent'
        }
      },
      agentMode: {
        primary: 'Primary Agent',
        subagent: 'Subagent',
        all: 'Primary / subagent'
      },
      status: {
        connected: 'Connected',
        disabled: 'Disabled',
        failed: 'Failed',
        'needs-auth': 'Authentication required',
        unsupported: 'Unsupported',
        unknown: 'Unknown',
        error: 'Error',
        'not-loaded': 'Not loaded'
      },
      commandSource: {
        command: 'Runtime command',
        mcp: 'MCP prompt',
        skill: 'Skill command',
        runtime: 'Runtime'
      },
      context: {
        title: 'Context and compaction'
      },
      opencode: {
        defaultAgent: 'Default Agent',
        runtimeDefault: 'Let OpenCode choose',
        agentDescription:
          'Applies only to GoodBuddy-managed local OpenCode. A conversation can still select a different Agent.'
      },
      continue: {
        editorTitle: 'Continue configuration presets',
        editPreset: 'Edit configuration preset',
        noPresets: 'No presets',
        addPreset: 'Add preset',
        removePreset: 'Delete preset',
        defaultPreset: 'Default configuration preset',
        noDefaultPreset: 'Do not apply a GoodBuddy preset',
        newPreset: 'New Continue preset',
        presetName: 'Preset name',
        presetDescription: 'Preset description',
        rules: 'Rules',
        addRule: 'Add Rule',
        newRule: 'New Rule',
        newRuleContent:
          'Enter a rule that should apply to every request.',
        ruleName: 'Rule name',
        ruleContent: '{{name}} content',
        removeRule: 'Delete Rule {{name}}',
        prompts: 'Prompt templates',
        addPrompt: 'Add Prompt',
        newPrompt: 'New Prompt',
        newPromptContent:
          'Enter a Prompt that can be used from the chat composer.',
        promptName: 'Prompt name',
        promptDescription: '{{name}} description',
        promptDescriptionPlaceholder:
          'Optional description of when to use this Prompt',
        promptContent: '{{name}} content',
        removePrompt: 'Delete Prompt {{name}}',
        mergedRules: 'View {{count}} merged Rules',
        emptyPresetTitle: 'No Continue presets yet',
        emptyPreset:
          'Use “Add preset” above to create Rules and Prompt templates.'
      }
    },
    advanced: 'Advanced settings',
    sourceLegend: 'Model configuration source',
    followRecommended: 'Follow the GoodBuddy model (recommended)',
    goodBuddyConnection: 'GoodBuddy model connection',
    pinConnectionDescription:
      'You can pin this Runtime to another GoodBuddy text model connection.',
    incompatibleSuffix: ' (incompatible)',
    serverAddress: 'Server address',
    bundledProgramPlaceholder: 'Leave blank to use the bundled GoodBuddy program',
    customBinaryWarning:
      'A custom {{runtime}} executable runs with your user permissions. Select only a trusted file.',
    opencode: {
      title: 'OpenCode Agent',
      recommendation:
        'Following the GoodBuddy model is recommended. Use OpenCode configuration only when you need its native models, plugins, or MCP configuration.',
      advancedDescription:
        'Most users do not need to change these options. Use them to switch model sources, reuse Runtime-owned configuration, or override the bundled program and service.',
      followDescription:
        'Generates a secure runtime configuration automatically, with no Runtime configuration file to maintain.',
      ownDescription:
        'For advanced users who need native models, plugins, or MCP configuration.',
      configDescription:
        'GoodBuddy does not open or expose generated runtime configuration. This section manages only the local file you explicitly select.',
      externalServerWarning:
        'Models, plugins, and tools for an external OpenCode Server are managed by that server. Local configuration files and request-authorized local knowledge base tools are not sent to it.',
      serverAriaLabel: 'OpenCode Server address',
      serverPlaceholder: 'Leave blank to use the bundled local service',
      serverDescription:
        'When blank, GoodBuddy starts its bundled local OpenCode service. No installation or address is required.',
      binaryPath: 'OpenCode executable path'
    },
    continue: {
      title: 'Continue CLI',
      recommendation:
        'Following the GoodBuddy model is recommended. Use Continue configuration only when you need its native models, rules, or MCP configuration.',
      advancedDescription:
        'Most users do not need to change these options. Use them to switch model sources, reuse Runtime-owned configuration, or override the bundled program.',
      followDescription:
        'Generates a secure temporary runtime configuration and deletes it when the task ends.',
      ownDescription:
        'For advanced users who need native models, rules, or MCP configuration.',
      configDescription:
        'GoodBuddy does not open or expose runtime configuration containing temporary credentials. This section manages only the local file you explicitly select.',
      binaryPath: 'Continue executable path',
      missingConfigWarning:
        'Continue remains unavailable without a configuration file and will not load a remote default model anonymously.'
    },
    deepseekHarness: {
      selectorLabel: 'DeepSeek Harness (Preview)',
      title: 'DeepSeek Harness',
      previewDescription: 'Developer preview · OpenAI-compatible',
      description:
        'GoodBuddy maintains the fixed Host and control protocol internally and uses pinned Harness libraries underneath. Ask can call native read/skill plus enabled Web Search/Fetch, while Execute can use every enabled tool and DSH plugin capability. Cancellation and workspace boundaries remain in place.',
      managedSource:
        'Administrator-provided OpenAI-compatible connection',
      connection: 'OpenAI-compatible model connection',
      connectionPlaceholder:
        'Select an OpenAI-compatible model connection',
      connectionDescription:
        'Choose a GoodBuddy model connection. It must use OpenAI Chat Completions with API-key authentication.',
      advancedDescription:
        'This Runtime always uses GoodBuddy’s bundled, version-pinned Host and does not load user profiles or custom Hosts. GoodBuddy manages enabled marketplace plugins and loads them with the Host.',
      marketplace: {
        title: 'DSH plugin marketplace',
        previewDescription: 'Preview · public npm registry',
        switch: {
          aria: 'Enable the DSH plugin marketplace',
          enabled: 'On',
          disabled: 'Off'
        },
        disabledDescription:
          'The plugin marketplace is off by default. Turn it on to connect to the public npm catalog and show its management interface. Turning off the marketplace does not disable or uninstall existing plugins.',
        permissionNotice:
          'Third-party install scripts, initialization code, and tools run with your user permissions. Ask cannot call third-party plugin tools, but it cannot limit plugin initialization code. Execute can call every tool from enabled plugins. Install only packages you trust.',
        refresh: 'Refresh',
        refreshAria: 'Refresh the DSH plugin marketplace',
        searchLabel: 'Search plugins',
        searchPlaceholder:
          'Filter by name, package, description, or license',
        retry: 'Try again',
        loading: 'Loading the plugin catalog…',
        catalogUnavailable:
          'Could not refresh the npm plugin catalog: {{detail}}. Installed plugins remain manageable.',
        results: 'Showing {{shown}} of {{total}} plugins',
        noResults: 'No plugins match your search.',
        empty: 'No DSH plugins were found in the public npm registry.',
        refineSearch:
          'Only the first {{count}} plugins are shown. Refine your search to see others.',
        notInCatalog:
          'This installed plugin is not currently in the npm marketplace catalog.',
        installed: 'Installed',
        enabled: 'Enabled',
        disabled: 'Disabled',
        enableAria: 'Enable {{name}}',
        install: 'Install and enable',
        update: 'Update to {{version}}',
        installing: 'Installing…',
        installConfirmationTitle: 'Install {{name}}',
        installConfirmation:
          'npm runs install scripts declared by this package and its dependencies. After installation, plugin initialization code runs when DeepSeek Harness starts.',
        trustConfirmation:
          'I trust {{package}} and understand that its code runs with my user permissions.',
        confirmInstall: 'Confirm install',
        cancel: 'Cancel',
        remove: 'Remove',
        removeAria: 'Remove {{name}}',
        confirmRemove: 'Confirm removal',
        removeMessage:
          'Remove {{name}} and its GoodBuddy-managed files?',
        startupFailure:
          'The plugin failed on its last startup and was disabled automatically. Check its configuration or version before enabling it again.',
        configuration: {
          open: 'Configure',
          close: 'Close configuration',
          label: '{{name}} configuration JSON',
          help: 'Save a JSON object and restart the current Runtime to pass it to the plugin.',
          save: 'Save configuration',
          invalid: 'Configuration must be a valid JSON object.'
        },
        errors: {
          unavailable:
            'The DSH plugin marketplace is unavailable in this version',
          readFailed: 'Could not load the DSH plugin marketplace',
          operationFailed: 'The DSH plugin operation failed'
        },
        notifications: {
          marketplaceEnabled: 'Enabled the DSH plugin marketplace',
          marketplaceDisabled: 'Disabled the DSH plugin marketplace',
          installed: 'Installed and enabled {{name}}',
          updated: 'Updated {{name}}',
          enabled: 'Enabled {{name}}',
          disabled: 'Disabled {{name}}',
          configured: 'Saved the configuration for {{name}}',
          removed: 'Removed {{name}}'
        }
      }
    }
  },
  documentParsing: {
    loading: 'Loading…',
    status: {
      title: 'Runtime status',
      description: 'Capabilities currently available on this device',
      available: 'Available',
      unavailable: 'Unavailable',
      verified: 'Verified',
      native: 'Native document parsing',
      nativeDetail:
        'Text, HTML, text PDFs, and modern Office documents',
      conversion: 'Legacy Office conversion',
      conversionUnavailable:
        'Not implemented yet; DOC, XLS, and PPT are currently unavailable',
      localOcr: 'Local OCR',
      localOcrModel: 'Current OCR: {{name}}',
      ocrReady:
        'The model is installed, SHA-256 verified, and available offline',
      ocrUnavailable:
        'The model is not installed or failed verification. Get it from the current model download source.',
      partialNotice:
        'Basic document parsing is available. Legacy Office conversion is not implemented yet; scenario modes can use local OCR for scanned PDFs.'
    },
    workflows: {
      title: 'PDF parsing modes',
      description:
        'Choose how each scenario handles PDF text layers and scanned pages',
      chat: 'Chat and artifact files',
      knowledge: 'Knowledge imports',
      testChat: 'Test chat and artifact mode',
      testKnowledge: 'Test knowledge mode',
      unsavedNotice:
        'There are unsaved changes. Save them before testing the active mode.',
      chatOptions: {
        auto: 'Automatic recognition (recommended)',
        fastText: 'Text layer only',
        highFidelity: 'OCR every page'
      },
      chatDescriptions: {
        auto:
          'Chat attachments and artifact PDFs prefer the text layer and use OCR only on pages without useful text.',
        fastText:
          'Chat attachments and artifact PDFs use only the text layer. Scanned documents may be unreadable.',
        highFidelity:
          'Run OCR on every PDF page. This is slower.'
      },
      knowledgeOptions: {
        completeIndex: 'Automatic recognition (recommended)',
        fastIndex: 'Text layer only',
        highFidelity: 'OCR every page'
      },
      knowledgeDescriptions: {
        'complete-index':
          'Prefer the PDF text layer and use OCR only on pages without useful text.',
        'fast-index':
          'Use only the PDF text layer. Scanned pages are not indexed.',
        'high-fidelity':
          'Run OCR on every PDF page before chunking and indexing. This is slower.'
      }
    },
    ocr: {
      title: 'OCR recognition',
      description:
        'Install a local model on demand to recognize scanned PDFs on this device',
      modelSelector: 'Current OCR model',
      modelSelectorDescription:
        'This saved model is used for chat attachments and knowledge imports.',
      pendingSelection:
        'This model selection is not active yet. Save settings to switch.',
      installedOption: 'Installed',
      downloadableOption: 'Available to download',
      sourceUnavailableOption: 'Unavailable from current source',
      unavailableOption: 'Unavailable in this version',
      openModelsDirectory: 'Open model folder',
      storagePrefix: 'Models are installed on demand in',
      storageSuffix:
        ' and can be exported as ZIP archives for offline devices.',
      downloadSource: 'Current model download source: {{source}}',
      recommended: 'Recommended',
      quality: {
        label: 'Quality: {{value}}',
        values: {
          basic: 'Basic',
          balanced: 'Balanced',
          high: 'High'
        }
      },
      speed: {
        label: 'Speed: {{value}}',
        values: {
          fast: 'Fast',
          balanced: 'Balanced',
          slow: 'Slow'
        }
      },
      languages: {
        中文: 'Chinese',
        英语: 'English',
        '50 种语言': '50 languages'
      },
      catalog: {
        'pp-ocrv6-tiny': {
          displayName: 'PP-OCRv6 Tiny',
          description:
            'The official lightweight PaddleOCR Chinese model for local CPU recognition of scanned PDFs and images.'
        },
        'pp-ocrv6-small': {
          displayName: 'PP-OCRv6 Small',
          description:
            'The official PaddleOCR 50-language model balancing recognition quality, speed, and local resource use.'
        },
        'pp-ocrv6-medium': {
          displayName: 'PP-OCRv6 Medium',
          description:
            'The official high-quality PaddleOCR 50-language model with slower recognition, higher memory use, and greater latency.'
        }
      },
      installed: 'Installed and verified',
      download: 'Download',
      downloadAndSelect: 'Download and enable',
      importZip: 'Import ZIP',
      exportZip: 'Export ZIP',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      cancel: 'Cancel',
      openRepository: 'Open {{source}}',
      openDownloadSourceSettings: 'Open General settings',
      catalogUnavailable:
        'No OCR model catalog is available in this version.',
      selectedModelUnavailable:
        'The saved OCR model is unavailable in this version. Select and install another model above.',
      installBeforeSelecting:
        'Download or import this model first. It will become the current model after installation.',
      sourceUnavailableDescription:
        '{{source}} does not currently provide the complete verified files for this model. You can still import a ZIP archive or explicitly change the source in General settings.',
      privacyNotice:
        'OCR is enabled only when required by the scenario modes above. It always runs locally through ONNX Runtime WebAssembly and never uploads documents.',
      operations: {
        preparing: 'Preparing model files',
        downloading: 'Downloading from {{source}}',
        importing: 'Importing model ZIP',
        installing: 'Verifying and installing'
      },
      accessibility: {
        downloadModel: 'Download {{name}}',
        importModelZip: 'Import {{name}} from a ZIP archive',
        exportModelZip: 'Export {{name}} as a ZIP archive',
        deleteModel: 'Delete {{name}}',
        cancelOperation: 'Cancel {{name}} operation',
        downloadProgress: '{{name}} download progress',
        openRepository: 'Open the {{source}} page for {{name}}'
      },
      notifications: {
        installed: '{{name}} installed',
        installedAndSelected:
          '{{name}} installed and selected as the current model',
        importedZip: '{{name}} imported from ZIP',
        importedAndSelected:
          '{{name}} imported and selected as the current model',
        exportedZip: '{{name}} exported as ZIP',
        removed: 'OCR model deleted'
      }
    },
    advanced: {
      title: 'Advanced parsing settings',
      maximumPages: 'Maximum OCR pages per document',
      timeout: 'OCR time budget per page (seconds)',
      description:
        'The page limit counts only pages actually sent to OCR. Parsing stops if one page exceeds its time budget.'
    },
    diagnostic: {
      title: 'Parsing test result',
      file: 'File',
      format: 'Format',
      method: 'Method',
      pages: 'Pages',
      ocrPages: 'OCR pages',
      characters: 'Extracted characters',
      duration: 'Duration',
      preview: 'Text preview',
      warnings: 'Warnings',
      methods: {
        native: 'Native parsing',
        ocr: 'Local OCR',
        mixed: 'Native parsing and OCR'
      },
      close: 'Close result'
    }
  },
  model: {
    typeAriaLabel: 'Model type',
    types: {
      llm: {
        label: 'LLM model',
        description:
          'Configure model connections for conversation, reasoning, and image generation.'
      },
      embedding: {
        label: 'Embedding model',
        description:
          'Configure the embedding model used for knowledge base semantic retrieval and GraphRAG.'
      },
      rerank: {
        label: 'Rerank model',
        description:
          'Configure learned relevance reranking for knowledge retrieval candidates.'
      },
      speech: {
        label: 'Voice input',
        description:
          'Select an installed model and save Settings to apply it; models can be downloaded or moved offline with ZIP archives.'
      }
    },
    profile: {
      seededDefaultName: 'Default model',
      generatedName: 'Model connection {{count}}',
      title: 'LLM model connections',
      description:
        'Supports OpenAI Responses, Anthropic Messages, and OpenAI-compatible Chat Completions. Image models use the separate OpenAI Images Generations protocol. “Save and test model” sends a real text or image generation request and may incur provider usage charges.',
      listAriaLabel: 'Model connection list',
      listTitle: 'Connections',
      editAriaLabel: 'Edit model connection {{name}}',
      defaultBadge: 'Default',
      imageBadge: 'Image',
      detail: 'Connection details',
      defaultConnection: 'Default connection',
      imageGeneration: 'Image generation',
      deleteAriaLabel: 'Delete model connection {{name}}',
      name: 'Name',
      endpoint: 'Model API URL',
      model: 'Model',
      protocol: 'API protocol',
      protocolAriaLabel: 'API protocol for {{name}}',
      openAiCompatibleProtocol: 'OpenAI-compatible Chat Completions',
      imageProtocol: 'OpenAI Images Generations (image generation)',
      authentication: 'Authentication',
      authenticationAriaLabel: 'Authentication for {{name}}',
      supportsImageInput: 'Supports image input',
      supportsImageInputDescription:
        'When enabled, GoodBuddy can send image context to this model connection.',
      contextWindow: 'Context window (optional)',
      contextWindowDescription:
        'Enter 32K–10000K tokens. Leave blank when unknown. This value is used only for GoodBuddy local budget calculations.',
      maximumOutput: 'Anthropic maximum output',
      maximumOutputDescription:
        'The Anthropic Messages protocol requires this value on every request. Enter 1K–10000K tokens. It limits only one model response, not tool rounds or cumulative usage.',
      imageQuality: 'Image quality',
      imageQualityAriaLabel: 'Image quality for {{name}}',
      quality: {
        auto: 'Auto',
        low: 'Low',
        medium: 'Medium',
        high: 'High'
      },
      imageQualityDescription:
        'Used only for OpenAI-compatible image generation requests.',
      compatibilitySummary:
        'Direct model: {{directCapability}} · Continue: {{continueCompatibility}} · OpenCode: {{openCodeCompatibility}} · DeepSeek Harness: {{deepseekHarnessCompatibility}}',
      textChat: 'Text chat',
      compatible: 'Compatible',
      incompatible: 'Incompatible',
      incompatibleImageProtocol:
        'Incompatible (image generation protocol is unsupported)',
      incompatibleHarnessProtocol:
        'Incompatible (requires Chat Completions, an API key, and a secure endpoint)',
      secureStorageWarning:
        'Secure system key storage is unavailable. Use an environment variable to avoid storing an API Key in plaintext.'
    },
    embedding: {
      title: 'Embedding model connection',
      description:
        'Manage built-in local inference and OpenAI-compatible embedding connections',
      enabled: 'Enable embedding model',
      addConnection: 'Add embedding connection',
      newConnectionName: 'Embedding connection',
      connectionName: 'Connection name',
      authentication: 'Authentication',
      noAuthentication: 'No authentication',
      endpoint: 'Embedding API URL',
      endpointDescription:
        'Enter the complete OpenAI-compatible Embeddings endpoint.',
      modelName: 'Model name',
      builtinDataLocation:
        'Local knowledge chunks → GoodBuddy local inference process → local SQLite',
      builtinUnavailable:
        'Model artifacts have not completed release validation and cannot be installed yet',
      optionalApiKey: 'API Key (optional)',
      optionalApiKeyPlaceholder:
        'Leave blank for a local service without authentication',
      installed: 'Installed and verified',
      notInstalled: 'Not installed',
      progress: 'Installing… {{percent}}%',
      removeBuiltin: 'Remove local model {{name}}',
      privacyDescription:
        'Only chunks from enabled knowledge bases are sent to this endpoint. The API Key is encrypted in secure system storage. If the embedding service fails, retrieval falls back to FTS5 and the evidence graph.'
    },
    rerank: {
      title: 'Rerank model connection',
      description:
        'Uses a Cohere-compatible Rerank API to improve knowledge retrieval ordering',
      enabled: 'Enable learned reranking',
      endpoint: 'Rerank API URL',
      endpointDescription:
        'Enter the complete Cohere-compatible Rerank endpoint.',
      modelName: 'Model name',
      optionalApiKey: 'API Key (optional)',
      optionalApiKeyPlaceholder:
        'Leave blank for a local service without authentication',
      privacyDescription:
        'Only retrieval queries and candidate knowledge chunks are sent to this endpoint. The API Key is encrypted in secure system storage. If reranking fails, the original retrieval order is preserved.'
    }
  },
  contextControl: {
    enabled: 'Automatically compress earlier conversation',
    enabledDescription:
      'Applies only to direct text models. GoodBuddy generates a summary at the threshold without deleting the original chat history.',
    usageNotice: 'Generating a summary uses additional model tokens.',
    triggerTokens: 'Compression threshold',
    triggerTokensDescription:
      'Prepare direct model context at approximately {{tokens}} tokens.',
    recentRawTokens: 'Recent raw context budget',
    recentRawTokensDescription:
      'After compression, preserve complete recent turns within approximately {{tokens}} tokens.',
    summaryModel: 'Summary model',
    currentModel: 'Direct model used by the current conversation (recommended)',
    summaryModelDescription:
      'Image generation connections cannot summarize. If a selected connection is unavailable, compression stops and keeps the original input.',
    fixedTarget:
      'Earlier conversation is compressed to an approximately 8K-token summary. The current request is always preserved in full.',
    modelLimits:
      'Optional context windows are configured per direct model under Model connections. When set, GoodBuddy compresses before reaching that model limit.',
    manageModelLimits: 'Manage model context windows',
    advanced: 'Advanced settings',
    summaryPrompt: 'Summary prompt',
    summaryPromptDescription:
      'This prompt is sent as a trusted summary instruction. Conversation content is always treated as untrusted historical data.',
    restoreDefaultPrompt: 'Restore default prompt'
  },
  security: {
    toolPolicy: {
      label: 'Direct model tool security policy',
      always: 'Automatically authorize enabled tools in Execute',
      deny: 'Block all tool execution',
      description:
        'Direct models in Execute mode can use built-in workspace tools and assigned MCP tools. Choosing Execute authorizes automatic tool calls for the current interaction without individual prompts. The blocking policy denies every tool call. OpenCode and Continue continue to use their own tool systems.'
    },
    localData: {
      title: 'Local data and privacy',
      description:
        'Clear local conversations, activity records, and knowledge base indexes. Saved Runtime credentials and source files are not deleted.'
    }
  },
  roles: {
    smartRouting: {
      title: 'Smart Subagent routing',
      description:
        'Automatically choose the expert role that best matches the question',
      enabled: 'Enable Smart Subagent routing',
      help:
        'Off by default. In Ask mode, when no expert or team is explicitly selected, GoodBuddy chooses one expert. The Subagent uses the default text model in read-only mode without tools.'
    }
  },
  appearance: {
    theme: {
      title: 'Interface theme',
      description: 'Applies immediately and is saved on this device',
      ariaLabel: 'Interface theme',
      options: {
        system: {
          label: 'Use system theme',
          description: 'Switch automatically with your operating system'
        },
        light: {
          label: 'Light',
          description: 'A bright, clear workspace'
        },
        dark: {
          label: 'Dark',
          description: 'Reduce brightness in low-light environments'
        }
      }
    },
    language: {
      title: 'Interface language',
      description: 'Applies immediately and is saved on this device',
      ariaLabel: 'Interface language',
      options: {
        system: {
          label: 'Use system language',
          description:
            'Use Simplified Chinese on Chinese systems and English elsewhere'
        },
        chinese: {
          label: '简体中文',
          description: '使用简体中文界面'
        },
        english: {
          label: 'English',
          description: 'Use the English interface'
        }
      }
    },
    branding: {
      title: 'Brand customization',
      description:
        'Customize the brand name, subtitle, and logo in the top-left corner',
      previewLabel: 'Brand preview',
      fields: {
        name: 'Brand name',
        subtitleZhCN: 'Chinese subtitle',
        subtitleEnUS: 'English subtitle'
      },
      logo: {
        select: 'Choose logo',
        useDefault: 'Use default logo',
        help:
          'Supports PNG, JPEG, or WebP up to 4096 × 4096 and 512 KB'
      },
      actions: {
        restore: 'Restore defaults',
        save: 'Save branding'
      },
      errors: {
        unsupportedLogo: 'Choose a PNG, JPEG, or WebP image',
        logoTooLarge: 'The logo file cannot exceed 512 KB',
        invalidLogo:
          'The logo is invalid, has the wrong format, or is too large',
        readLogoFailed: 'The logo could not be read. Choose it again.',
        saveFailed:
          'Branding could not be saved. Check local storage and try again.'
      }
    }
  }
} satisfies TranslationShape<typeof chineseSettings>
