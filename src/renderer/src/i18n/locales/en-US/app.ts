import type { TranslationShape } from '../../resource-types'
import type { app as chineseApp } from '../zh-CN/app'

export const app = {
  brand: {
    desktopWorkspace: 'Desktop workspace'
  },
  notifications: {
    success: 'Success',
    error: 'Error',
    info: 'Notice',
    close: 'Close notification',
    viewport: 'App notifications'
  },
  releaseNotes: {
    eyebrow: 'VERSION UPDATE',
    title: "What's New in GoodBuddy {{version}}",
    description: 'Review the key changes and usage notes in this release.',
    highlights: 'Highlights',
    features: 'Features',
    fixes: 'Bug Fixes',
    notices: 'Before You Start',
    close: 'Close release notes',
    start: 'Get Started',
    closing: 'Closing…',
    acknowledgeFailed: 'Could not save the read state. Please try again.'
  },
  window: {
    minimizeAria: 'Minimize window',
    minimize: 'Minimize',
    maximizeAria: 'Maximize window',
    maximize: 'Maximize',
    restoreAria: 'Restore window',
    restore: 'Restore',
    closeAria: 'Close window',
    close: 'Close',
    errors: {
      readState: 'Failed to read the window state',
      minimize: 'Failed to minimize the window',
      resize: 'Failed to change the window size',
      close: 'Failed to close the window'
    }
  },
  navigation: {
    label: 'Main navigation',
    chat: 'Chat',
    magicNotes: 'Magic Notes',
    knowledge: 'Knowledge',
    heartbeat: 'Smart Heartbeat',
    activity: 'Run history',
    incompleteTodos: '{{count}} incomplete to-dos',
    pendingSuggestions: '{{count}} pending suggestions'
  },
  route: {
    loading: 'Loading page…',
    loadFailed: 'The page component failed to load. Reload the app.',
    reload: 'Reload'
  },
  sidebar: {
    label: 'Main sidebar',
    newConversation: 'New conversation',
    searchLabel: 'Search conversations',
    searchPlaceholder: 'Search titles or messages',
    recent: 'Recent conversations',
    localWorkspace: 'Local workspace',
    loading: 'Loading',
    close: 'Close sidebar',
    toggle: 'Toggle sidebar'
  },
  topbar: {
    toggleAssistantSidebar: 'Toggle assistant workspace',
    switchLight: 'Switch to light theme',
    switchDark: 'Switch to dark theme'
  },
  conversation: {
    defaultTitle: 'New conversation',
    remoteTitle: 'Remote conversation',
    greeting:
      'Hi, I’m GoodBuddy. Ask me a question, add local files, or use your knowledge base. With an Agent Runtime enabled, I can also use tools with your authorization.',
    interrupted: 'The previous run stopped unexpectedly. You can resend your question.',
    active: 'Conversation is active',
    unread: 'Unread',
    unreadRemote: 'Unread remote message',
    noRemote: 'No remote conversations yet',
    noMatches: 'No matching conversations',
    renameAria: 'Rename conversation {{title}}',
    saveName: 'Save conversation name',
    cancelRename: 'Cancel rename',
    exportFallbackName: 'GoodBuddy conversation',
    branch: {
      badge: 'Branched conversation, source: {{title}}',
      suffix: 'Branch',
      creating: 'Creating branch',
      anotherCreating: 'Another branch is being created. Please wait.',
      storageUnavailable:
        'Conversation storage is not ready yet. Please wait.',
      unavailable:
        'Finish the active run or pending items before creating a branch'
    },
    actions: {
      more: 'More conversation actions for {{title}}',
      region: 'Conversation actions for {{title}}',
      branch: 'Continue in a new conversation',
      rename: 'Rename conversation',
      copy: 'Copy full conversation',
      export: 'Export Markdown'
    },
    tasks: {
      toggle: 'Expand or collapse {{count}} tasks in “{{title}}”',
      list: 'Tasks in “{{title}}”',
      viewAll: 'View all {{count}} tasks'
    },
    delete: {
      cancelAria: 'Cancel deleting conversation {{title}}',
      confirmAria: 'Confirm permanently deleting conversation {{title}}',
      confirm: 'Permanently delete conversation',
      message:
        'This permanently deletes all content in the conversation. Any running task in it will also stop. This action cannot be undone.',
      triggerAria: 'Delete conversation {{title}}',
      trigger: 'Delete conversation'
    }
  },
  customTask: {
    eyebrow: 'CUSTOM TASK',
    title: 'New custom task',
    description:
      'Create a task that runs on schedule and keeps recording results in a conversation.',
    close: 'Close new custom task',
    fields: {
      name: 'Task name',
      instructions: 'Task instructions',
      destination: 'Conversation',
      mode: 'Work mode',
      recurrence: 'Frequency',
      time: 'First run'
    },
    destination: {
      current: 'Current conversation',
      new: 'New conversation',
      currentHelp:
        'Associate the task with this conversation without renaming it or changing normal chat.',
      newHelp:
        'Create a conversation for this task, using the task name as its initial title.',
      currentUnavailable:
        'The current conversation cannot host this task. Choose a new conversation.'
    },
    mode: {
      execute: 'Execute',
      ask: 'Ask',
      executeUnavailable:
        'The current Runtime cannot use tools, so read-only Ask is selected.'
    },
    recurrence: {
      once: 'Once',
      daily: 'Daily',
      weekly: 'Weekly'
    },
    scope: {
      title: 'Execution scope',
      project: 'Project',
      runtime: 'Runtime',
      workspace: 'Workspace',
      tools: 'Tools and approval',
      executeApproval:
        'Use authorized tools; high-risk actions still require approval',
      askReadOnly: 'Read-only run with no changes allowed',
      noWorkspace: 'No workspace configured'
    },
    errors: {
      title: 'Enter a task name.',
      instructions: 'Enter task instructions.',
      destination: 'Choose an available conversation.',
      time: 'Choose a valid first run time.',
      futureTime: 'The first run must be in the future.',
      create: 'Could not create the task. Try again.',
      projectUnavailable: 'Select an available regular project first.'
    },
    cancel: 'Cancel',
    create: 'Create task',
    creating: 'Creating…'
  },
  runtime: {
    unavailable: 'Runtime unavailable',
    detecting: 'Detecting runtime',
    imageGeneration: 'Image',
    directModel: 'Direct model',
    automatic: 'Automatic',
    automaticSelection: 'Automatic selection',
    modelUnavailable: 'Model configuration unavailable',
    selectModel: 'Select the model again in Settings',
    ownConfiguration: 'Own configuration',
    useOwnConfiguration: 'Use {{runtime}}’s own configuration',
    switched: 'This conversation now uses {{label}}',
    selectionUnavailable: '{{label}} is unavailable: {{detail}}',
    loadingRetry: 'Agent Runtime is loading. Try again shortly.',
    updatingRetry: 'Agent Runtime status is updating. Try again shortly.',
    notSelected: 'No Runtime is selected for this conversation',
    connecting: 'Connecting to Agent Runtime',
    pickerTitle: 'Runtime and model: {{label}}',
    switching: 'Switching…',
    picker: 'Runtime and model',
    directModels: 'Direct models',
    deepseekHarnessGroup:
      'DeepSeek Harness (Developer preview · OpenAI-compatible)',
    manage: 'Manage Runtime and model connections',
    errors: {
      readStatus: 'Failed to read Agent Runtime status',
      readSettings: 'Failed to read Runtime settings',
      switch: 'Failed to switch Runtime'
    }
  },
  chat: {
    heading: 'Conversation',
    user: 'You',
    taskResult: 'Task result: {{title}}',
    welcome: {
      eyebrow: 'GOODBUDDY WORKSPACE',
      title: 'What would you like to accomplish today?',
      description:
        'Ask a question, organize information, or connect OpenCode for file search and development tools.'
    },
    quickActions: {
      summarize: {
        title: 'Summarize content',
        description: 'Extract key points and action items',
        prompt: 'Summarize the following content with key points and action items:\n'
      },
      analyzeError: {
        title: 'Analyze an error',
        description: 'Identify causes and troubleshooting steps',
        prompt: 'Analyze this error and suggest likely causes and troubleshooting steps:\n'
      },
      write: {
        title: 'Draft work content',
        description: 'Draft an email, update, or proposal',
        prompt: 'Help me draft clear, professional work content:\n'
      }
    },
    remote: {
      title: 'Remote channel conversation',
      openSettings: 'Open Settings',
      emptyDescription:
        'Connect {{project}} first. The conversation will appear here after a remote user sends the first message.',
      continueInClient:
        'Continue messaging in the {{client}} client. Use this window to view history, tasks, and results.',
      waiting:
        'The conversation will appear here after a remote user sends a message.'
    },
    attachments: {
      label: 'Attachments',
      region: 'Message attachments',
      exportHeading: 'Attachments:',
      exportItem: '- {{name}} ({{size}})'
    },
    exportSpeaker: '{{speaker}}:\n{{content}}',
    images: {
      view: 'View',
      download: 'Download',
      viewNamed: 'View image {{title}}',
      downloadNamed: 'Download image {{title}}',
      downloadImage: 'Download image',
      closeViewer: 'Close image viewer',
      fallbackTitle: 'GoodBuddy image'
    },
    reasoning: {
      streaming: 'Reasoning',
      complete: 'Reasoning process'
    },
    contextCompression: {
      compressing: 'Compressing earlier conversation…',
      completed:
        'Earlier conversation compressed (estimated) · ≈{{before}} → ≈{{after}}',
      failed: 'Earlier conversation compression failed',
      agentCompressing: 'Compacting Agent execution context…',
      agentCompleted:
        'Agent context compacted {{count}} time(s) (estimated) · ≈{{before}} → ≈{{after}}',
      agentFailed: 'Agent execution context compression failed'
    },
    sources: 'Sources: {{sources}}',
    citations: {
      view: 'View {{count}} evidence references',
      retrieval: 'Retrieved by: ',
      fullText: 'Full text',
      cjk: 'CJK terms',
      vector: 'Vector',
      graph: 'Graph',
      viewContext: 'View context',
      openSource: 'Open source',
      openFailed: 'Could not open the citation source',
      contextTitle: 'Citation context',
      contextDescription:
        'Review the matched chunk and its surrounding content.',
      contextLoading: 'Loading citation context…',
      contextUnavailable: 'Citation context is unavailable',
      contextTruncated:
        'Context exceeded the safe display limit and was truncated.',
      closeContext: 'Close citation context',
      matchedChunk: 'Matched chunk',
      surroundingContext: 'Full context',
      score: 'Relevance {{score}}'
    },
    knowledgeRetrieval: {
      searching: 'Searching the enabled knowledge bases',
      states: {
        searching: 'Searching knowledge bases',
        succeeded: 'Knowledge retrieval completed',
        zero: 'No relevant knowledge found',
        degraded: 'Knowledge retrieval was degraded',
        failed: 'Knowledge retrieval failed',
        cancelled: 'Knowledge retrieval was cancelled'
      },
      summary:
        'Searched {{libraries}} libraries, found {{results}} results in {{duration}} ms',
      channels: 'Channels used: {{channels}}',
      channelNames: {
        fts: 'Full text',
        cjk: 'CJK terms',
        vector: 'Vector',
        graph: 'Graph'
      }
    },
    retry: 'Edit and send again',
    loadEarlierMessages: 'Load earlier messages ({{count}} remaining)',
    scrollToBottom: 'Scroll to bottom',
    status: {
      responseTruncated: 'The response was too long and was truncated locally',
      savingImage: 'Image generated; saving the result',
      taskCompleted: 'Task completed',
      taskFailed: 'Task failed',
      runtimeCompleted: 'Agent Runtime completed its response',
      answerSubmitted: 'Answer submitted; OpenCode is continuing',
      questionSkipped: 'Question skipped'
    },
    tools: {
      region: 'Tool execution, {{count}} items',
      title: 'Tool execution',
      count: '{{count}} items',
      input: 'Call arguments',
      output: 'Result',
      error: 'Error details',
      noDetails: 'No execution details are available yet.',
      states: {
        pending: 'Pending',
        running: 'Running',
        completed: 'Completed',
        failed: 'Failed',
        recoverable: 'Retry available',
        cancelled: 'Cancelled',
        interrupted: 'Interrupted'
      }
    },
    subagents: {
      region: 'Subagent status',
      smart: 'Smart routing',
      manual: 'Selected manually',
      fallbackTask: '{{name}} subagent task',
      output: 'Expert output',
      error: 'Execution details',
      noOutput: 'This expert has no output to display yet.',
      states: {
        queued: 'Queued',
        running: 'Running',
        completed: 'Completed',
        failed: 'Failed',
        cancelled: 'Cancelled'
      }
    },
    approval: {
      deny: 'Deny',
      once: 'Allow once',
      session: 'Allow for conversation',
      permanent: 'Always allow',
      decisionDeny: 'Denied',
      decisionOnce: 'Allowed once',
      decisionSession: 'Allowed for this conversation',
      decisionPermanent: 'Always allowed',
      executing: '{{decision}}; Agent is running',
      denied: 'Tool execution denied',
      responseFailed: 'Failed to respond to approval. Try again.'
    }
  },
  composer: {
    menuSelection: '{{label}}: {{selection}}',
    inputLabel: 'Message GoodBuddy',
    placeholder: 'Message GoodBuddy…',
    imagePlaceholder: 'Describe the image you want to generate…',
    keyboardHint:
      'Enter to send · Shift+Enter for a new line · Ctrl+V to paste an image or text',
    addContent: 'Add content',
    addAttachment: 'Add attachment',
    attachmentProgress: {
      selecting: 'Selecting attachments…',
      reading: 'Reading {{name}}',
      parsing: 'Parsing {{name}}',
      waiting: 'Files will be read and parsed after selection',
      fileCount: 'File {{current}} of {{total}}',
      progressLabel: 'Attachment reading and parsing progress',
      waitBeforeSending:
        'Attachments are still being parsed. Wait for them to finish before sending.'
    },
    removeAttachment: 'Remove {{name}}',
    settings: 'Conversation settings',
    expertLabel: 'Expert role',
    modeLabel: 'Work mode',
    runtimeControls: {
      groupLabel: '{{runtime}} controls',
      agentLabel: 'OpenCode Runtime Agent',
      presetLabel: 'Continue configuration preset',
      actionLabel: 'Runtime shortcut',
      configuredAgent: 'Default · {{name}}',
      runtimeDefaultAgent: 'OpenCode default Agent',
      runtimeDefaultAgentDescription:
        'Use the default Runtime Agent saved in settings',
      agentDescription: 'Native OpenCode Runtime Agent',
      noPreset: 'Use the settings default',
      noPresetDescription:
        'Apply the default Continue preset from Runtime settings',
      presetDescription:
        '{{rules}} enabled Rules · {{prompts}} Prompts',
      noAction: 'Runtime shortcuts',
      noActionDescription: 'Send the composer input directly',
      commandDescription: 'Run an OpenCode Command',
      promptDescription: 'Insert a Prompt and keep editing'
    },
    stop: 'Stop generating',
    send: 'Send',
    sendTitle: 'Send message',
    queueMessage: 'Queue message',
    queueMessageTitle: 'Send after the current response finishes',
    queue: {
      ariaLabel: 'Conversation send queue',
      scheduledTask: 'Scheduled task',
      message: 'Message',
      interrupt: 'Interrupt and run',
      runNow: 'Run now',
      interruptAria:
        'Interrupt the current response and run “{{title}}” next',
      runNowAria: 'Run “{{title}}” now',
      remove: 'Remove',
      removeAria: 'Remove “{{title}}” from the send queue',
      actionFailed: 'Failed to update the send queue'
    },
    shortcut: 'Quick access: ',
    context: {
      confirmedTokenCount: 'Latest call {{used}}',
      tokenCount: 'Estimated latest call ≈{{used}}',
      confirmedWindowUsage:
        'Latest call {{used}} / {{total}} · {{percentage}}%',
      windowUsage:
        'Estimated latest call ≈{{used}} / {{total}} · {{percentage}}%',
      confirmedThresholdUsage:
        'Latest call {{used}} · Compression at {{total}}',
      thresholdUsage:
        'Estimated latest call ≈{{used}} · Compression at {{total}}',
      conversationTokenCount:
        'Estimated compressed conversation ≈{{used}}',
      conversationWindowUsage:
        'Estimated compressed conversation ≈{{used}} / {{total}} · {{percentage}}%',
      conversationThresholdUsage:
        'Estimated compressed conversation ≈{{used}} · Compression at {{total}}',
      progressLabel: 'Current context usage',
      compressionTrigger: 'Automatic compression at ≈{{tokens}}',
      compact: 'Compact context',
      compacting: 'Compacting…',
      nothingToCompact: 'There is no earlier conversation history to compact',
      compactFailed: 'Context compaction failed'
    },
    experts: {
      general: 'General assistant',
      generalDescription: 'Default single assistant',
      team: 'Expert team (parallel)',
      teamDescription: 'Multiple experts collaborate in parallel',
      customDescription: 'Custom expert role'
    },
    modes: {
      ask: {
        label: 'Ask · Read only',
        description: 'Read-only answers without modifying files'
      },
      execute: {
        label: 'Execute · Controlled',
        description: 'Use tools after approval'
      }
    },
    voice: {
      stopRecording: 'Stop recording',
      cancel: 'Cancel speech recognition',
      input: 'Voice input',
      stopAndRecognize: 'Stop recording and recognize speech',
      description: 'Convert speech to editable text before sending',
      unsupported:
        'Built-in speech recognition is unavailable. You can keep typing.',
      downloadingPack:
        'Downloading the offline speech pack. Dictation will start automatically.',
      transcribed: 'Speech converted to text. Edit it before sending.',
      localListening: 'Listening with local speech recognition',
      systemListening: 'Listening with the system speech service',
      startFailed: 'Could not start speech recognition. Check system speech settings.',
      microphoneUnavailable:
        'The microphone is unavailable. Check your recording device and permissions.',
      recording: 'Recording. Click the voice button again to recognize speech.',
      localRecognizing: 'Recognizing with the local speech model',
      noSpeech: 'No speech detected. Move closer to the microphone and try again.',
      cancelled: 'Speech recognition cancelled',
      localFailed: 'Local speech recognition failed',
      permissionDenied:
        'Microphone access was denied. Allow GoodBuddy in system privacy settings.',
      recordingStartFailed: 'Could not start recording',
      preparing: 'Recording complete; preparing local recognition',
      serviceNotLoaded:
        'Local speech recognition did not load. Restart GoodBuddy and try again.',
      availabilityTimeout:
        'Checking the offline speech pack timed out. Check your connection and try again.',
      downloadTimeout:
        'Downloading the offline speech pack timed out. Check your connection and try again.',
      packDownloading:
        'The offline speech pack is still downloading. Try again shortly.',
      recordingCancelled: 'Voice recording cancelled',
      noRecording: 'No audio was recorded. Check your microphone and try again.',
      errors: {
        aborted: 'Speech recognition cancelled',
        audioCapture:
          'No microphone is available. Check your device and system input settings.',
        languageNotSupported:
          'The required offline speech pack is not available on this system.',
        network:
          'Electron online speech recognition is unavailable. Install the offline speech pack and try again.',
        noSpeech:
          'No speech was detected. Move closer to the microphone and try again.',
        permission:
          'Microphone access was denied. Allow GoodBuddy in system privacy settings.',
        phrasesNotSupported:
          'This speech recognition service does not support phrase enhancement.',
        badGrammar:
          'This speech recognition service cannot process the grammar configuration.',
        generic:
          'Speech recognition failed. Check your microphone and system speech settings.'
      }
    },
    knowledge: {
      select: 'Select knowledge bases, {{count}} enabled',
      title: 'Select knowledge bases for this conversation',
      scope: 'Retrieval scope for this conversation',
      documents: '{{count}} documents',
      modeLabel: 'Knowledge retrieval mode',
      auto: 'Model decides',
      always: 'Always retrieve first',
      autoDescription:
        'Let the model decide whether the current question needs knowledge.',
      alwaysDescription:
        'GoodBuddy searches the enabled knowledge bases before the model answers.'
    },
    hints: {
      configureRuntime: 'Configure an available model or Agent Runtime first.',
      imageGeneration:
        'Image model: describe a scene to generate an image that will appear here and be saved to Results.',
      agentAsk:
        '{{runtime}} Ask mode: can only search enabled knowledge bases and cannot modify files.',
      agentExecute:
        '{{runtime}} Execute mode: tool calls do not show GoodBuddy approvals and are recorded in Activity.',
      ask: 'Ask mode: read-only answers without tool calls or file changes.',
      execute:
        'Execute mode: tools are automatically authorized and calls are still recorded in Activity.'
    },
    errors: {
      pasteImageType: 'Only JPEG, PNG, or WebP images can be pasted',
      pasteImageSize: 'Pasted images cannot exceed 12 MB',
      attachmentLimit: 'A message can include up to 8 attachments',
      addContext: 'Failed to add context'
    }
  },
  notices: {
    updateAvailable:
      'GoodBuddy {{version}} is available. View it in About & Updates.',
    channelConversationAutomatic:
      'Channel conversations are created automatically when the client receives a new message',
    deleteConversationCancelFailed:
      'Could not stop the running task, so the conversation was not deleted',
    deleteConversationPersistenceFailed:
      'Could not delete the local conversation, so it was kept',
    deletedConversationBrowserCloseFailed:
      'Failed to close the browser for the deleted conversation',
    conversationCopied: 'Conversation copied to the clipboard',
    clipboardUnavailable:
      'Cannot access the clipboard. Check your system permissions.',
    conversationExported: 'Conversation exported',
    conversationBranched: 'Branch created and opened',
    conversationBranchFailed:
      'Failed to create a conversation branch. Try again.',
    imageUnavailable: 'Image content is unavailable',
    imageDownloadStarted: 'Image download started',
    remoteConversationReadOnly:
      'Continue a remote conversation from its messaging app',
    sendFailed: 'Failed to send',
    stopFailed: 'Failed to stop generating. Try again.',
    projectNotLoaded: 'The current project has not loaded yet.',
    browserControlUnavailable:
      'The built-in browser has not loaded. Restart GoodBuddy.',
    browserStopFailed: 'Failed to stop the browser. Try again.',
    scheduleStarted: 'Scheduled task queued',
    conversationQueueReadFailed: 'Failed to read the send queue',
    conversationQueueReleaseFailed:
      'The message failed and could not be restored to the send queue',
    conversationQueueResumeFailed:
      'Failed to resume this conversation’s send queue',
    conversationPersistenceFailed:
      'Failed to save conversations. Check local storage.',
    remoteConversationRefreshFailed:
      'Failed to refresh remote channel conversations',
    projectReadFailed: 'Failed to read projects',
    expertsReadFailed: 'Failed to read expert roles',
    appInfoReadFailed: 'Failed to read app information',
    workspaceChangesReadFailed: 'Failed to read workspace changes',
    tokenUsageReadFailed: 'Failed to read token usage',
    resultsRefreshFailed: 'Failed to refresh results',
    generatedImageReadFailed: 'Failed to read the generated image',
    remoteMessage: 'New message from {{channel}}',
    memoryReadFailed: 'Failed to read long-term memory',
    schedulesReadFailed: 'Failed to read scheduled tasks',
    taskHistoryReadFailed: 'Failed to read task history',
    resultHistoryReadFailed: 'Failed to read result history',
    knowledgeReadFailed: 'Failed to read the local knowledge base',
    selectProject: 'Select a project first',
    heartbeatReadFailed: 'Failed to read Smart Heartbeat',
    heartbeatRefreshFailed: 'Failed to refresh Smart Heartbeat',
    heartbeatTaskPrompt:
      'Create an actionable plan from this Smart Heartbeat suggestion:',
    heartbeatTaskAdded:
      'Added “{{title}}” to the conversation. Review it before sending.',
    userStartedTask: 'User started a conversation task',
    userDecision: 'User selected {{decision}}',
    conversationDeleted: 'The related conversation has been deleted',
    localDataCleared:
      'Local conversations, tasks, memory, heartbeat data, automations, and knowledge indexes were cleared',
    selectKnowledgeBase: 'Select a knowledge base first',
    knowledgeGraphRebuilt: 'Knowledge graph extracted again',
    knowledgeSettingsUpdated: 'Knowledge base settings updated',
    knowledgeRebuildCompleted: 'Rebuilt {{count}} documents',
    knowledgeRebuildPartial:
      'Library rebuild was incomplete: {{rebuilt}} succeeded, {{failed}} failed',
    knowledgeRebuildNotRunning:
      'There is no active library rebuild to cancel',
    knowledgeTaskNotRunning:
      'This task has finished or cannot currently be cancelled',
    evidenceExcerpt: '{{source}}: {{excerpt}}'
  },
  markdown: {
    scrollableTable: 'Table, horizontally scrollable',
    mermaidDiagram: 'Mermaid diagram, horizontally scrollable',
    mermaidLoading: 'Rendering Mermaid diagram…',
    mermaidError:
      'The Mermaid diagram could not be rendered. Its source is shown below.',
    mermaidActions: 'Mermaid diagram actions',
    mermaidViewSource: 'View source',
    mermaidHideSource: 'Hide source',
    mermaidOpenViewer: 'Open large diagram',
    mermaidViewerTitle: 'Large Mermaid diagram',
    mermaidViewerHint:
      'Use the mouse wheel or buttons to zoom, and drag the canvas to pan.',
    mermaidViewerCanvas: 'Zoomable, pannable Mermaid diagram',
    mermaidZoomOut: 'Zoom out diagram',
    mermaidZoomIn: 'Zoom in diagram',
    mermaidResetZoom: 'Reset zoom',
    mermaidZoomLevel: 'Current zoom level',
    mermaidCloseViewer: 'Close large Mermaid diagram'
  }
} satisfies TranslationShape<typeof chineseApp>
