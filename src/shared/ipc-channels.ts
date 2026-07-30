export const ipcChannels = {
  appInfo: 'app:get-info',
  appShow: 'app:show',
  appHide: 'app:hide',
  conversationNew: 'conversation:new',
  agentStatus: 'agent:get-status',
  agentRun: 'agent:run',
  agentCancel: 'agent:cancel',
  agentApprovalRespond: 'agent:approval:respond',
  agentEvent: 'agent:event',
  runtimeSettingsGet: 'settings:runtime:get',
  runtimeSettingsUpdate: 'settings:runtime:update',
  contextSelectFiles: 'context:select-files',
  contextRemove: 'context:remove'
} as const
