export class AgentUnsupportedError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'platform-incompatible'
      | 'supervisor-unavailable'
      | 'peer-identity-unavailable'
  ) {
    super(message)
    this.name = 'AgentUnsupportedError'
  }
}
