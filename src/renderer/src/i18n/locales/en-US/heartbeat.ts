import type { TranslationShape } from '../../resource-types'
import type { heartbeat as chineseHeartbeat } from '../zh-CN/heartbeat'

export const heartbeat = {
  reviewSettings: {
    title: 'Review algorithm',
    responseKiB: 'Response capacity, KiB (default 1024)',
    save: 'Save review algorithm',
    help: 'Page size controls database reads, not total coverage. Batch limits split work without dropping remaining text. These settings and the organize timeout are frozen for each new review; continuing uses its saved configuration. Response capacity uses the current setting for each request; increase it before continuing a failed review.',
    pageSize: 'Sources read at a time (default 50)', batchCharacters: 'Text size per batch (default 8000)',
    batchMessages: 'Messages per batch (default 20)', executionSeconds: 'Time before pausing, seconds (default 300)',
    pauseHelp: 'When the execution soft budget is reached, active batches finish and save before pausing. Continue from Activity records.',
    invalid: 'Enter whole numbers within the displayed ranges.',
    pause: 'Pause review', resume: 'Continue saved review', facts: 'Retained facts and sources',
    pausedHint: 'Review is incomplete. Successful batches are saved. Open Activity to inspect progress and continue.',
    restartRequired: 'A frozen source changed or was removed. Saved facts remain available. Start a new review from Work review; the next automatic check will also use a new run.',
    factsHelp: 'Use summaries to navigate, then expand saved batches for detailed records and source text. Check the model\'s findings against the sources.',
    revision: 'Source revision', sources: 'All covered source fragments',
    previousPage: 'Previous page', nextPage: 'Next page',
    extracting: 'Reviewing source batches', summarizing: 'Building navigation summaries', inFlight: '{{count}} queued or running model tasks',
    configuration: 'Saved review configuration',
    configurationValues: 'Read {{pageSize}} sources at a time; batch size {{batchCharacters}}, up to {{batchMessages}} messages; pause after {{executionSeconds}}s; model timeout {{timeoutSeconds}}s; up to {{concurrency}} simultaneous tasks. Tasks also share the current supervision concurrency limit.',
    progress: '{{batches}} saved batches · {{characters}} characters reviewed · {{remaining}} sources remaining',
    identityError: 'The model returned an invalid entity reference. This batch was not saved; previously saved batches remain available.',
    runError: 'This run failed. Review the error details before continuing; saved batches remain available.',
    diagnostics: 'Error details'
  },
  timeouts: {
    title: 'Model timeouts and concurrency',
    report: 'Heartbeat report timeout (seconds)',
    organize: 'Supervisor organize timeout (seconds)',
    help: 'Each model timeout defaults to 240 seconds, adjustable from 30 to 600. Reports freeze the timeout when requested. Reviews save the organize timeout at creation and retain it when continued.',
    transport: 'These limits cover model execution only, not collection or saving. Direct model transport has an independent 600-second timeout; these settings do not extend it. Provider or Runtime limits may stop a request earlier.',
    concurrency: 'Supervision model concurrency',
    concurrencyHelp: 'Heartbeat reports and supervisor organizing share this limit: 1 by default, adjustable from 1 to 4. Queue time does not count toward model timeouts. Lowering the limit affects new dispatches without interrupting active requests. This limits supervision only; ordinary chat is unaffected but still shares upstream model capacity.',
    invalid: 'Enter whole numbers from 30 to 600 for each timeout and from 1 to 4 for concurrency.',
    save: 'Save model settings'
  },
  activity: {
    stages: 'Review stages',
    phases: { collecting: 'Collect sources', extracting: 'Review batches', summarizing: 'Merge summaries', saving: 'Publish review' },
    stageStates: { completed: 'Complete', running: 'In progress', failed: 'Failed', paused: 'Paused', pending: 'Not started', unknown: 'Not recorded', skipped: 'Not needed', no_change: 'No changes' },
    stageUnknown: 'This historical run has no saved stage. Zero remaining sources does not mean the review was published.',
    navigationSaved: '{{count}} navigation merges saved',
    resumeMerge: 'Continue merging', resumeSave: 'Retry publication', runDetails: 'Run details and configuration',
    treePageHint: 'Expand projects and conversations to browse this page of saved batches. Tasks without a saved result are not listed here.',
    noSavedBatches: 'No batches saved yet.', unassigned: 'No project', projectSources: 'Project sources',
    pageBatches: '{{count}} batches on this page', batchSaved: 'Saved',
    refreshOverview: 'Refresh run overview',
    planFilter: 'Supervision plan',
    allPlans: 'All plans and manual reviews',
    unavailablePlan: 'Unavailable plan',
    clearFilter: 'Clear filter',
    filteredEmpty: 'No executions for this plan',
    filteredEmptyHint: 'Run the plan from Automatic supervision, or clear the filter to view other activity.',
    title: 'Activity records', description: 'Saved manual reviews and automatic supervision runs. Updates while this tab is open.',
    loading: 'Loading activity', loadingHint: 'Reading saved execution records.', empty: 'No activity recorded', emptyHint: 'Run a manual review or create a plan in Automatic supervision.',
    kind: { supervision: 'Work review', heartbeat: 'Automatic supervision' },
    status: { running: 'Running', completed: 'Completed', failed: 'Failed', skipped: 'Skipped', no_change: 'No changes (no model call)', paused: 'Incomplete, ready to continue' },
    triggers: { manual: 'User', scheduled: 'Schedule', heartbeat: 'Heartbeat' },
    trigger: 'Triggered by', started: 'Started', finished: 'Finished', unknownScope: 'Execution scope not recorded',
    heartbeatStage: 'Heartbeat report', supervisionStage: 'Supervision review', notRecorded: 'No recorded execution',
    openReview: 'Open review', pagination: 'Activity pages', previous: 'Newer', next: 'Older', page: 'Page {{page}}'
  },
  common: {
    operationFailed: 'Supervisor operation failed',
    unavailable: 'Not available',
    unknownTime: 'Unknown time'
  },
  supervisor: {
    automatic: 'Automatic supervision',
    projectScope: 'Project: {{names}}',
    canvasTitle: 'How the work took shape', canvasNote: 'Read counter-clockwise · Select a node to explore knowledge and sources', readingGuide: 'Reading the graph',
    visibleCounts: '{{events}} events / {{entities}} entities on canvas', showAll: 'Show all connections', connections: 'Graph connections',
    loadingHint: 'Reading saved reviews, events, and sources.', unavailableHint: 'Reopen the application to try again. Saved reviews remain on this device.',
    selection: 'Graph selection', canvas: 'Story graph canvas', inspector: 'Details and sources',
    counts: '{{events}} events · {{entities}} entities', canvasCaption: 'Events are evenly spaced in time order, not by elapsed time. Each batch shows up to 8 events and 6 entities; select from the list to switch batches and read full names. Scroll the canvas horizontally on narrow screens. Entity states reflect the selected review result.',
    legendLabel: 'Graph legend', eventImpact: 'Event impact', playback: 'Browse events', previousStage: 'Previous event', nextStage: 'Next event',
    navigation: 'Supervisor views', recap: 'Work review', graph: 'Story graph', settings: 'Settings',
    viewInGraph: 'View in graph',
    unavailable: 'Supervisor service is unavailable', loading: 'Loading Supervisor review', scope: 'Review scope', period: 'Time range', days: '{{count}} days',
    sourcesHint: 'Choose a scope and period for a new review. The selected result and its covered period appear below.', latest: 'Supervision result', openItems: 'Open items', history: 'Review history',
    newReview: 'New review', summary: 'Work summary', changes: 'Changes', runningHint: 'A new review is running. The existing result remains available to read.',
    empty: 'No successful review yet', emptyHint: 'You can review current progress manually even without an automatic supervision plan.', run: 'Review current progress', running: 'Reviewing…', retryRun: 'Retry review', dismiss: 'Dismiss',
    graphScope: 'Graph scope', graphEmpty: 'No story events in this scope', legend: 'Solid lines show event impact on entities; dashed lines show entity relations. Time runs counter-clockwise with a visible gap.', start: 'Start', end: 'End',
    events: 'Time events', entities: 'Knowledge entities', relations: 'Entity relations', eventSources: 'Event sources', sources: 'Related sources', noSources: 'No related sources are available.', selectHint: 'Select an event, entity, or relation to inspect it.', sourceSnapshot: 'Source details', sourceMissing: 'Source not found',
    confirm: 'Confirm', revise: 'Revise', remove: 'Remove relation', label: 'Entity name', save: 'Save revision', cancel: 'Cancel', removeHint: 'This changes graph organization only; the original source remains available.',
    relationTypes: { supports: 'Supports', 'depends-on': 'Depends on', contrasts: 'Contrasts', related: 'Related' },
    states: { automatic: 'Automatic · needs review', confirmed: 'Confirmed by user', revised: 'Revised by user', revoked: 'Removed' }
  },
  center: {
    title: 'Supervisor',
    description:
      'Review work progress and knowledge evolution manually or configure automatic supervision.',
    scope: {
      currentProject: 'Current project',
      global: 'Global'
    },
    actions: {
      refreshAriaLabel: 'Refresh Supervisor',
      refresh: 'Refresh',
      running: 'Reviewing…',
      runOnce: 'Review now',
      configure: 'Configure automatic supervision',
      retry: 'Retry'
    },
    loading: {
      description: 'Loading automatic supervision plans, runs, and reports.',
      title: 'Loading Supervisor',
      failedTitle: 'Could not load Supervisor',
      refreshFailedTitle: 'Could not refresh Supervisor'
    },
    tabs: {
      ariaLabel: 'Automatic supervision settings and history',
      overview: 'Run overview',
      suggestions: 'Pending suggestions',
      history: 'Automatic reports and suggestions',
      plans: 'Automatic supervision'
    },
    currentStatus: {
      title: 'Current status',
      activePlans: 'Active plans: {{formattedCount}}',
      disabled: 'Not enabled',
      emptyTitle: 'Automatic supervision is not configured. Only manual reviews are available.',
      emptyDescription:
        'Create a daily or weekly plan to review conversations and tasks in the selected scope and generate suggestions.',
      createPlan: 'Create automatic supervision plan'
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
      nextHeartbeat: 'Next review',
      lastStatus: 'Last status',
      neverRun: 'Never run',
      runNow: 'Run now',
      pause: 'Pause',
      resume: 'Resume'
    },
    metrics: {
      ariaLabel: 'Automatic supervision run metrics',
      health: 'Run success rate',
      successfulRuns: '{{completed}}/{{total}} completed successfully',
      healthRateAriaLabel: 'Review success rate {{percent}}',
      memory: 'Memory confirmation',
      memoryDescription: 'Confirmed memories / supervision suggestions',
      memoryRateAriaLabel: 'Memory confirmation rate {{percent}}',
      insights: 'Report insights',
      insightReports: 'Review reports: {{formattedCount}}',
      latestInsights: 'Latest report findings: {{formattedCount}}',
      awaitingFirstRun: 'Waiting for the first review',
      action: 'Action conversion',
      actionDescription: 'Completed tasks / supervision suggestions',
      actionRateAriaLabel: 'Suggested task completion rate {{percent}}'
    },
    trend: {
      title: 'Report trend',
      empty:
        'After a review runs, this chart shows changes in insight, memory, and action suggestion counts.',
      insight: 'Insights',
      memory: 'Memories',
      action: 'Actions',
      rowAriaLabel:
        '{{date}}: {{insights}} insights, {{memories}} memory suggestions, and {{actions}} action suggestions'
    },
    latest: {
      title: 'Latest review',
      viewHistory: 'View report history',
      handleSuggestions: 'Review suggestions ({{formattedCount}})',
      empty:
        'There are no review reports yet. Run one to view insight, memory, and action suggestions.'
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
      taskEmpty: 'Automatic supervision has not suggested any actions.',
      useInConversation: 'Handle in conversation',
      markCompleted: 'Mark completed',
      ignoreSuggestion: 'Ignore suggestion'
    },
    history: {
      timelineTitle: 'Automatic supervision reports',
      reportCount: 'Reports: {{formattedCount}}',
      emptyTimeline:
        'No automatic supervision reports yet. Reports appear here after a plan runs.',
      reportSummary:
        '{{insights}} insights · {{memories}} memories · {{actions}} actions',
      collapseReport: 'Collapse report',
      expandReport: 'Expand full report',
      loadMoreReports: 'Load more review reports',
      auditTitle: 'Run history',
      runCount: 'Runs: {{formattedCount}}',
      emptyRuns: 'There are no automatic supervision runs yet.',
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
      skipped: 'Skipped',
      no_change: 'No changes (no model call)'
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
    refreshPlans: 'Refresh automatic supervision',
    refreshReports: 'Refresh reports and suggestions',
    executionHistory: 'Execution history',
    discardTitle: 'Discard unsaved plan changes?',
    discardHint: 'Closing will lose your unsaved changes.',
    keepEditing: 'Keep editing',
    discard: 'Discard changes',
    title: 'Automatic supervision',
    description:
      'Review the selected scope on schedule in read-only mode without tools. You confirm and handle suggestions.',
    scheduleHelp: 'Choose a daily or weekly review time, then save and enable the plan to run automatically.',
    timezone: 'Plan time zone: {{timezone}}. New plans use this device\'s time zone; edits keep the saved time zone.',
    windowSummary: 'Review the last {{hours}} hours · Keep run history for {{days}} days',
    allPaused: 'All automatic supervision plans are paused. Only manual reviews are available.',
    recurrenceAriaLabel: 'Supervision frequency',
    recurrenceLabel: 'Frequency',
    daily: 'Daily',
    weekly: 'Weekly',
    weekdayAriaLabel: 'Supervision weekday',
    weekdayLabel: 'Weekday',
    timeAriaLabel: 'Supervision time',
    timeLabel: 'Time',
    nameLabel: 'Plan name',
    createTitle: 'Create automatic supervision plan',
    close: 'Close automatic supervision plan',
    editTitle: 'Edit automatic supervision plan',
    cancelEdit: 'Cancel editing',
    editAriaLabel: 'Edit {{name}}',
    edit: 'Edit',
    saveAriaLabel: 'Save automatic supervision plan',
    save: 'Save changes',
    lookbackLabel: 'Review window (hours)',
    lookbackAriaLabel: 'Review window (hours)',
    retentionLabel: 'History retention (days)',
    retentionAriaLabel: 'History retention (days)',
    scope: {
      legend: 'Project scope',
      ariaLabel: 'Choose automatic supervision project scope',
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
    enableAriaLabel: 'Save and enable plan',
    enabling: 'Saving…',
    enable: 'Save and enable plan',
    defaultName: 'Scheduled review',
    empty: 'Automatic supervision is not configured. Only manual reviews are available.',
    running: 'Enabled',
    paused: 'Paused',
    next: 'Next: {{date}}',
    last: 'Last: {{status}}',
    pauseAriaLabel: 'Pause {{name}}',
    resumeAriaLabel: 'Resume {{name}}',
    pause: 'Pause',
    resume: 'Resume',
    runNowAriaLabel: 'Run now for {{name}}',
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
