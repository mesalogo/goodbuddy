import type { TranslationShape } from '../../resource-types'
import type { activity as chineseActivity } from '../zh-CN/activity'

export const activity = {
  header: {
    eyebrow: 'ACTIVITY AUDIT',
    title: 'Tasks and activity',
    description:
      'View task requests, child experts, tool calls, approval results, and token usage across all projects.'
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
    failed: 'Failed',
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
    columns: {
      project: 'Project',
      conversation: 'Conversation',
      model: 'Model',
      input: 'Input',
      output: 'Output',
      cacheWrite: 'Cache writes',
      cacheRead: 'Cache reads',
      total: 'Total'
    },
    detailAriaLabel: 'Token usage details by {{group}}',
    empty: 'No token usage',
    fallbacks: {
      unassignedProject: 'Unassigned project',
      deletedConversation: 'Deleted conversation',
      unknownModel: 'Unknown model'
    }
  },
  stats: {
    ariaLabel: 'Activity totals',
    all: 'All',
    active: 'In progress',
    failed: 'Failed'
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
    openConversation: 'Open conversation'
  }
} satisfies TranslationShape<typeof chineseActivity>
