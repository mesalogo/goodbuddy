import type { TranslationShape } from '../../resource-types'
import type { heartbeat as chineseHeartbeat } from '../zh-CN/heartbeat'

export const heartbeat = {
  reviewSettings: {
    title: 'Review algorithm',
    responseKiB: 'Response capacity, KiB (default 1024)',
    storyThreadEvents: 'Minimum events before a feature splits into sub-threads (default 20)',
    experienceMinEvents: 'Minimum events before a story is considered for experiences (default 5)',
    stalledDays: 'Days without new events before a story is flagged (default 14)',
    save: 'Save review algorithm',
    storiesTitle: 'Stories and experiences', saveStories: 'Save story and experience settings',
    suggestionsTitle: 'Supervisor suggestions', saveSuggestions: 'Save suggestion settings',
    suggestionsHelp: 'Used when a heartbeat plan is set to suggest. Suggestions only remind you; they never change a story\'s status.',
    help: 'Page size controls database reads, not total coverage. Batch limits split work without dropping remaining text. These settings and the organize timeout are frozen for each new review; continuing uses its saved configuration. Response capacity uses the current setting for each request; increase it before continuing a failed review.',
    pageSize: 'Sources read at a time (default 50)', batchCharacters: 'Text size per batch (default 8000)',
    batchMessages: 'Messages per batch (default 20)', executionSeconds: 'Time before pausing, seconds (default 300)',
    pauseHelp: 'Reviews run continuously until complete and save each batch. Pause and continue from Activity records.',
    crossProject: 'Link across projects',
    crossProjectHelp: 'When off, new content links only to knowledge already in the same project. When on, it can link to the same work in other projects. Applies to later reviews.',
    invalid: 'Enter whole numbers within the displayed ranges.',
    pause: 'Pause review', resume: 'Continue saved review', facts: 'Retained facts and sources',
    cancel: 'Cancel review', cancelling: 'Cancelling review…', pausing: 'Pausing review…',
    pausedHint: 'Review is incomplete. Successful batches are saved. Open Activity to inspect progress and continue.',
    restartRequired: 'A frozen source changed or was removed. Saved facts remain available. Start a new review from Work review; the next automatic check will also use a new run.',
    factsHelp: 'Use summaries to navigate, then expand saved batches for detailed records and source text. Check the model\'s findings against the sources.',
    revision: 'Source revision', sources: 'All covered source fragments',
    previousPage: 'Previous page', nextPage: 'Next page',
    extracting: 'Reviewing source batches', summarizing: 'Building navigation summaries', inFlight: '{{count}} queued or running model tasks',
    configuration: 'Saved review configuration',
    configurationValues: 'Read {{pageSize}} sources at a time; batch size {{batchCharacters}}, up to {{batchMessages}} messages; run continuously until complete; model timeout {{timeoutSeconds}}s; up to {{concurrency}} simultaneous tasks. Tasks also share the current supervision concurrency limit.',
    progress: '{{batches}} saved batches · {{characters}} characters reviewed · {{remaining}} sources remaining',
    identityError: 'The model returned an invalid entity reference. This batch was not saved; previously saved batches remain available.',
    runError: 'This run failed. Review the error details before continuing; saved batches remain available.',
    diagnostics: 'Error details'
  },
  settingsTabs: { label: 'Supervisor settings sections', model: 'Model', review: 'Review processing', stories: 'Stories and experiences', suggestions: 'Suggestions' },
  suggestions: {
    title: 'Supervisor suggestions',
    kind: { open_item: 'Open item', conflict: 'Disagreement', convention: 'Possible convention', revision: 'Important revision', stalled: 'No recent progress', experience: 'Relevant experience' },
    evidence: 'Evidence ({{count}})', moreEvidence: '{{count}} more in the story graph',
    accept: { open_item: 'Create task', conflict: 'Reviewed', convention: 'Keep as convention', revision: 'Noted', stalled: 'Create task', experience: 'Noted' },
    dismiss: 'Dismiss'
  },
  timeouts: {
    model: 'Model',
    followDefault: 'Default model',
    unavailableModel: 'Selected model is unavailable',
    modelHelp: 'Uses an existing text model for reviews, summaries, stories, experiences, and suggestions. Saving affects the next execution, including continue or retry; a review already running keeps its model.',
    title: 'Model and execution limits',
    report: 'Heartbeat report timeout (seconds)',
    organize: 'Supervisor organize timeout (seconds)',
    help: 'The organize timeout defaults to 240 seconds, adjustable from 30 to 600. Reviews save it at creation and retain it when continued; suggestions use the same limit.',
    transport: 'These limits cover model execution only, not collection or saving. Direct model transport has an independent 600-second timeout; these settings do not extend it. Provider or Runtime limits may stop a request earlier.',
    concurrency: 'Supervision model concurrency',
    concurrencyHelp: 'Review organizing and suggestions share this limit: 1 by default, adjustable from 1 to 4. Queue time does not count toward model timeouts. Lowering the limit affects new dispatches without interrupting active requests. This limits supervision only; ordinary chat is unaffected but still shares upstream model capacity.',
    invalid: 'Enter a whole number from 30 to 600 for the timeout and from 1 to 4 for concurrency.',
    save: 'Save model settings'
  },
  activity: {
    stages: 'Review stages',
    phases: { collecting: 'Collect sources', extracting: 'Review batches', summarizing: 'Merge summaries', saving: 'Publish review' },
    stageStates: { completed: 'Complete', running: 'In progress', failed: 'Failed', paused: 'Paused', cancelled: 'Cancelled', cancelling: 'Cancelling', pausing: 'Pausing', pending: 'Not started', unknown: 'Not recorded', skipped: 'Not needed', no_change: 'No changes' },
    stageUnknown: 'This historical run has no saved stage. Zero remaining sources does not mean the review was published.',
    coverage: '{{batches}} saved batches · {{remaining}} sources remaining',
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
    filteredEmptyHint: 'Run the plan from Smart heartbeat, or clear the filter to view other activity.',
    title: 'Activity records', description: 'Saved manual reviews and heartbeat runs. Updates while this tab is open.',
    loading: 'Loading activity', loadingHint: 'Reading saved execution records.', empty: 'No activity recorded', emptyHint: 'Run a manual review or create a heartbeat plan in Smart heartbeat.',
    kind: { supervision: 'Work review', heartbeat: 'Heartbeat' },
    status: { running: 'Running', completed: 'Completed', failed: 'Failed', skipped: 'Skipped', no_change: 'No changes (no model call)', paused: 'Incomplete, ready to continue', cancelled: 'Cancelled' },
    triggers: { manual: 'User', scheduled: 'Schedule', heartbeat: 'Heartbeat' },
    trigger: 'Triggered by', started: 'Started', finished: 'Finished', unknownScope: 'Execution scope not recorded',
    heartbeatStage: 'Heartbeat trigger', supervisionStage: 'Supervision review', notRecorded: 'No recorded execution',
    storyStage: 'Stories', storyStates: { running: 'Organizing', completed: '{{assigned}} events assigned', failed: 'Failed' }, retryStories: 'Organize stories again',
    storyFailed: 'The review is saved, but stories could not be organized. Try again, or the next review will catch up.',
    experienceStage: 'Experiences', experienceCompleted: '{{created}} new, {{applied}} applications recorded', experienceNone: 'No new progress to learn from',
    experienceFailed: 'Stories are organized, but experiences could not be extracted. Try again, or the next review will catch up.',
    suggestionStage: 'Suggestions', suggestionStates: { running: 'Generating', completed: '{{count}} generated', skipped: 'Nothing to suggest', failed: 'Failed' },
    retrySuggestions: 'Regenerate suggestions', updatedSuggestionFailed: 'Review updated; suggestions could not be generated.',
    openReview: 'Open review', pagination: 'Activity pages', previous: 'Newer', next: 'Older', page: 'Page {{page}}'
  },
  common: {
    operationFailed: 'Supervisor operation failed',
    unavailable: 'Not available',
    unknownTime: 'Unknown time'
  },
  supervisor: {
    loadFailed: 'Review content could not be loaded. Please retry.',
    sourceLoadFailed: 'The source could not be loaded. Open it again to retry.',
    reviewStarted: 'Review started. Open Activity records to check progress.',
    reviewBusy: 'A review is already in progress. Open Activity records to check it.',
    reviewStartFailed: 'Could not check whether a review is running. Please try again shortly.',
    reviewFailed: 'The review could not finish. Open Activity records for details and to continue saved progress, or start a new review.',
    reviewCompleted: 'Review completed. You can view the result or Activity records.',
    reviewCancelled: 'Review cancelled. Existing results remain available.',
    reviewNoChange: 'There is no new content to review. Existing results are unchanged.',
    automatic: 'Smart heartbeat',
    projectScope: 'Project: {{names}}',
    canvasTitle: 'Events and knowledge', generatedAt: 'Generated {{time}}', canvasNote: 'Read counter-clockwise · Select a node to explore knowledge and sources', readingGuide: 'Reading the graph',
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
    empty: 'No successful review yet', emptyHint: 'You can review current progress manually even without an heartbeat plan.', run: 'Review', running: 'Reviewing…',
    more: 'More review actions', reanalyze: 'Reanalyze…', reanalyzeTitle: 'Reanalyze this period?', reanalyzeConfirm: 'Reanalyze',
    reanalyzeHint: 'All content in {{scope}} from the last {{period}} will be analyzed again, which may use more model tokens. Confirmed content and heartbeat progress are not affected.', retryRun: 'Retry review', dismiss: 'Dismiss',
    graphScope: 'Graph scope', graphEmpty: 'No story events in this scope', legend: 'Solid lines show event impact on entities; dashed lines show entity relations. Time runs counter-clockwise with a visible gap.', start: 'Start', end: 'End',
    listTabs: { event: 'Events', entity: 'Entities', relation: 'Relations', story: 'Stories', experience: 'Experiences' },
    experiences: {
      empty: 'No experiences yet. Once stories have progressed, reviews distil reusable experience from them.',
      kicker: 'Experience', automatic: 'Automatic', edited: 'Edited by you',
      conditions: 'Applies when', boundaries: 'Limits', formed: 'Formed from ({{count}})', applied: 'Applied in ({{count}})', noApplications: 'No applications recorded yet.',
      fromStories: 'From {{count}} stories', edit: 'Edit', statement: 'Experience', save: 'Save', remove: 'Delete experience',
      removeHint: 'It will not be recreated from the same evidence. The events and sources it cites are not affected.',
      mergeInto: 'Merge into', choose: 'Choose an experience', merge: 'Merge'
    },
    graph3d: {
      mode: 'Graph view', modes: { flat: 'Flat', spiral: 'Time spiral' },
      levels: 'Stave levels', all: 'All', views: 'Viewpoint', canvas: 'Time spiral. Keys 1, 2 and 3 switch the viewpoint, arrow keys rotate, Esc goes up a level; the toolbar lists offer the same items.',
      view: { oblique: 'Oblique', side: 'Side', top: 'Top', free: 'Free' },
      staves: 'Stories at this level',
      experiences: 'Experiences across stories',
      scale: 'One turn {{turn}} · {{count}} turns',
      legendTitle: 'Legend', legendClose: 'Close legend',
      legendItems: {
        time: 'Height is time; {{scale}}.',
        radius: 'Radius compares user and assistant messages per hour within this review. Equal rates have equal radii; no recorded messages gives the minimum radius. It does not measure time spent or productivity.',
        stave: 'A stave spans its story from first to last event.',
        experience: 'Diamonds outside the barrel are experiences; arcs run from the stave they formed in to the stave that later used them.'
      },
      // Picker buttons name what the list holds at the current level.
      unassigned: 'No current story membership', unknownProject: 'Project unavailable',
      membershipNote: 'Events from this review, grouped by current story membership. Historical membership was not saved.',
      pickEvents: 'Events · {{count}}',
      childLevels: { project: 'Projects', feature: 'Features', thread: 'Sub-threads', cross: 'Cross-project stories', unassigned: 'Unassigned events', mixed: 'Groups' },
      pickChildren: '{{level}} · {{count}}', pickExperience: 'Experiences · {{count}}',
      turns: { 3: '3 hours', 6: '6 hours', 12: '12 hours', 24: '1 day', 168: '1 week', 720: '1 month', 2160: '1 quarter', 8760: '1 year' },
      unsupported: 'This device cannot show 3D. Use the flat view and the story list.',
      failed: 'The time spiral did not load, possibly because the system is busy. The lists and the flat view still work.',
      lost: 'The graphics card interrupted the time spiral. The lists and the flat view still work.',
      retry: 'Reload the time spiral'
    },
    stories: {
      empty: 'No stories yet. After the next review, events are grouped into features and sub-threads under each project.',
      unassigned: '{{count}} more events are not in any story.',
      count: '{{count}} events', concluded: 'Concluded', active: 'Ongoing', edited: 'Edited by you',
      cross: 'Cross-project stories', levels: { feature: 'Feature', thread: 'Sub-thread', cross: 'Cross-project story' },
      rename: 'Rename', name: 'Name', remove: 'Remove story', undo: 'Undo last change',
      removeHint: 'Its events move to the parent feature or become unassigned. Events are not deleted, and later reviews will not recreate a story with this name.',
      mergeInto: 'Merge into', chooseStory: 'Choose a story', merge: 'Merge',
      events: 'Events ({{count}})', primary: 'Story', none: 'Not in a story', missing: 'This story was changed. Select it again.'
    },
    digest: {
      title: 'Stories in this period', label: 'This review by story',
      advanced: 'Stories that moved forward', started: 'New stories', concluded: 'Finished stories', quiet: 'No new progress in this period',
      experiences: 'Experiences formed or used', formed: 'New', applied: 'Used',
      events: '{{count}} events', latest: 'Latest: {{title}}', lastAt: 'Last progress {{date}}',
      empty: 'No events in this period belong to a story yet. After stories are organized, progress appears here by story.',
      unassigned: '{{count}} more events are not in any story.', more: '{{count}} more', open: 'View {{name}} in the graph'
    },
    listEmpty: 'No records of this type in this review.',
    openConversation: 'Open conversation',
    discussion: {
      start: 'Continue discussion', message: 'Message to send',
      target: 'Send to conversation: {{title}}', send: 'Send', sending: 'Sending...', loading: 'Working...', empty: 'The review context is empty. Please retry.'
    },
    events: 'Time events', entities: 'Knowledge entities', relations: 'Entity relations', eventSources: 'Event sources', sources: 'Related sources', noSources: 'No related sources are available.', selectHint: 'Select an event, entity, or relation to inspect it.', sourceSnapshot: 'Source details', sourceMissing: 'Source not found',
    confirm: 'Confirm', revise: 'Revise', remove: 'Remove relation', label: 'Entity name', save: 'Save revision', cancel: 'Cancel', removeHint: 'This changes graph organization only; the original source remains available.',
    relationTypes: { supports: 'Supports', 'depends-on': 'Depends on', contrasts: 'Contrasts', related: 'Related' },
    states: { automatic: 'Automatic · needs review', confirmed: 'Confirmed by user', revised: 'Revised by user', revoked: 'Removed' }
  },
  center: {
    title: 'Supervisor',
    description:
      'Review work progress and knowledge evolution manually or configure Smart heartbeat.',
    scope: {
      currentProject: 'Current project',
      global: 'Global'
    },
    actions: {
      refreshAriaLabel: 'Refresh Supervisor',
      refresh: 'Refresh',
      running: 'Reviewing…',
      runOnce: 'Review now',
      configure: 'Configure Smart heartbeat',
      retry: 'Retry'
    },
    loading: {
      description: 'Loading heartbeat plans and suggestions.',
      title: 'Loading Supervisor',
      failedTitle: 'Could not load Supervisor',
      refreshFailedTitle: 'Could not refresh Supervisor'
    },
    tabs: {
      ariaLabel: 'Smart heartbeat settings and history',
      overview: 'Run overview',
      suggestions: 'Pending suggestions',
      history: 'Earlier heartbeat reports',
      plans: 'Smart heartbeat'
    },
    currentStatus: {
      title: 'Heartbeat plans',
      activePlans: 'Active plans: {{formattedCount}}',
      disabled: 'Not enabled',
      emptyTitle: 'No heartbeat plan is configured. Only manual reviews are available.',
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
      nextHeartbeat: 'Next review',
      lastStatus: 'Last status',
      neverRun: 'Never run',
      runNow: 'Run now',
      pause: 'Pause',
      resume: 'Resume'
    },
    metrics: {
      ariaLabel: 'Smart heartbeat run metrics',
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
      taskEmpty: 'Smart heartbeat has not suggested any actions.',
      useInConversation: 'Handle in conversation',
      markCompleted: 'Mark completed',
      ignoreSuggestion: 'Ignore suggestion'
    },
    history: {
      timelineTitle: 'Earlier heartbeat reports',
      reportCount: 'Reports: {{formattedCount}}',
      emptyTimeline:
        'No earlier heartbeat reports.',
      reportSummary:
        '{{insights}} insights · {{memories}} memories · {{actions}} actions',
      collapseReport: 'Collapse report',
      expandReport: 'Expand full report',
      loadMoreReports: 'Load more review reports',
      auditTitle: 'Run history',
      runCount: 'Runs: {{formattedCount}}',
      emptyRuns: 'There are no heartbeat runs yet.',
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
    refreshPlans: 'Refresh Smart heartbeat',
    refreshReports: 'Refresh reports and suggestions',
    executionHistory: 'Execution history',
    discardTitle: 'Discard unsaved plan changes?',
    discardHint: 'Closing will lose your unsaved changes.',
    keepEditing: 'Keep editing',
    discard: 'Discard changes',
    title: 'Smart heartbeat',
    description:
      'Review the selected scope on schedule in read-only mode without tools. You confirm and handle suggestions.',
    scheduleHelp: 'Choose a daily or weekly review time, then save and enable the plan to run automatically.',
    timezone: 'Plan time zone: {{timezone}}. New plans use this device\'s time zone; edits keep the saved time zone.',
    windowSummary: 'Review the last {{hours}} hours · Keep run history for {{days}} days',
    allPaused: 'All heartbeat plans are paused. Only manual reviews are available.',
    recurrenceAriaLabel: 'Supervision frequency',
    recurrenceLabel: 'Frequency',
    daily: 'Daily',
    weekly: 'Weekly',
    weekdayAriaLabel: 'Supervision weekday',
    weekdayLabel: 'Weekday',
    timeAriaLabel: 'Supervision time',
    timeLabel: 'Time',
    nameLabel: 'Plan name',
    createTitle: 'Create heartbeat plan',
    close: 'Close heartbeat plan',
    editTitle: 'Edit heartbeat plan',
    cancelEdit: 'Cancel editing',
    editAriaLabel: 'Edit {{name}}',
    edit: 'Edit',
    saveAriaLabel: 'Save heartbeat plan',
    save: 'Save changes',
    lookbackLabel: 'Review window (hours)',
    lookbackAriaLabel: 'Review window (hours)',
    retentionLabel: 'History retention (days)',
    intervention: {
      legend: 'Heartbeat intervention', suggest: 'Suggest', memory: 'Update memory only',
      help: 'Each check only organizes what changed. With suggestions on, the supervisor suggests from those changes without re-reading the original conversations.',
      suggestHint: 'Suggests when there are new open items, disagreements or important revisions, each with its evidence. Stays quiet otherwise.',
      memoryHint: 'Only updates work memory and the story graph. No suggestions.'
    },
    retentionAriaLabel: 'History retention (days)',
    scope: {
      legend: 'Project scope',
      ariaLabel: 'Choose Smart heartbeat project scope',
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
    empty: 'No heartbeat plan is configured. Only manual reviews are available.',
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
