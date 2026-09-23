import type { TranslationShape } from '../../resource-types'
import type { heartbeat as chineseHeartbeat } from '../zh-CN/heartbeat'

export const heartbeat = {
  common: {
    operationFailed: 'Supervisor operation failed',
    unavailable: 'Not available',
    unknownTime: 'Unknown time'
  },
  supervisor: {
    projectScope: 'Project: {{names}}',
    canvasTitle: 'How the work took shape', canvasNote: 'Read counter-clockwise · Select a node to explore knowledge and sources', readingGuide: 'Reading the graph',
    visibleCounts: '{{events}} events / {{entities}} entities on canvas', showAll: 'Show all connections', connections: 'Graph connections',
    loadingHint: 'Reading saved reviews, events, and sources.', unavailableHint: 'Reopen the application to try again. Saved reviews remain on this device.',
    selection: 'Graph selection', canvas: 'Story graph canvas', inspector: 'Details and sources',
    counts: '{{events}} events · {{entities}} entities', canvasCaption: 'Events are evenly spaced in time order, not by elapsed time. Each batch shows up to 8 events and 6 entities; select from the list to switch batches and read full names. Scroll the canvas horizontally on narrow screens. Browsing events does not restore historical entity state.',
    legendLabel: 'Graph legend', eventImpact: 'Event impact', playback: 'Browse events', previousStage: 'Previous event', nextStage: 'Next event',
    navigation: 'Supervisor views', recap: 'Work review', graph: 'Story graph', settings: 'Settings',
    viewInGraph: 'View in graph',
    unavailable: 'Supervisor service is unavailable', loading: 'Loading Supervisor review', scope: 'Review scope', period: 'Time range', days: '{{count}} days',
    sourcesHint: 'A review reads only sources in its explicit scope and time range; automatic wake-up does not change manual review scope.', latest: 'Latest successful review', openItems: 'Open items', history: 'Review history',
    empty: 'No successful review yet', emptyHint: 'You can review current progress manually even without an automatic wake-up plan.', run: 'Review current progress', running: 'Reviewing…', retryRun: 'Retry review', dismiss: 'Dismiss',
    graphScope: 'Graph scope', graphEmpty: 'No story events in this scope', legend: 'Solid lines show event impact on entities; dashed lines show entity relations. Time runs counter-clockwise with a visible gap.', start: 'Start', end: 'End',
    events: 'Time events', entities: 'Knowledge entities', relations: 'Entity relations', eventSources: 'Event sources', sources: 'Related sources', noSources: 'No related sources are available.', selectHint: 'Select an event, entity, or relation to inspect it.', sourceSnapshot: 'Source details', sourceMissing: 'Source not found',
    confirm: 'Confirm', revise: 'Revise', remove: 'Remove relation', label: 'Entity name', save: 'Save revision', cancel: 'Cancel', removeHint: 'This changes graph organization only; the original source remains available.',
    relationTypes: { supports: 'Supports', 'depends-on': 'Depends on', contrasts: 'Contrasts', related: 'Related' },
    states: { automatic: 'Automatic · needs review', confirmed: 'Confirmed by user', revised: 'Revised by user', revoked: 'Removed' }
  },
  center: {
    title: 'Supervisor',
    description:
      'Reviews work progress and knowledge evolution. Smart Heartbeat wakes Supervisor on a schedule.',
    scope: {
      currentProject: 'Current project',
      global: 'Global'
    },
    actions: {
      refreshAriaLabel: 'Refresh Supervisor',
      refresh: 'Refresh',
      running: 'Waking Supervisor…',
      runOnce: 'Review now',
      configure: 'Configure automatic wake-up',
      retry: 'Retry'
    },
    loading: {
      description: 'Loading heartbeat plans, runs, and reports.',
      title: 'Loading Supervisor',
      failedTitle: 'Could not load Supervisor',
      refreshFailedTitle: 'Could not refresh Supervisor'
    },
    tabs: {
      ariaLabel: 'Supervisor automatic wake-up views',
      overview: 'Wake-up overview',
      suggestions: 'Pending suggestions',
      history: 'Reports and runs',
      plans: 'Automatic wake-up settings'
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
      ariaLabel: 'Automatic wake-up run metrics',
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
      taskEmpty: 'Automatic wake-up has not suggested any actions.',
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
      emptyRuns: 'There are no automatic wake-up runs yet.',
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
    title: 'Automatic wake-up',
    description:
      'Automatic wake-ups run on schedule in read-only mode without tools.',
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
    saveAriaLabel: 'Save automatic wake-up plan',
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
    enableAriaLabel: 'Enable automatic wake-up',
    enabling: 'Enabling…',
    enable: 'Enable automatic wake-up',
    defaultName: 'Scheduled review',
    empty: 'Automatic wake-up is not configured for this scope.',
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
