import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

const CHALLENGE_DOMAIN = 'goodbuddy-agent-installation-challenge-v1\0'

export type InstallationChallenge = {
  serverNonce: string
  expiresAt: number
}

export class InstallationChallengeVerifier {
  readonly #secret: Buffer
  readonly #now: () => number
  readonly #lifetimeMs: number
  readonly #pending = new Map<string, number>()

  constructor(
    secret: Uint8Array,
    options: { now?: () => number; lifetimeMs?: number } = {}
  ) {
    if (secret.byteLength < 32) {
      throw new RangeError('Installation challenge secret is too short')
    }
    this.#secret = Buffer.from(secret)
    this.#now = options.now ?? Date.now
    this.#lifetimeMs = options.lifetimeMs ?? 30_000
    if (!Number.isSafeInteger(this.#lifetimeMs) || this.#lifetimeMs < 1) {
      throw new RangeError('Invalid installation challenge lifetime')
    }
  }

  issue(): InstallationChallenge {
    this.#purgeExpired()
    const serverNonce = randomBytes(32).toString('base64url')
    const expiresAt = this.#now() + this.#lifetimeMs
    this.#pending.set(serverNonce, expiresAt)
    return { serverNonce, expiresAt }
  }

  createResponse(input: {
    serverNonce: string
    clientNonce: string
    controllerId: string
  }): string {
    return calculateResponse(this.#secret, input)
  }

  verify(input: {
    serverNonce: string
    clientNonce: string
    controllerId: string
    response: string
  }): boolean {
    const expiresAt = this.#pending.get(input.serverNonce)
    this.#pending.delete(input.serverNonce)
    if (expiresAt === undefined || expiresAt < this.#now()) {
      return false
    }
    const expected = Buffer.from(
      calculateResponse(this.#secret, input),
      'base64url'
    )
    let received: Buffer
    try {
      received = Buffer.from(input.response, 'base64url')
    } catch {
      return false
    }
    return (
      expected.byteLength === received.byteLength &&
      timingSafeEqual(expected, received)
    )
  }

  #purgeExpired(): void {
    const now = this.#now()
    for (const [nonce, expiresAt] of this.#pending) {
      if (expiresAt < now) {
        this.#pending.delete(nonce)
      }
    }
  }
}

function calculateResponse(
  secret: Uint8Array,
  input: {
    serverNonce: string
    clientNonce: string
    controllerId: string
  }
): string {
  for (const value of [
    input.serverNonce,
    input.clientNonce,
    input.controllerId
  ]) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
      throw new Error('Invalid installation challenge field')
    }
  }
  return createHmac('sha256', secret)
    .update(CHALLENGE_DOMAIN)
    .update(input.serverNonce)
    .update('\0')
    .update(input.clientNonce)
    .update('\0')
    .update(input.controllerId)
    .digest('base64url')
}
