import type { TranslationShape } from '../../resource-types'
import type { workspace as chineseWorkspace } from '../zh-CN/workspace'

export const workspace = {
  projectSwitcher: {
    workModes: {
      ask: 'Ask · Read-only',
      execute: 'Execute · Controlled'
    },
    selector: {
      ariaLabel: 'Current project',
      userProjects: 'Projects',
      channelProjects: 'Remote channels',
      create: 'New project',
      settings: 'Project settings'
    },
    dialog: {
      createTitle: 'New project',
      settingsTitle: 'Project settings',
      closeCreate: 'Close new project',
      closeSettings: 'Close project settings',
      fields: {
        name: 'Name',
        description: 'Description',
        rootPath: 'Root folder',
        defaultMode: 'Default mode',
        defaultRuntime: 'Default Runtime for new conversations'
      },
      runtimeOptions: {
        direct: 'Direct model'
      },
      defaultRuntimeHelp:
        'Applies only to new conversations in this project. Existing conversations are unchanged.',
      channelManaged: 'GoodBuddy manages channel project names.',
      selectRoot: 'Select project root folder',
      danger: {
        title: 'Danger zone',
        description:
          'Deleting this project permanently removes its conversations, tasks, schedules, heartbeats, memories, and results from GoodBuddy. It does not delete the project folder or files on disk.',
        delete: 'Delete project',
        confirmation: 'Enter “{{projectName}}” to confirm deletion',
        cancel: 'Cancel deletion',
        deleting: 'Deleting',
        permanentlyDelete: 'Permanently delete project',
        keepOne: 'At least one available project must remain.'
      },
      archive: 'Archive project',
      archiving: 'Archiving',
      cancel: 'Cancel',
      create: 'Create',
      creating: 'Creating',
      save: 'Save project',
      saving: 'Saving'
    },
    errors: {
      save: 'Could not save the project',
      create: 'Could not create the project',
      selectRoot: 'Could not select the project root folder',
      archive: 'Could not archive the project',
      delete: 'Could not delete the project'
    }
  },
  sidebar: {
    ariaLabel: 'Assistant workspace',
    resizeAriaLabel: 'Resize assistant workspace',
    resizeValue: '{{width}} pixels',
    title: 'Workspace',
    close: 'Close assistant workspace',
    categoriesAriaLabel: 'Workspace categories',
    tabs: {
      tasks: {
        label: 'Task center',
        description: 'Review approvals and manage automations'
      },
      context: {
        label: 'Context',
        description:
          'View attachments, knowledge libraries, and memories used in this conversation'
      },
      workspace: {
        label: 'Files',
        description: 'Browse project files, Git changes, and file contents'
      },
      browser: {
        label: 'Browser',
        description: 'View the live browser while the Agent works'
      },
      results: {
        label: 'Results',
        description: 'View generated or imported standalone results'
      }
    },
    tasks: {
      description:
        'Review pending approvals and create or manage automations.',
      createCustom: 'New custom task',
      approvalsTitle: 'Awaiting approval',
      noApprovals: 'There are no operations awaiting approval.',
      deny: 'Deny',
      allowOnce: 'Allow once',
      taskIndexTitle: 'Task index',
      empty: 'Explicitly created tasks will appear here.',
      noFilterResults: 'No tasks match this filter.',
      conversationUnavailable: 'Conversation unavailable',
      projectScope: 'Project: {{project}}',
      globalScope: 'Global',
      startedAt: 'Started {{time}}',
      nextRunAt: 'Next run: {{time}}',
      notStarted: 'Not run yet',
      filters: {
        ariaLabel: 'Filter tasks',
        attention: 'Attention',
        active: 'Active',
        paused: 'Paused',
        finished: 'Finished'
      },
      schedule: {
        recurrence: {
          once: 'Once',
          daily: 'Daily',
          weekly: 'Weekly'
        },
        runNow: 'Run now',
        delete: 'Delete schedule',
        cancelDelete: 'Cancel deleting the schedule',
        confirmDelete: 'Confirm deleting the schedule for “{{title}}”',
        confirmDeleteAction: 'Stop future runs',
        deleteMessage:
          'This stops future automatic runs but keeps the task, conversation, and existing results.'
      }
    },
    context: {
      description:
        'View the attachments, knowledge libraries, and confirmed memories used in this conversation.',
      attachmentsTitle: 'Attachments',
      noAttachments:
        'No files, screenshots, or clipboard content have been added.',
      attachmentDetails: '{{kind}} · {{formattedSize}} bytes',
      removeAttachment: 'Remove {{name}} from context',
      librariesTitle: 'Enabled knowledge libraries',
      noLibraries:
        'No knowledge libraries are enabled for this conversation.',
      documentCount: '{{formattedCount}} documents',
      memoriesTitle: 'Confirmed memories',
      noMemories:
        'There are no confirmed long-term memories in the current scope.'
    },
    workspace: {
      back: 'Back to workspace',
      title: 'Files',
      fileSize: '{{formattedSize}} bytes',
      fileFallback: 'Project workspace file',
      reading: 'Reading file…',
      description:
        'Browse the current project files and Git changes. Select a file to preview it here.',
      projectTitle: 'Project workspace',
      refreshAriaLabel: 'Refresh workspace files',
      refresh: 'Refresh',
      gitUnavailable: 'Git status unavailable: {{error}}',
      fullDiff: 'View complete Git diff',
      truncatedDiff: '\n\n[Output exceeded the safety limit and was truncated]'
    },
    results: {
      back: 'Back to results',
      title: 'Results',
      loadingImage: 'Loading image…',
      description:
        'View and preview text, images, PDFs, and web results generated by tasks or automations, or imported manually.',
      sectionTitle: 'Generated and imported results',
      import: 'Import PDF, image, or web page',
      empty:
        'Generated files, images, reports, and manually imported content will appear here.'
    },
    browser: {
      title: 'Live browser',
      interact: 'Interact',
      interacting: 'Interacting',
      stop: 'Stop browser',
      empty:
        'The live view will appear here after the Agent opens a web page.',
      statuses: {
        creating: 'Starting browser…',
        loading: 'Loading page…',
        acting: 'Agent is working on the page…',
        interactive: 'You are assisting on the page…',
        ready: 'Browser ready',
        failed: 'Browser operation failed',
        stopped: 'Browser stopped'
      },
      frameAlt: 'Live Agent browser view',
      noFrame: 'Could not capture the page',
      waitingFrame: 'Waiting for the first page frame…'
    },
    errors: {
      workspacePreview: 'Could not preview the workspace file',
      runSchedule: 'Could not run the scheduled task',
      deleteSchedule: 'Could not delete the scheduled task',
      updateSchedule: 'Could not update the scheduled task',
      refreshWorkspace: 'Could not refresh workspace files',
      importResult: 'Could not import results',
      loadResult: 'Could not load the result',
      interactBrowser: 'Could not open the browser interaction window',
      stopBrowser: 'Could not stop the browser'
    }
  },
  task: {
    status: {
      queued: 'Idle',
      idle: 'Idle',
      running: 'Running',
      waiting_approval: 'Awaiting approval',
      paused: 'Paused',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted'
    },
    mode: {
      ask: 'Ask',
      execute: 'Execute',
      unavailable: 'Mode unavailable'
    },
    fields: {
      mode: 'Mode',
      schedule: 'Schedule',
      nextRun: 'Next run',
      outcome: 'Latest result'
    },
    schedule: {
      none: 'No schedule'
    },
    actions: {
      pause: 'Pause',
      resume: 'Resume'
    },
    notAvailable: 'Unavailable',
    completedAt: 'Completed {{time}}',
    noOutcome: 'No run result yet'
  },
  taskStrip: {
    ariaLabel: 'Tasks in this conversation',
    title: 'Conversation tasks',
    count: '{{count}}',
    create: 'New task',
    empty: 'This conversation has no tasks yet.',
    taskList: 'Task list'
  },
  files: {
    statuses: {
      added: 'Added',
      deleted: 'Deleted',
      renamed: 'Renamed',
      modified: 'Modified'
    },
    errors: {
      read: 'Could not read workspace files',
      openFolder: 'Could not open the folder',
      openFile: 'Could not open the file'
    },
    openFolderAriaLabel: 'Open folder {{name}} in the system file manager',
    openFolder: 'Open folder',
    openFileAriaLabel: 'Open file {{name}} with the default app',
    openFile: 'Open file',
    reading: 'Reading…',
    directoryTruncated:
      'This folder has more than 500 items. Only the first 500 are shown.',
    selectProject: 'Select a project to browse its workspace.',
    changedTitle: 'Uncommitted changes',
    changesTruncated: 'Only the first 50 uncommitted changes are shown.',
    currentWorkspace: 'Current workspace',
    readingWorkspace: 'Reading workspace…',
    rootTruncated:
      'The root folder has more than 500 items. Only the first 500 are shown.',
    empty: 'The workspace is empty.'
  },
  question: {
    title: 'OpenCode needs more information',
    otherAnswer: 'Other answer',
    answerPlaceholder: 'Enter your answer',
    skip: 'Skip',
    submitting: 'Submitting…',
    submit: 'Submit answers',
    error: 'Could not submit answers. Try again.'
  },
  primitives: {
    scope: {
      global: 'Global',
      allProjects: 'All projects',
      project: 'Project: {{projectName}}',
      mixedProject: 'Project: {{projectName}} + Global',
      mixedCurrent: 'Current project + Global',
      unavailable: 'Scope unavailable'
    },
    destructive: {
      defaultMessage: 'Confirm {{triggerLabel}}.',
      cancel: 'Cancel'
    }
  }
} satisfies TranslationShape<typeof chineseWorkspace>
