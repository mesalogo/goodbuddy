import type { TranslationShape } from '../../resource-types'
import type { integrations as chineseIntegrations } from '../zh-CN/integrations'

export const integrations = {
  channels: {
    tabs: {
      weixin: 'WeChat ClawBot',
      wecom: 'WeCom',
      dingtalk: 'DingTalk'
    },
    status: {
      disabled: 'Not enabled',
      stopped: 'Stopped',
      starting: 'Connecting',
      running: 'Connected',
      error: 'Connection failed'
    },
    project: {
      sectionAriaLabel: '{{name}} channel project settings',
      identity: 'Channel project',
      rootLabel: 'Default working directory',
      rootAriaLabel: '{{name}} default working directory',
      selectRootAriaLabel:
        'Choose the default working directory for {{name}}',
      select: 'Choose',
      rootHelp:
        'Remote Execute operations can run only within this project directory.',
      backendLabel: 'Message processing backend',
      backendAriaLabel: '{{name}} message processing backend',
      directModels: 'Direct models',
      unavailableProfile: '{{name}} · {{modelName}} (unavailable)',
      missingProfile: 'The previous direct model no longer exists',
      noTextModels: 'No text models are available',
      missingSelection:
        'The selected direct model no longer exists. Choose another model.',
      imageOnlySelection:
        'The selected connection supports image generation only. Choose a text model or Agent Runtime.',
      missingCredential:
        'The selected direct model has no credential. Configure it under Model connections first.',
      directDescription:
        'Process messages directly with {{name}} ({{modelName}}).',
      automaticDescription:
        'Process messages with the default direct model from Model settings.',
      runtimeDescription:
        'Run through the {{runtime}} Agent Runtime using the global {{runtime}} configuration under Agent Runtime settings.',
      defaultMode: 'Default mode',
      defaultModeAriaLabel: '{{name}} default mode',
      modes: {
        ask: 'Ask',
        execute: 'Execute'
      },
      overrideHelp:
        'Prefix a message with /ask, /execute, Ask:, or Execute: to override the mode temporarily.',
      executeRisk:
        'Execute messages are sent to the selected backend immediately without per-request confirmation.',
      askRisk:
        'In Ask mode, allowlisted senders can still use /execute to start an operation without confirmation.',
      riskSuffix:
        'Connect only trusted accounts and limit the working directory to the required scope.'
    },
    credential: {
      identifiers: {
        wecom: 'Bot ID',
        dingtalk: 'Client ID'
      },
      secrets: {
        wecom: 'Secret',
        dingtalk: 'Client Secret'
      },
      environmentSource: 'Provided by environment variables',
      secretSaved: 'Secret saved with encryption',
      secretMissing: 'Secret not configured',
      readOnly:
        'This channel is managed by environment variables. Change the launch environment and restart the app.',
      enable: 'Enable the {{channel}} channel',
      fieldAriaLabel: '{{channel}} {{field}}',
      keepSecret: 'Leave blank to keep the existing Secret',
      enterSecret: 'Enter a Secret',
      clearSecret: 'Clear the existing Secret when saving',
      allowedSenders: 'Allowed sender IDs',
      allowedSendersAriaLabel: '{{channel}} allowed sender IDs',
      allowedSendersPlaceholder: 'One ID per line, up to 100',
      allowedSendersHelp:
        'Only allowlisted senders can message GoodBuddy. No messages are processed when this list is empty.',
      groupMessages: 'Respond when mentioned in group chats',
      testing: 'Testing…',
      testConnection: 'Test {{channel}} connection'
    },
    qr: {
      title: 'Connect WeChat ClawBot',
      instructions:
        'In WeChat, open Settings → ClawBot → Start scanning, then scan the QR code below. The QR code is never sent to a third-party page.',
      close: 'Close WeChat connection',
      imageAlt: 'WeChat ClawBot connection QR code',
      generating: 'Generating QR code…',
      scanned: 'Scanned. Confirming…',
      verificationRequired: 'Enter the WeChat verification code',
      waiting: 'Waiting to scan',
      remaining: 'QR code expires in {{seconds}} seconds',
      verificationCode: 'Verification code',
      submitVerification: 'Submit verification code',
      expired: 'QR code expired',
      failed: 'Connection failed',
      retryFallback: 'Generate a new QR code and try again.',
      regenerate: 'Generate a new QR code'
    },
    weixin: {
      accountFallback: 'WeChat account',
      bindingSaved: '{{account}} · Credentials saved with encryption',
      unbound: 'No personal WeChat account connected',
      enable: 'Enable the WeChat ClawBot channel',
      rebind: 'Reconnect',
      bind: 'Connect with QR code',
      disconnect: 'Remove local connection',
      disconnectHelp:
        'Removing the connection deletes locally saved credentials but may not revoke authorization on WeChat.',
      behaviorHelp:
        'Processes private text, image, and file messages sent to ClawBot by the connected account. Group chats are ignored. Each message supports up to 4 attachments and 12 MB total.'
    },
    sectionAriaLabel: 'Message channel configuration',
    unavailableService:
      'Message channel settings are unavailable in this version',
    loadError: 'Failed to load message channel settings',
    projectsLoadingError: 'Channel projects have not loaded',
    rootRequired:
      '{{channel}} requires a default working directory',
    saved: 'Message channel settings saved and applied',
    saveError: 'Failed to save message channel settings',
    selectRootError: 'Failed to choose a working directory',
    startBindingError: 'Failed to start the WeChat connection',
    verifyBindingError: 'Failed to submit the WeChat verification code',
    disconnected: 'Removed the locally saved WeChat connection',
    disconnectError: 'Failed to remove the WeChat connection',
    connectionSuccess: '{{channel}} connected successfully',
    testError: 'Channel connection test failed',
    loading: 'Loading message channel settings…',
    saving: 'Saving…',
    save: 'Save channel settings'
  },
  mcp: {
    runtimeLabels: {
      model: 'Model',
      opencode: 'OpenCode',
      continue: 'Continue'
    },
    diagnosticStatuses: {
      available: 'Available',
      degraded: 'Partially available',
      unavailable: 'Unavailable',
      disabled: 'Not enabled'
    },
    errors: {
      load: 'Failed to load MCP settings',
      operation: 'Capability settings operation failed',
      unsupportedDiagnostics:
        'Computer control diagnostics are unavailable in this version',
      diagnostics: 'Capability diagnostics failed',
      unsupportedProfiles:
        'Managed browser profiles are unavailable in this version',
      test: 'MCP connection test failed',
      unsupportedComputerControl:
        'Computer control capabilities are unavailable in this version'
    },
    addServer: 'Add server',
    sectionAriaLabel: 'MCP configuration',
    tabs: {
      ariaLabel: 'MCP settings categories',
      builtin: 'Built-in capabilities',
      computer: 'Computer control',
      custom: 'Custom MCP'
    },
    customNotice:
      'Custom MCP currently works only with direct models. New servers are assigned to direct models by default and loaded only in Execute mode. Runtime-owned MCP configuration is not managed here.',
    securityNotice:
      'Built-in tools are provided by GoodBuddy and are not MCP servers. Custom MCP servers and tools run with the current user’s permissions, so add only trusted services. Remote access tokens are encrypted in secure system storage, and tool calls still require GoodBuddy approval.',
    computer: {
      title: 'Computer control capabilities',
      subtitle: 'Off by default; approval still applies when enabled',
      browserTitle: 'Browser capabilities',
      browserSubtitle: 'Managed browser and built-in browser tools',
      supported: 'Supported on this device',
      unsupported: 'Not supported on this device',
      enabled: 'Enabled',
      disabled: 'Disabled',
      enableAriaLabel: 'Enable {{name}}',
      browserProfile: 'Managed browser profile',
      profileAriaLabel: 'Managed profile used by browser control',
      defaultProfile: 'Use the default managed profile',
      diagnoseAriaLabel: 'Diagnose {{name}}',
      diagnosing: 'Diagnosing…',
      diagnose: 'Run diagnostics',
      result: 'Diagnostic result: {{status}}',
      remedy: ' Suggested action: {{remedy}}'
    },
    profiles: {
      title: 'Managed browser profiles',
      count: '{{count}}',
      notice:
        'Each profile uses isolated storage managed by GoodBuddy. The interface never receives or displays executable paths, command arguments, or environment variables.',
      newName: 'New profile name',
      placeholder: 'For example: Work sites',
      create: 'Create managed profile',
      empty: 'No managed browser profiles',
      name: 'Profile name',
      nameAriaLabel: 'Profile name {{name}}',
      setDefaultAriaLabel: 'Set {{name}} as the default profile',
      default: 'Default',
      renameAriaLabel: 'Rename profile {{name}}',
      rename: 'Rename',
      deleteAriaLabel: 'Delete profile {{name}}',
      delete: 'Delete',
      inUse: 'This profile is used by a computer control capability'
    },
    builtin: {
      title: 'Built-in GoodBuddy MCP',
      availableTo: 'Available to: Model, OpenCode, Continue',
      notice:
        'GoodBuddy grants built-in MCP short-lived permissions for the current conversation in the main process without exposing service addresses or credentials.',
      serverSummaryMixed:
        'Built-in MCP server · Access depends on mode · Authorized per conversation',
      serverSummaryReadOnly:
        'Built-in MCP server · Read-only · Authorized per conversation',
      serverSummaryDisabled:
        'Built-in MCP server · Disabled · Enable Magic Notes first',
      featureDisabled:
        'Magic Notes is disabled, so this built-in capability does not provide tools to any runtime.',
      collapseServer: 'Collapse server {{name}}',
      expandServer: 'Expand server {{name}}',
      toolCount: '{{count}} tools',
      toolsAriaLabel: '{{name}} tools',
      tools: 'Tools',
      write: 'Write',
      readOnly: 'Read-only'
    },
    modelTools: {
      title: 'Built-in direct-model tools',
      groupCount: '{{count}} groups',
      collapseGroup: 'Collapse tool group {{name}}',
      expandGroup: 'Expand tool group {{name}}',
      summary: 'Built-in GoodBuddy capability for direct models'
    },
    webSearch: {
      title: 'Web search',
      subtitle: 'Direct-model tool · Exa MCP · Ask / Execute',
      description:
        'Provides web_search and web_fetch for public web search and reading only. The tools are available in Ask and Execute.',
      privacy:
        'Queries and public webpage addresses are sent to the third-party Exa service. Model API keys, local files, and knowledge content are not sent.',
      enableAriaLabel: 'Enable direct-model web search',
      enabled: 'Enabled',
      disabled: 'Disabled',
      test: 'Run real search test',
      testing: 'Searching…',
      unsupported: 'Web search settings are unavailable in this version',
      testFailed: 'Web search test failed',
      resultAriaLabel: 'Web search test result',
      result: 'Real search succeeded · {{duration}} ms',
      toolsAriaLabel: 'Direct-model web search tools'
    },
    editor: {
      editTitle: 'Edit MCP server',
      addTitle: 'Add MCP server',
      closeAriaLabel: 'Close MCP editor',
      name: 'Name',
      description: 'Description',
      transport: 'Transport',
      stdio: 'stdio (local process)',
      sse: 'SSE (legacy compatibility)',
      command: 'Executable command or absolute path',
      commandAriaLabel: 'MCP executable command',
      commandPlaceholder: 'For example: npx or C:\\Tools\\server.exe',
      args: 'Arguments (one per line)',
      argsAriaLabel: 'MCP command arguments',
      savedTokenPlaceholder: 'Leave blank to keep the saved token',
      optional: 'Optional',
      clearToken: 'Clear the saved Bearer Token when saving',
      enable: 'Enable this MCP server',
      allowDynamicTools: 'Allow dynamic tool-list updates',
      allowDynamicToolsDescription:
        'Applies only when a trusted server advertises support. Updated tools are revalidated and used in the next model round, and existing approval controls still apply.',
      assignTo: 'Assign to',
      cancel: 'Cancel',
      saving: 'Saving…',
      save: 'Save MCP server'
    },
    custom: {
      title: 'Custom MCP servers (advanced)',
      count: '{{count}}',
      notice:
        'Custom stdio MCP starts in a restricted environment without desktop session variables. For computer control, use the diagnosed built-in capabilities above.',
      empty: 'No MCP servers configured',
      collapseServer: 'Collapse server {{name}}',
      expandServer: 'Expand server {{name}}',
      enabled: 'Enabled',
      disabled: 'Disabled',
      encryptedToken: ' · Encrypted token',
      dynamicToolsEnabled: ' · Dynamic tools allowed',
      dynamicToolsSupported: 'Server supports dynamic tool-list updates',
      dynamicToolsUnsupported:
        'Server does not advertise dynamic tool-list updates',
      toolsUndetected: 'Tools not checked',
      testAriaLabel: 'Test {{name}}',
      test: 'Test',
      editAriaLabel: 'Edit {{name}}',
      edit: 'Edit',
      deleteAriaLabel: 'Delete {{name}}',
      delete: 'Delete',
      assigned: 'Assigned:',
      assignmentSeparator: ', ',
      none: 'None',
      noTools: 'The server exposes no available tools.',
      testHelp: 'Select Test to connect to the server and load its tool list.'
    }
  }
} satisfies TranslationShape<typeof chineseIntegrations>
