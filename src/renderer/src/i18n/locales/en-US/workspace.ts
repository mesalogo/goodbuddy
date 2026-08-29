import type { TranslationShape } from '../../resource-types'
import type { workspace as chineseWorkspace } from '../zh-CN/workspace'

export const workspace = {
  builtInDefaultProject: {
    name: 'Default project',
    description: 'GoodBuddy default workspace'
  },
  projectSwitcher: {
    workModes: {
      ask: 'Ask · Read-only',
      execute: 'Execute · Full access'
    },
    selector: {
      ariaLabel: 'Current project',
      userProjects: 'Local projects',
      remoteProjects: 'Remote projects',
      channelProjects: 'Remote channels',
      empty: 'No project selected',
      localDetail: 'Local folder · {{path}}',
      managedSshDetail: 'Managed SSH · {{path}}',
      remoteDetail: '{{channel}} · Remote channel · {{path}}',
      remoteChannel: 'Remote channel',
      create: 'New project',
      settings: 'Project settings',
      settingsNamed: 'Manage project {{name}}'
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
        executionSpace: 'Execution space',
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
    },
    remote: {
      executionSpaces: {
        local: 'Local',
        ssh: 'Managed SSH'
      },
      executionSpaceFixed:
        'Existing projects cannot switch directly between local and managed SSH execution.',
      fields: {
        host: 'SSH host',
        root: 'Remote work directory'
      },
      loadingHosts: 'Loading saved hosts…',
      noHosts: 'No saved SSH hosts',
      hostHelp:
        'Host credentials remain centrally managed in Settings and are not copied into the project.',
      readiness: {
        loading: 'Reading the Host validation record…',
        ready:
          'This Host is validated. Saving connects and checks the Agent, workspace, and Runtime.',
        unready:
          'This Host has not completed Host Key and connection validation. Validate it under Settings > SSH Hosts first.',
        error:
          'Could not read this Host’s local validation record. Check it under Settings > SSH Hosts.',
        saveBlocked:
          'The selected Host has not been validated. Validate its connection under Settings > SSH Hosts first.',
        options: {
          loading: 'Reading',
          ready: 'Validated',
          unready: 'Validation required',
          error: 'Record unavailable'
        }
      },
      rootHelp:
        'Enter or choose a canonical absolute path beginning with /.',
      directoryPicker: {
        browse: 'Browse remote work directory',
        title: 'Select remote work directory',
        close: 'Close remote directory picker',
        currentPath: 'Current directory',
        parent: 'Go to parent directory',
        refresh: 'Refresh current directory',
        directory: 'Open directory {{name}}',
        loading: 'Loading remote directories…',
        empty: 'This directory has no subdirectories.',
        loadError: 'Could not load remote directories: {{message}}',
        unknownError: 'Check the SSH host connection and try again.',
        cancel: 'Cancel',
        select: 'Select this directory'
      },
      runtimeHelp:
        'Managed SSH projects use OpenCode Runtime only. Ask is read-only; Execute can use every permission available to the selected SSH account. Saving checks the Host, Agent, workspace, and Runtime.',
      actions: {
        save: 'Save remote project',
        saving: 'Saving remote project…'
      },
      progress: {
        progressLabel: 'Remote project save progress',
        stepsLabel: 'Remote project save stages'
      },
      phaseStatus: 'Current phase: {{phase}}',
      phases: {
        host: 'SSH host',
        agent: 'Remote Agent',
        workspace: 'Remote workspace',
        runtime: 'OpenCode Runtime',
        saving: 'Project settings'
      },
      validation: {
        host: 'Select a saved SSH host.',
        root:
          'The remote work directory must be an absolute path beginning with /.'
      },
      errors: {
        hostsUnavailable: 'The SSH host service is unavailable.',
        loadHosts: 'Could not load SSH hosts.',
        save: 'Could not save the remote project.'
      }
    }
  },
  sidebar: {
    ariaLabel: 'Assistant workspace',
    resizeAriaLabel: 'Resize assistant workspace',
    resizeValue: '{{width}} pixels',
    categoriesAriaLabel: 'Workspace categories',
    tabs: {
      tasks: {
        label: 'Task center',
        description: 'Review approvals and manage automations'
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
    workspace: {
      back: 'Back to workspace',
      title: 'Files',
      projectTitle: 'Project workspace',
      fileSize: '{{formattedSize}} bytes',
      fileFallback: 'Project workspace file',
      reading: 'Reading file…',
      refreshAriaLabel: 'Refresh workspace files',
      refresh: 'Refresh',
      gitUnavailable: 'Git status unavailable: {{error}}',
      fullDiff: 'View complete Git diff',
      truncatedDiff: '\n\n[Output exceeded the safety limit and was truncated]'
    },
    results: {
      back: 'Back to results',
      title: 'Results',
      sectionTitle: 'Generated and imported results',
      loadingImage: 'Loading image…',
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
      projects: '{{count}} projects',
      mixedProject: 'Project: {{projectName}} + Global',
      mixedCurrent: 'Projects + Global',
      unavailable: 'Scope unavailable'
    },
    destructive: {
      defaultMessage: 'Confirm {{triggerLabel}}.',
      cancel: 'Cancel'
    }
  }
} satisfies TranslationShape<typeof chineseWorkspace>
