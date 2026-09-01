import type { TranslationShape } from '../../resource-types'
import type { heartbeat as chineseHeartbeat } from '../zh-CN/heartbeat'

export const heartbeat = {
  common: {
    operationFailed: 'Smart Heartbeat operation failed',
    unavailable: 'Not available',
    unknownTime: 'Unknown time'
  },
  center: {
    title: 'Smart Heartbeat',
    description:
      'Runs scheduled, read-only reviews of the selected scope without using tools.',
    scope: {
      currentProject: 'Current project',
      global: 'Global'
    },
    actions: {
      refreshAriaLabel: 'Refresh Smart Heartbeat',
      refresh: 'Refresh',
      running: 'Running heartbeat…',
      runOnce: 'Run heartbeat now',
      configure: 'Configure Smart Heartbeat',
      retry: 'Retry'
    },
    loading: {
      description: 'Loading heartbeat plans, runs, and reports.',
      title: 'Loading Smart Heartbeat',
      failedTitle: 'Could not load Smart Heartbeat',
      refreshFailedTitle: 'Could not refresh Smart Heartbeat'
    },
    tabs: {
      ariaLabel: 'Smart Heartbeat views',
      overview: 'Run overview',
      suggestions: 'Pending suggestions',
      history: 'Reports and runs',
      plans: 'Heartbeat plans'
    },
    currentStatus: {
      title: 'Current status',
      activePlans: 'Active plans: {{formattedCount}}',
      disabled: 'Not enabled',
      emptyTitle: 'No heartbeat plan',
      emptyDescription:
        'Create a daily or weekly plan to review conversations and tasks in the selected scope and generate suggestions.',
      createPlan: 'Create heartbeat plan'
    },
    recurrence: {
      daily: 'Every day at {{time}}',
      weekly: '{{weekday}} at {{time}}'
    },
    weekdays: {
      sunday: 'Sunday',
      monday: 'Monday',
      tuesday: 'Tuesday',
      wednesday: 'Wednesday',
      thursday: 'Thursday',
      friday: 'Friday',
      saturday: 'Saturday'
    },
    config: {
      nextHeartbeat: 'Next heartbeat',
      lastStatus: 'Last status',
      neverRun: 'Never run',
      runNow: 'Run now',
      pause: 'Pause',
      resume: 'Resume'
    },
    metrics: {
      ariaLabel: 'Smart Heartbeat run metrics',
      health: 'Heartbeat health',
      successfulRuns: '{{completed}}/{{total}} completed successfully',
      healthRateAriaLabel: 'Heartbeat success rate {{percent}}',
      memory: 'Memory confirmation',
      memoryDescription: 'Confirmed memories / heartbeat suggestions',
      memoryRateAriaLabel: 'Memory confirmation rate {{percent}}',
      insights: 'Report insights',
      insightReports: 'Heartbeat reports: {{formattedCount}}',
      latestInsights: 'Latest report findings: {{formattedCount}}',
      awaitingFirstRun: 'Waiting for the first heartbeat',
      action: 'Action conversion',
      actionDescription: 'Completed tasks / heartbeat suggestions',
      actionRateAriaLabel: 'Suggested task completion rate {{percent}}'
    },
    trend: {
      title: 'Report trend',
      empty:
        'After a heartbeat runs, this chart shows changes in insight, memory, and action suggestion counts.',
      insight: 'Insights',
      memory: 'Memories',
      action: 'Actions',
      rowAriaLabel:
        '{{date}}: {{insights}} insights, {{memories}} memory suggestions, and {{actions}} action suggestions'
    },
    latest: {
      title: 'Latest heartbeat',
      viewHistory: 'View reports and runs',
      handleSuggestions: 'Review suggestions ({{formattedCount}})',
      empty:
        'There are no heartbeat reports yet. Run one to view insight, memory, and action suggestions.'
    },
    suggestions: {
      memoryTitle: 'Memories to confirm',
      memoryCount: 'Items: {{formattedCount}}',
      memoryEmpty: 'There are no memory suggestions to confirm.',
      confidenceAndSalience:
        'Confidence {{confidence}} · Importance {{salience}}',
      collapseContent: 'Show less',
      expandContent: 'View full content',
      confirmMemory: 'Confirm memory',
      ignore: 'Ignore',
      taskTitle: 'Suggested actions',
      taskCount: 'Items: {{formattedCount}}',
      taskEmpty: 'Smart Heartbeat has not suggested any actions.',
      useInConversation: 'Handle in conversation',
      markCompleted: 'Mark completed',
      ignoreSuggestion: 'Ignore suggestion'
    },
    history: {
      timelineTitle: 'Heartbeat reports',
      reportCount: 'Reports: {{formattedCount}}',
      emptyTimeline:
        'Reports from completed heartbeat runs appear here.',
      reportSummary:
        '{{insights}} insights · {{memories}} memories · {{actions}} actions',
      collapseReport: 'Collapse report',
      expandReport: 'Expand full report',
      loadMoreReports: 'Load more heartbeat reports',
      auditTitle: 'Run history',
      runCount: 'Runs: {{formattedCount}}',
      emptyRuns: 'There are no Smart Heartbeat runs yet.',
      manualRun: 'Manual run',
      scheduledRun: 'Scheduled run',
      attempt: 'Attempt {{formattedCount}}',
      loadMoreRuns: 'Load more runs'
    }
  },
  statuses: {
    run: {
      claimed: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      skipped: 'Skipped'
    },
    task: {
      queued: 'Queued',
      idle: 'Idle',
      running: 'Running',
      waitingApproval: 'Waiting for approval',
      paused: 'Pending',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Ignored',
      interrupted: 'Interrupted'
    },
    memory: {
      preference: 'Preference',
      fact: 'Fact',
      summary: 'Summary',
      procedure: 'Procedure'
    }
  },
  settings: {
    title: 'Smart Heartbeat',
    description:
      'Heartbeat plans run on schedule in read-only mode without tools.',
    recurrenceAriaLabel: 'Heartbeat recurrence',
    recurrenceLabel: 'Recurrence',
    daily: 'Daily',
    weekly: 'Weekly',
    weekdayAriaLabel: 'Heartbeat weekday',
    weekdayLabel: 'Weekday',
    timeAriaLabel: 'Heartbeat time',
    timeLabel: 'Time',
    nameLabel: 'Plan name',
    createTitle: 'Create heartbeat plan',
    editTitle: 'Edit heartbeat plan',
    cancelEdit: 'Cancel editing',
    editAriaLabel: 'Edit {{name}}',
    edit: 'Edit',
    saveAriaLabel: 'Save heartbeat plan',
    save: 'Save changes',
    lookbackLabel: 'Review window (hours)',
    lookbackAriaLabel: 'Heartbeat review window in hours',
    retentionLabel: 'History retention (days)',
    retentionAriaLabel: 'Heartbeat history retention in days',
    scope: {
      legend: 'Review scope',
      ariaLabel: 'Choose heartbeat review scope',
      global: 'Global',
      projects: 'Selected projects',
      globalHelp:
        'Review bounded conversations and tasks across all available projects, using Global memories.',
      projectsHelp:
        'Review the selected projects together in one run, using Global and selected-project memories.',
      noProjects: 'There are no projects available to select.',
      archived: 'Archived',
      removeArchived:
        'Remove archived or unavailable projects before saving.',
      unavailableProject: 'Unavailable project',
      selectedProjectsSummary: '{{count}} projects: {{names}}',
      nameSeparator: ', '
    },
    enableAriaLabel: 'Enable Smart Heartbeat',
    enabling: 'Enabling…',
    enable: 'Enable Smart Heartbeat',
    defaultName: 'Scheduled review',
    empty: 'Smart Heartbeat is not configured for this scope.',
    running: 'Running',
    paused: 'Paused',
    next: 'Next: {{date}}',
    last: 'Last: {{status}}',
    pauseAriaLabel: 'Pause {{name}}',
    resumeAriaLabel: 'Resume {{name}}',
    pause: 'Pause',
    resume: 'Resume',
    runNowAriaLabel: 'Run heartbeat now for {{name}}',
    runNow: 'Run now',
    cancelDeleteAriaLabel: 'Cancel deleting {{name}}',
    confirmDeleteAriaLabel: 'Confirm deleting {{name}}',
    confirmDelete: 'Delete plan',
    deleteMessage:
      'This permanently deletes the plan, its run history, and related results. It cannot be undone.',
    deleteAriaLabel: 'Delete {{name}}',
    delete: 'Delete'
  }
} satisfies TranslationShape<typeof chineseHeartbeat>
