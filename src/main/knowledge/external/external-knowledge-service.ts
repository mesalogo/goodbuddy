import { randomUUID } from 'node:crypto'
import {
  externalKnowledgeBindingSaveInputSchema,
  externalKnowledgeBindingTestInputSchema,
  externalKnowledgeBindingUpdateInputSchema,
  externalKnowledgeInstanceSaveInputSchema,
  externalKnowledgeRetrievalInputSchema,
  type ExternalKnowledgeBinding,
  type ExternalKnowledgeBindingSaveInput,
  type ExternalKnowledgeBindingTestInput,
  type ExternalKnowledgeCommonConfig,
  type ExternalKnowledgeInstanceSaveInput,
  type ExternalKnowledgeInstanceSummary,
  type ExternalKnowledgeRemoteResult,
  type ExternalKnowledgeRetrievalInput,
  type ExternalKnowledgeTestResult
} from '../../../shared/external-knowledge-contracts'
import {
  decryptSettingsCredential,
  encryptSettingsCredential,
  type SettingsCredentialCipher
} from '../../settings-credential-cipher'
import type { KnowledgeDatabase } from '../knowledge-database'
import { ExternalKnowledgeClient, ExternalKnowledgeError } from './external-knowledge-client'
import type { StoredExternalInstance } from './external-knowledge-store'

const SHARED_SNIPPET_BUDGET = 48_000

export class ExternalKnowledgeService {
  private disposed = false
  private readonly controllers = new Map<AbortController, string>()

  constructor(
    private readonly database: KnowledgeDatabase,
    private readonly cipher?: SettingsCredentialCipher,
    private readonly fetcher?: typeof fetch
  ) {}

  dispose(): void {
    this.disposed = true
    for (const controller of this.controllers.keys()) {
      controller.abort()
    }
    this.controllers.clear()
  }

  private checkActive(): void {
    if (this.disposed) {
      throw new Error('EXTERNAL_KB_CANCELLED')
    }
  }

  private cancelInstance(id: string): void {
    for (const [controller, instanceId] of this.controllers) {
      if (instanceId === id) {
        controller.abort()
      }
    }
  }

  private instance(id: string): StoredExternalInstance {
    this.checkActive()
    const value = this.database.externalStore.getInstance(id)
    if (!value) {
      throw new Error('EXTERNAL_KB_NOT_FOUND')
    }
    return value
  }

  private credential(instance: StoredExternalInstance): string {
    try {
      if (!instance.credential || !this.cipher?.isAvailable()) {
        throw new Error()
      }
      const key = decryptSettingsCredential(this.cipher, instance.credential)
      if (typeof key !== 'string' || !key.trim()) {
        throw new Error()
      }
      return key
    } catch {
      throw new Error('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
    }
  }

  listInstances(): ExternalKnowledgeInstanceSummary[] {
    this.checkActive()
    const bindingCounts = new Map<string, number>()
    for (const binding of this.database.externalStore.listBindings()) {
      bindingCounts.set(binding.instanceId, (bindingCounts.get(binding.instanceId) ?? 0) + 1)
    }
    return this.database.externalStore.listInstances().map(({ credential, ...value }) => {
      let credentialStatus: ExternalKnowledgeInstanceSummary['credentialStatus'] = 'missing'
      if (credential) {
        try {
          this.credential({ ...value, credential })
          credentialStatus = 'configured'
        } catch {
          credentialStatus = 'unavailable'
        }
      }
      return { ...value, credentialStatus, bindingCount: bindingCounts.get(value.id) ?? 0 }
    })
  }

  private summary(id: string): ExternalKnowledgeInstanceSummary {
    const summary = this.listInstances().find((item) => item.id === id)
    if (!summary) {
      throw new Error('EXTERNAL_KB_NOT_FOUND')
    }
    return summary
  }

  saveInstance(raw: ExternalKnowledgeInstanceSaveInput): ExternalKnowledgeInstanceSummary {
    this.checkActive()
    const input = externalKnowledgeInstanceSaveInputSchema.parse(raw)
    const previous = input.id ? this.instance(input.id) : undefined
    if (
      previous &&
      previous.provider !== input.provider &&
      this.database.externalStore.getBindingsForInstance(previous.id).length > 0
    ) {
      throw new Error('EXTERNAL_KB_INSTANCE_IN_USE')
    }
    let credential = previous?.credential
    if (input.credential.action === 'clear') {
      credential = undefined
    }
    if (input.credential.action === 'replace') {
      if (!this.cipher?.isAvailable()) {
        throw new Error('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
      }
      try {
        credential = encryptSettingsCredential(this.cipher, input.credential.value)
      } catch {
        throw new Error('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
      }
    }
    const value: StoredExternalInstance = {
      id: previous?.id ?? randomUUID(),
      name: input.name,
      provider: input.provider,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      enabled: input.enabled,
      credential,
      probeStatus: 'untested'
    }
    this.database.externalStore.saveInstance(value)
    // In-flight requests were authorized against the replaced configuration.
    this.cancelInstance(value.id)
    return this.summary(value.id)
  }

  setEnabled(id: string, enabled: boolean): ExternalKnowledgeInstanceSummary {
    const instance = this.instance(id)
    this.database.externalStore.saveInstance({ ...instance, enabled })
    if (!enabled) {
      this.cancelInstance(id)
    }
    return this.summary(id)
  }

  deleteInstance(id: string): void {
    this.instance(id)
    if (this.database.externalStore.getBindingsForInstance(id).length > 0) {
      throw new Error('EXTERNAL_KB_INSTANCE_IN_USE')
    }
    this.cancelInstance(id)
    this.database.externalStore.deleteInstance(id)
  }

  private async request<T>(
    id: string,
    timeout: number,
    signal: AbortSignal | undefined,
    operation: (client: ExternalKnowledgeClient, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const instance = this.instance(id)
    if (!instance.enabled) {
      throw new Error('EXTERNAL_KB_DISABLED')
    }
    const key = this.credential(instance)
    const controller = new AbortController()
    this.controllers.set(controller, id)
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = AbortSignal.any([
      controller.signal,
      timeoutSignal,
      ...(signal ? [signal] : [])
    ])
    try {
      combined.throwIfAborted()
      return await operation(
        new ExternalKnowledgeClient({
          provider: instance.provider,
          baseUrl: instance.baseUrl,
          apiKey: key,
          timeoutMs: timeout,
          fetcher: this.fetcher
        }),
        combined
      )
    } catch (error) {
      if (combined.aborted) {
        const timedOut = timeoutSignal.aborted && combined.reason === timeoutSignal.reason
        throw new ExternalKnowledgeError(
          timedOut ? 'EXTERNAL_KB_TIMEOUT' : 'EXTERNAL_KB_CANCELLED',
          timedOut
            ? 'External knowledge request timed out'
            : 'External knowledge request was cancelled'
        )
      }
      throw error
    } finally {
      this.controllers.delete(controller)
    }
  }

  async testInstance(id: string): Promise<ExternalKnowledgeInstanceSummary> {
    this.instance(id)
    let probeStatus: StoredExternalInstance['probeStatus'] = 'catalog-ready'
    let lastErrorCode: string | undefined
    try {
      await this.listCatalog({ instanceId: id })
    } catch (error) {
      lastErrorCode =
        error instanceof ExternalKnowledgeError
          ? error.code
          : error instanceof Error && /^EXTERNAL_KB_/.test(error.message)
            ? error.message
            : 'EXTERNAL_KB_NETWORK'
      // Cancellation means the configuration changed under the probe, so it
      // learned nothing about reachability and must not overwrite the record.
      if (lastErrorCode === 'EXTERNAL_KB_CANCELLED') {
        throw error
      }
      probeStatus =
        lastErrorCode === 'EXTERNAL_KB_FORBIDDEN'
          ? 'list-restricted'
          : lastErrorCode === 'EXTERNAL_KB_AUTH'
            ? 'auth-failed'
            : lastErrorCode === 'EXTERNAL_KB_NETWORK' || lastErrorCode === 'EXTERNAL_KB_TIMEOUT'
              ? 'unreachable'
              : 'failed'
    }
    const current = this.database.externalStore.getInstance(id)
    if (!current) {
      throw new Error('EXTERNAL_KB_NOT_FOUND')
    }
    this.database.externalStore.saveInstance({
      ...current,
      probeStatus,
      lastErrorCode,
      lastTestedAt: new Date().toISOString()
    })
    return this.summary(id)
  }

  listCatalog(
    input: {
      instanceId: string
      page?: number
      pageSize?: number
      parentId?: string | null
      search?: string
    },
    signal?: AbortSignal
  ) {
    return this.request(input.instanceId, 15_000, signal, (client, current) =>
      client.listKnowledgeBases(current, input)
    )
  }

  getCatalog(input: { instanceId: string; remoteKnowledgeBaseId: string }, signal?: AbortSignal) {
    return this.request(input.instanceId, 15_000, signal, (client, current) =>
      client.getKnowledgeBase(input.remoteKnowledgeBaseId, current)
    )
  }

  private boundResults(
    results: readonly ExternalKnowledgeRemoteResult[],
    common: ExternalKnowledgeCommonConfig
  ): ExternalKnowledgeRemoteResult[] {
    let remaining = SHARED_SNIPPET_BUDGET
    return results
      .slice(0, common.resultLimit)
      .map((item) => {
        const snippet = item.snippet.slice(
          0,
          Math.min(remaining, common.maxSnippetCharacters)
        )
        remaining -= snippet.length
        return { ...item, snippet }
      })
      .filter((item) => item.snippet.length > 0)
  }

  /** Retrieves from the bound remote knowledge base. This is the production path. */
  async retrieve(
    raw: ExternalKnowledgeRetrievalInput,
    signal?: AbortSignal
  ): Promise<ExternalKnowledgeTestResult> {
    const input = externalKnowledgeRetrievalInputSchema.parse(raw)
    if (this.instance(input.instanceId).provider !== input.providerConfig.provider) {
      throw new Error('EXTERNAL_KB_CONFIG_INVALID')
    }
    const started = Date.now()
    const results = await this.request(
      input.instanceId,
      input.commonConfig.requestTimeoutMs,
      signal,
      (client, current) =>
        client.retrieve(input.remoteKnowledgeBaseId, input.query, input.providerConfig, current)
    )
    return {
      results: this.boundResults(results, input.commonConfig),
      durationMs: Date.now() - started
    }
  }

  /**
   * Verifies a binding before it is saved. Unlike retrieve, this also confirms
   * that the remote deployment provides the requested capabilities. The check
   * shares the configured request timeout so the whole verification stays
   * within the budget the user chose.
   */
  async testRetrieval(
    raw: ExternalKnowledgeBindingTestInput,
    signal?: AbortSignal
  ): Promise<ExternalKnowledgeTestResult> {
    const input = externalKnowledgeBindingTestInputSchema.parse(raw)
    const config = input.providerConfig
    if (this.instance(input.instanceId).provider !== config.provider) {
      throw new Error('EXTERNAL_KB_CONFIG_INVALID')
    }
    const started = Date.now()
    const results = await this.request(
      input.instanceId,
      input.commonConfig.requestTimeoutMs,
      signal,
      async (client, current) => {
        if (config.provider === 'ragflow' && (config.useKg || config.includeKnowledgeCompilation)) {
          const detail = await client.getKnowledgeBase(input.remoteKnowledgeBaseId, current)
          if (
            (config.useKg && !detail.graphEnabled) ||
            (config.includeKnowledgeCompilation && !detail.knowledgeCompilationEnabled)
          ) {
            throw new Error('EXTERNAL_KB_CAPABILITY_UNAVAILABLE')
          }
        }
        return client.retrieve(input.remoteKnowledgeBaseId, input.testQuery, config, current)
      }
    )
    return {
      results: this.boundResults(results, input.commonConfig),
      durationMs: Date.now() - started
    }
  }

  async saveBinding(
    raw: ExternalKnowledgeBindingSaveInput & { knowledgeBaseId?: string }
  ): Promise<ExternalKnowledgeBinding> {
    this.checkActive()
    const update =
      raw.knowledgeBaseId !== undefined
        ? externalKnowledgeBindingUpdateInputSchema.parse(raw)
        : undefined
    const input = update ?? externalKnowledgeBindingSaveInputSchema.parse(raw)
    const existing = update
      ? this.database.externalStore.getBinding(update.knowledgeBaseId)
      : undefined
    if (update && !existing) {
      throw new Error('EXTERNAL_KB_NOT_FOUND')
    }
    this.instance(input.instanceId)
    const duplicate = (): boolean =>
      this.database.externalStore
        .listBindings()
        .some(
          (item) =>
            item.instanceId === input.instanceId &&
            item.remoteKnowledgeBaseId === input.remoteKnowledgeBaseId &&
            item.knowledgeBaseId !== existing?.knowledgeBaseId
        )
    if (duplicate()) {
      throw new Error('EXTERNAL_KB_DUPLICATE_BINDING')
    }
    await this.testRetrieval({
      instanceId: input.instanceId,
      remoteKnowledgeBaseId: input.remoteKnowledgeBaseId,
      commonConfig: input.commonConfig,
      providerConfig: input.providerConfig,
      testQuery: input.testQuery
    })
    // Another binding for the same remote target may have landed while the
    // verification request was in flight; the unique index is the final guard.
    if (duplicate()) {
      throw new Error('EXTERNAL_KB_DUPLICATE_BINDING')
    }
    return this.database.saveExternalBinding(
      {
        instanceId: input.instanceId,
        provider: input.providerConfig.provider,
        remoteKnowledgeBaseId: input.remoteKnowledgeBaseId,
        remoteName: input.remoteName,
        commonConfig: input.commonConfig,
        providerConfig: input.providerConfig,
        lastVerifiedAt: new Date().toISOString()
      },
      {
        name: input.name,
        description: input.description,
        knowledgeBaseId: existing?.knowledgeBaseId
      }
    )
  }
}
