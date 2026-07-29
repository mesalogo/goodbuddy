export const ipcChannels = {
  appInfo: 'app:get-info',
  appShow: 'app:show',
  appHide: 'app:hide',
  conversationNew: 'conversation:new',
  agentStatus: 'agent:get-status',
  agentRun: 'agent:run',
  agentCancel: 'agent:cancel',
  agentEvent: 'agent:event'
} as const
