import type { TranslationShape } from '../../resource-types'
import type { settings as chineseSettings } from '../zh-CN/settings'

export const settings = {
  center: {
    eyebrow: 'Settings',
    title: 'Settings',
    description:
      'Manage model connections, Agent Runtimes, automation, extensions, and local data.',
    close: 'Close settings',
    categoriesAriaLabel: 'Settings categories'
  },
  categories: {
    appearance: {
      label: 'Appearance',
      navigationDescription: 'Theme and interface language',
      description: 'Theme and interface language'
    },
    platformFeatures: {
      label: 'Platform features',
      navigationDescription: 'Workspace features and navigation',
      description: 'Choose which features appear in your GoodBuddy workspace'
    },
    model: {
      label: 'Model connections',
      navigationDescription: 'LLMs, embedding models, and credentials',
      description: 'LLMs, embedding models, and credentials'
    },
    runtime: {
      label: 'Agent Runtime',
      navigationDescription: 'OpenCode, Continue, and workspace settings',
      description: 'OpenCode, Continue, and workspace settings'
    },
    security: {
      label: 'Security and data',
      navigationDescription: 'Tool policies and local privacy',
      description: 'Tool policies and local privacy'
    },
    automation: {
      label: 'Automation',
      navigationDescription: 'Smart Heartbeat and periodic reviews',
      description: 'Smart Heartbeat and periodic reviews'
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
      description: 'Works with direct models, OpenCode, and Continue'
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
        'Checks only the official GoodBuddy GitHub Release and never installs automatically'
    }
  },
  actions: {
    testing: 'Testing…',
    saveAndTestModel: 'Save and test model',
    saveAndTestRuntime: 'Save and test {{runtime}}',
    saving: 'Saving…',
    saveSettings: 'Save settings',
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
    cancel: 'Cancel',
    clearing: 'Clearing…',
    clearLocalData: 'Clear local data'
  },
  errors: {
    readSettings: 'Could not load settings',
    detectRuntimes: 'Could not detect Agent Runtimes',
    readEmbeddingStatus: 'Could not load vector index status',
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
    embeddingIndexUnavailable: 'The vector index service is unavailable',
    rebuildEmbeddingIndex: 'Could not start rebuilding the vector index',
    embeddingJobFinished: 'The current vector indexing job has ended',
    cancelEmbeddingIndex: 'Could not cancel rebuilding the vector index',
    selectFile: 'Could not select the file',
    openRuntimeConfig: 'Could not open the Runtime configuration',
    selectWorkspace: 'Could not select the workspace folder',
    retainModelConnection: 'Keep at least one model connection',
    clearLocalData: 'Could not clear local data'
  },
  notifications: {
    settingsSaved: 'Settings saved',
    connectionSucceeded: 'Connected: {{label}}'
  },
  credentials: {
    none: 'Not configured',
    encrypted: 'Encrypted in secure system storage',
    environment: 'Provided by an environment variable',
    configuredPlaceholder: 'Configured; leave blank to keep it',
    enterApiKey: 'Enter API Key',
    noAuthentication: 'No authentication',
    noAuthenticationDescription:
      'No authentication is required; no API Key will be sent'
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
      detecting: 'Detecting…',
      notDetected: 'Not detected'
    },
    workspace: {
      title: 'Default workspace',
      description:
        'Agents use this location only when the current project has no root folder',
      directoryLabel: 'Default workspace folder'
    },
    selectorDescription:
      'OpenCode and Continue are bundled with GoodBuddy. Configure a compatible direct text model to use them.',
    bundledDescription:
      'Bundled GoodBuddy Runtime that follows the text model connection by default',
    runtimeLabel: 'Runtime:',
    modelConfigurationLabel: 'Model configuration:',
    bundledRuntime: 'GoodBuddy bundled {{runtime}}',
    ownConfiguration: 'Use the {{runtime}} configuration',
    followGoodBuddy: 'Follow GoodBuddy · {{name}} ({{model}})',
    noCompatibleModel: 'No compatible text model is configured',
    permissions:
      'Choose Ask or Execute in a conversation. Ask can only use read-only knowledge base and global note tools. Execute can use enabled tools and note-writing tools, and records tool calls in Activity.',
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
        'Most users do not need to change these options. Switch model sources, manage OpenCode configuration, or override the bundled program and service here.',
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
        'Most users do not need to change these options. Switch model sources, manage Continue configuration, or override the bundled program here.',
      followDescription:
        'Generates a secure temporary runtime configuration and deletes it when the task ends.',
      ownDescription:
        'For advanced users who need native models, rules, or MCP configuration.',
      configDescription:
        'GoodBuddy does not open or expose runtime configuration containing temporary credentials. This section manages only the local file you explicitly select.',
      binaryPath: 'Continue executable path',
      missingConfigWarning:
        'Continue remains unavailable without a configuration file and will not load a remote default model anonymously.'
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
      speech: {
        label: 'Speech model',
        description:
          'Select an installed model and save Settings to apply it; models can be downloaded or imported from a local folder.'
      }
    },
    profile: {
      generatedName: 'Model connection {{count}}',
      title: 'LLM model connections',
      description:
        'Supports OpenAI Responses, Anthropic Messages, and OpenAI-compatible Chat Completions. Image models use the separate OpenAI Images Generations protocol.',
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
        'Direct model: {{directCapability}} · Continue: {{continueCompatibility}} · OpenCode: {{openCodeCompatibility}}',
      textChat: 'Text chat',
      compatible: 'Compatible',
      incompatible: 'Incompatible',
      incompatibleImageProtocol:
        'Incompatible (image generation protocol is unsupported)',
      secureStorageWarning:
        'Secure system key storage is unavailable. Use an environment variable to avoid storing an API Key in plaintext.'
    },
    embedding: {
      title: 'Embedding model connection',
      description:
        'Uses an OpenAI-compatible Embeddings API with any provider',
      enabled: 'Enable embedding model',
      endpoint: 'Embedding API URL',
      endpointDescription:
        'Enter the complete OpenAI-compatible Embeddings endpoint.',
      modelName: 'Model name',
      optionalApiKey: 'API Key (optional)',
      optionalApiKeyPlaceholder:
        'Leave blank for a local service without authentication',
      privacyDescription:
        'Only chunks from enabled knowledge bases are sent to this endpoint. The API Key is encrypted in secure system storage. If the embedding service fails, retrieval falls back to FTS5 and the evidence graph.'
    }
  },
  security: {
    sandbox: {
      label: 'Runtime OS sandbox',
      options: {
        auto: 'Automatic (prefer on Linux)',
        strict: 'Strict (refuse to run when unavailable)',
        off: 'Off'
      },
      description:
        'Initial strict isolation supports the embedded OpenCode Runtime on Linux when bubblewrap is installed. External Runtimes and Continue are never incorrectly reported as sandboxed.'
    },
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
        'Off by default. In Ask or Plan mode, when no expert or team is explicitly selected, GoodBuddy chooses one expert. The Subagent uses the default text model in read-only mode without tools.'
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
    }
  }
} satisfies TranslationShape<typeof chineseSettings>
