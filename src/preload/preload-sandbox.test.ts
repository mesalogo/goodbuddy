import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('sandboxed preload', () => {
  it('does not import Node built-ins unavailable in Electron sandbox', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/\bfrom\s+['"]node:/u)
    expect(source).not.toMatch(/\brequire\(\s*['"]node:/u)
  })

  it('does not load runtime schema libraries in the Electron sandbox', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/\b\w+Schema\b/u)
    expect(source).not.toMatch(/\bfrom\s+['"]zod['"]/u)
  })

  it('exposes only narrow browser-control methods', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    const browser =
      source.match(
        /browser: \{(?<body>[\s\S]*?)\r?\n {2}\},\r?\n {2}terminal:/u
      )?.groups?.body ?? ''
    for (const method of [
      'navigate:',
      'back:',
      'reload:',
      'stopLoading:',
      'interact:',
      'stop:',
      'onState:'
    ]) {
      expect(browser).toContain(method)
    }
    expect(browser).not.toMatch(
      /\b(?:webContents|debugger|session|partition|cookie)\b/iu
    )
  })

  it('exposes bounded local tool environment operations without execution inputs', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    const localTools =
      source.match(
        /localToolEnvironment: \{(?<body>[\s\S]*?)\r?\n {2}\},\r?\n {2}feedback:/u
      )?.groups?.body ?? ''
    for (const method of [
      'getSnapshot:',
      'updateSettings:',
      'refreshCandidates:',
      'selectExecutable:',
      'diagnose:',
      'installPython:',
      'cancelPython:',
      'removePython:',
      'onProgress:'
    ]) {
      expect(localTools).toContain(method)
    }
    expect(localTools).not.toMatch(
      /\b(?:command|env|url|hash|installDirectory|shim)\b/iu
    )
    expect(localTools).toContain('ipcRenderer.removeListener(')
  })

  it('exposes only explicit computer capability and managed profile IPC methods', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('setComputerCapabilityEnabled:')
    expect(source).toContain('diagnoseComputerCapability:')
    expect(source).toContain('createBrowserProfile:')
    expect(source).toContain('renameBrowserProfile:')
    expect(source).toContain('setDefaultBrowserProfile:')
    expect(source).toContain('removeBrowserProfile:')
    expect(source).not.toMatch(
      /(?:setComputerCapability|BrowserProfile).{0,80}(?:executablePath|command|env|args)/su
    )
  })

  it('exposes model ZIP dialogs without renderer-controlled paths', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('importArchive: (modelId: string)')
    expect(source).toContain('exportArchive: (modelId: string)')
    expect(source).toContain('importOcrModelArchive: (modelId: string)')
    expect(source).toContain('exportOcrModelArchive: (modelId: string)')
    expect(source).toContain('importModelArchive: (modelId: string)')
    expect(source).toContain('ipcChannels.embeddingModelsImportArchive')
    expect(source).not.toContain('importLocalDirectory:')
    expect(source).not.toContain('importOcrModel:')
    expect(source).not.toMatch(
      /importModelArchive:\s*\([^)]*(?:path|directory|archivePath)/u
    )
  })

  it('exposes explicit embedding settings operations without vectors or credentials', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    const embeddings =
      source.match(
        /embeddings: \{(?<body>[\s\S]*?)\r?\n {2}\},\r?\n {2}documentParsing:/u
      )?.groups?.body ?? ''
    expect(embeddings).toContain('getSnapshot:')
    expect(embeddings).toContain('getModelProgress:')
    expect(embeddings).toContain('diagnose: (connectionId: string)')
    expect(embeddings).toContain('setCurrent: (connectionId: string)')
    expect(embeddings).toContain('installModel:')
    expect(embeddings).toContain('cancelModelOperation:')
    expect(embeddings).toContain('removeModel:')
    expect(embeddings).not.toMatch(/\b(?:apiKey|credential|vector)\b/iu)
  })

  it('passes an explicit parsing scenario to document diagnostics', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain(
      'test: (purpose: DocumentParsingTestPurpose)'
    )
    expect(source).toMatch(
      /ipcChannels\.documentParsingTest,\r?\n {8}\{ purpose \}/u
    )
  })

  it('exposes a narrow OCR operation progress snapshot', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('getOcrModelProgress:')
    expect(source).toContain('ipcChannels.documentOcrModelsProgress')
  })

  it('exposes a removable attachment parsing progress listener', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('onFileSelectionProgress:')
    expect(source).toContain('contextFileSelectionProgress')
    expect(source).toContain('ipcRenderer.removeListener(')
  })

  it('exposes only bounded release-note actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('releaseNotes: {')
    expect(source).toContain('getPending:')
    expect(source).toContain('acknowledge: async (version: string)')
    expect(source).toContain('ipcChannels.releaseNotesGetPending')
    expect(source).toContain('ipcChannels.releaseNotesAcknowledge')
  })

  it('exposes only the narrow feedback submission method', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    const feedback =
      source.match(
        /feedback: \{(?<body>[\s\S]*?)\r?\n {2}\},\r?\n {2}shortcuts:/u
      )?.groups?.body ?? ''
    expect(feedback).toContain('submit: (input: FeedbackSubmitInput)')
    expect(feedback).toContain('ipcChannels.feedbackSubmit')
    expect(feedback).not.toMatch(
      /\b(?:url|endpoint|header|cookie|authorization|path)\b/iu
    )
  })

  it('exposes only get and validated-update shortcut settings methods', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('shortcuts: {')
    expect(source).toContain('ipcChannels.shortcutSettingsGet')
    expect(source).toContain('ipcChannels.shortcutSettingsUpdate')
    expect(source).not.toContain('globalShortcut.')
  })

  it('exposes only explicit SSH host-management methods', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('sshHosts: {')
    expect(source).toContain('getSnapshot:')
    expect(source).toContain('onAgentConnectionStatus:')
    expect(source).toContain(
      'ipcChannels.sshHostsAgentConnectionStatus'
    )
    expect(source).toContain(
      'getAgentPackageInventory: (refresh = false)'
    )
    expect(source).toContain('downloadAgentPackage:')
    expect(source).toContain('importAgentPackage:')
    expect(source).toContain('exportAgentPackage: async')
    expect(source).toContain('onAgentPackageProgress:')
    expect(source).toContain('inspectDraftHostKey:')
    expect(source).toContain('discardCandidate:')
    expect(source).toContain('validateAndSave:')
    expect(source).toContain(
      'browseDirectories: (hostId: string, path?: string)'
    )
    expect(source).toContain('cancelDirectoryBrowse: async ()')
    expect(source).toContain('getRemoteEnvironment: (hostId: string)')
    expect(source).toContain(
      'input: RemoteEnvironmentUpdateRequest'
    )
    expect(source).toContain(
      'cancelRemoteEnvironmentUpdate: async (hostId: string)'
    )
    expect(source).toContain(
      'onRemoteEnvironmentUpdateProgress:'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsRemoteEnvironment'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsAgentPackageInventory'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsAgentPackageDownload'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsAgentPackageImport'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsAgentPackageExport'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsAgentPackageProgress'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsUpdateRemoteEnvironment'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsCancelRemoteEnvironmentUpdate'
    )
    expect(source).toContain(
      'ipcChannels.sshHostsRemoteEnvironmentUpdateProgress'
    )
    expect(source).toContain('ipcChannels.sshHostsBrowseDirectories')
    expect(source).toContain(
      'ipcChannels.sshHostsCancelDirectoryBrowse'
    )
    expect(source).not.toContain('sshHostsCreate')
    expect(source).not.toContain('sshHostsAcceptKey')
    expect(source).not.toContain('privateKey:')
    expect(source).not.toContain('agentForward: true')
    const sshHostsSource =
      source.match(
        /sshHosts: \{(?<body>[\s\S]*?)\n {2}\},\n {2}channels:/u
      )
        ?.groups?.body ?? ''
    expect(sshHostsSource).not.toMatch(
      /\b(?:credential|password|revision|sftp|shell|command)\b/iu
    )
    expect(sshHostsSource).not.toMatch(
      /\b(?:detail|phaseName|installationId)\b/iu
    )
  })

  it('exposes only bounded terminal session operations', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    const terminal =
      source.match(
        /terminal: \{(?<body>[\s\S]*?)\r?\n {2}\},\r?\n {2}settings:/u
      )?.groups?.body ?? ''
    expect(terminal).toContain('create:')
    expect(terminal).toContain('write:')
    expect(terminal).toContain('resize:')
    expect(terminal).toContain('close:')
    expect(terminal).toContain('getSnapshot:')
    expect(terminal).toContain('ack:')
    expect(terminal).toContain('onEvent:')
    expect(terminal).toContain('ipcRenderer.removeListener(')
    expect(terminal).not.toMatch(
      /\b(?:shell|cwd|command|environment|password|privateKey|pid)\b/u
    )
  })

  it('exposes narrow awaited remote project activation and save operations', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('remote: {')
    expect(source).toContain('remoteProjectSave')
    expect(source).toContain('remoteProjectCancelCurrent')
    expect(source).toContain('remoteProjectSaveProgress')
    expect(source).toContain('RemoteProjectSaveRequest')
    expect(source).not.toContain('commitToken')
    expect(source).toContain('ipcRenderer.removeListener(')
  })

  it('exposes removable project recovery snapshot, retry, and progress APIs', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('getRecoverySnapshot:')
    expect(source).toContain('retryRecovery: (projectId: string)')
    expect(source).toContain('onRecoveryProgress:')
    expect(source).toContain('ipcChannels.remoteProjectRecoveryGet')
    expect(source).toContain('ipcChannels.remoteProjectRecoveryRetry')
    expect(source).toContain(
      'ipcChannels.remoteProjectRecoveryProgress'
    )
    expect(source).toMatch(
      /remoteProjectRecoveryProgress,[\s\S]*?removeListener\([\s\S]*?remoteProjectRecoveryProgress/u
    )
  })

  it('exposes bounded knowledge task actions', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('cancelTask: (taskId: string)')
    expect(source).toContain('retryTask: async (taskId: string)')
    expect(source).toContain('ipcChannels.knowledgeTaskCancel')
    expect(source).toContain('ipcChannels.knowledgeTaskRetry')
  })

  it('exposes only explicit Conversation queue operations and listeners', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain('conversationQueue: {')
    expect(source).toContain('ipcChannels.conversationQueueEnqueueUser')
    expect(source).toContain(
      'ipcChannels.conversationQueueInterruptAndRun'
    )
    expect(source).toContain('ipcChannels.conversationQueueDispatch')
    expect(source).toContain('listener(conversationId)')
  })

  it('exposes a narrow local conversation branch operation', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).toContain(
      'branchLocal: (input: ConversationBranchInput)'
    )
    expect(source).toContain('ipcChannels.conversationsBranchLocal')
  })
})
