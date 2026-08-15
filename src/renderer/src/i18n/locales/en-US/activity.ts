import type { TranslationShape } from '../../resource-types'
import type { activity as chineseActivity } from '../zh-CN/activity'

export const activity = {
  header: {
    eyebrow: 'RUN HISTORY',
    title: 'Run history',
    description:
      'Review execution details by project, task, and conversation, or browse the activity timeline and model usage.'
  },
  tabs: {
    ariaLabel: 'Run history views',
    tasks: 'Tasks and conversations',
    timeline: 'Activity timeline',
    usage: 'Usage analytics'
  },
  clear: {
    confirmAriaLabel: 'Confirm clearing activity history',
    confirmLabel: 'Clear activity ({{formattedCount}})',
    message:
      'Permanently clear activity history? Items to delete: {{formattedCount}}. This cannot be undone.',
    triggerLabel: 'Clear records'
  },
  statuses: {
    pending: 'Pending',
    running: 'In progress',
    completed: 'Completed',
    failed: 'Failed',
    denied: 'Denied',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted'
  },
  kinds: {
    request: 'Task',
    tool: 'Tool',
    approval: 'Approval',
    subagent: 'Child expert',
    result: 'Result'
  },
  filters: {
    all: 'All',
    active: 'In progress',
    failed: 'Exceptions',
    ariaLabel: 'Filter activity',
    clear: 'Clear filter'
  },
  tokenUsage: {
    title: 'Token usage',
    groupAriaLabel: 'Group token usage',
    statsAriaLabel: 'Token usage totals',
    groups: {
      project: 'By project',
      conversation: 'By conversation',
      model: 'By model'
    },
    runtimes: {
      model: 'Direct model',
      opencode: 'OpenCode',
      continue: 'Continue',
      deepseekHarness: 'DeepSeek Harness'
    },
    columns: {
      project: 'Project',
      conversation: 'Conversation',
      model: 'Model',
      input: 'Input',
      output: 'Output',
      cacheWrite: 'Cache writes',
      cacheRead: 'Cache reads',
      cacheHitRate: 'Cache hit rate',
      total: 'Total'
    },
    detailAriaLabel: 'Token usage details by {{group}}',
    empty: 'No token usage',
    fallbacks: {
      unassignedProject: 'Unassigned project',
      deletedConversation: 'Deleted conversation',
      unknownModel: 'Unknown model',
      unknownRuntime: 'Unknown Runtime'
    }
  },
  stats: {
    ariaLabel: 'Activity totals',
    all: 'All',
    active: 'In progress',
    failed: 'Exceptions'
  },
  timeline: {
    ariaLabel: 'Parallel activity tracks grouped by project and conversation',
    description:
      'Every track shares the same execution order. Nodes are spread by event time. Select a node to inspect its identity and details.',
    lanes: 'Project / conversation',
    laneAriaLabel: 'Activity track for conversation {{title}}',
    nodeAriaLabel: '{{actor}}, {{kind}}, {{status}}, {{title}}, {{time}}',
    legendAriaLabel: 'Activity node identity legend',
    detailAriaLabel: 'Selected activity node details',
    closeDetail: 'Close details',
    actors: {
      user: 'User',
      assistant: 'GoodBuddy',
      subagent: 'Child expert',
      tool: 'Tool',
      approval: 'Approval'
    },
    nodes: {
      user: 'U',
      assistant: 'G',
      tool: 'T',
      approval: 'A',
      subagent: 'S'
    }
  },
  empty: {
    active: 'There is no pending or running activity.',
    failed: 'There is no failed, cancelled, or interrupted activity.',
    all:
      'Task requests, child experts, tool calls, and approval decisions will appear here.',
    noRecordsTitle: 'No activity yet',
    noMatchesTitle: 'No matching activity'
  },
  records: {
    unknownTime: 'Unknown time',
    interruptedOnRestart:
      'This activity had not finished when the app restarted.',
    unavailableScope:
      'The scope could not be determined when this activity was recorded.',
    conversation: 'Conversation: {{title}}',
    activityCount: 'Activity items: {{formattedCount}}',
    projectSummary:
      '{{conversationCount}} tasks or conversations · {{activityCount}} activity items',
    openConversation: 'Open conversation'
  }
} satisfies TranslationShape<typeof chineseActivity>
