import { randomUUID } from 'node:crypto'
import { externalKnowledgeBindingSaveInputSchema, externalKnowledgeBindingTestInputSchema, externalKnowledgeBindingUpdateInputSchema, externalKnowledgeInstanceSaveInputSchema, type ExternalKnowledgeBinding, type ExternalKnowledgeBindingSaveInput, type ExternalKnowledgeBindingTestInput, type ExternalKnowledgeInstanceSaveInput, type ExternalKnowledgeInstanceSummary, type ExternalKnowledgeTestResult } from '../../../shared/external-knowledge-contracts'
import { decryptSettingsCredential, encryptSettingsCredential, type SettingsCredentialCipher } from '../../settings-credential-cipher'
import type { KnowledgeDatabase } from '../knowledge-database'
import { ExternalKnowledgeClient, ExternalKnowledgeError } from './external-knowledge-client'
import type { StoredExternalInstance } from './external-knowledge-store'

// Probe results are persisted metadata, not a change to an in-flight request's configuration.
function instanceConfiguration(value: StoredExternalInstance): string {
  return JSON.stringify([value.id, value.name, value.provider, value.baseUrl, value.enabled, value.credential])
}

export class ExternalKnowledgeService {
  private disposed = false
  private readonly controllers = new Map<AbortController,string>()
  constructor(private readonly database: KnowledgeDatabase, private readonly cipher?: SettingsCredentialCipher, private readonly fetcher?: typeof fetch) {}
  dispose(): void { this.disposed = true; for (const controller of this.controllers.keys()) controller.abort(); this.controllers.clear() }
  private checkActive(): void { if (this.disposed) throw new Error('EXTERNAL_KB_CANCELLED') }
  private cancelInstance(id: string): void {
    for (const [controller, instanceId] of this.controllers) if (instanceId === id) controller.abort()
  }
  private instance(id:string): StoredExternalInstance {
    this.checkActive()
    const value=this.database.externalStore.getInstance(id)
    if (!value) throw new Error('EXTERNAL_KB_NOT_FOUND')
    return value
  }
  listInstances(): ExternalKnowledgeInstanceSummary[] {
    this.checkActive()
    const bindings=this.database.externalStore.listBindings()
    return this.database.externalStore.listInstances().map(({credential,...value})=>{
      let credentialStatus: ExternalKnowledgeInstanceSummary['credentialStatus'] = 'missing'
      if (credential) {
        try { this.credential({ ...value, credential }); credentialStatus = 'configured' }
        catch { credentialStatus = 'unavailable' }
      }
      return {...value,credentialStatus,bindingCount:bindings.filter(binding=>binding.instanceId===value.id).length}
    })
  }
  private credential(instance: StoredExternalInstance): string {
    try {
      if (!instance.credential || !this.cipher?.isAvailable()) throw new Error()
      const key = decryptSettingsCredential(this.cipher, instance.credential)
      if (typeof key !== 'string' || !key.trim()) throw new Error()
      return key
    } catch { throw new Error('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE') }
  }
  saveInstance(raw:ExternalKnowledgeInstanceSaveInput):ExternalKnowledgeInstanceSummary {
    this.checkActive()
    const input=externalKnowledgeInstanceSaveInputSchema.parse(raw)
    const previous=input.id ? this.instance(input.id):undefined
    if (previous && previous.provider!==input.provider && this.database.externalStore.listBindings().some(binding=>binding.instanceId===previous.id)) throw new Error('EXTERNAL_KB_INSTANCE_IN_USE')
    let credential=previous?.credential
    if (input.credential.action==='clear') credential=undefined
    if (input.credential.action==='replace') {
      if (!this.cipher?.isAvailable()) throw new Error('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE')
      try { credential=encryptSettingsCredential(this.cipher,input.credential.value) }
      catch { throw new Error('EXTERNAL_KB_CREDENTIAL_UNAVAILABLE') }
    }
    const value:StoredExternalInstance={id:previous?.id??randomUUID(),name:input.name,provider:input.provider,baseUrl:input.baseUrl.replace(/\/+$/,''),enabled:input.enabled,credential,probeStatus:'untested'}
    this.database.externalStore.saveInstance(value)
    this.cancelInstance(value.id)
    return this.listInstances().find(item=>item.id===value.id)!
  }
  setEnabled(id:string,enabled:boolean):ExternalKnowledgeInstanceSummary {
    const instance=this.instance(id)
    this.database.externalStore.saveInstance({...instance,enabled})
    if (!enabled) for(const [controller,instanceId] of this.controllers) if(instanceId===id) controller.abort()
    return this.listInstances().find(item=>item.id===id)!
  }
  deleteInstance(id:string):void {
    this.instance(id)
    if(this.database.externalStore.listBindings().some(binding=>binding.instanceId===id)) throw new Error('EXTERNAL_KB_INSTANCE_IN_USE')
    for(const [controller,instanceId] of this.controllers) if(instanceId===id) controller.abort()
    this.database.externalStore.deleteInstance(id)
  }
  private async request<T>(id:string,timeout:number,signal:AbortSignal|undefined,operation:(client:ExternalKnowledgeClient,signal:AbortSignal)=>Promise<T>):Promise<T> {
    const instance=this.instance(id)
    if(!instance.enabled) throw new Error('EXTERNAL_KB_DISABLED')
    const key = this.credential(instance)
    const controller=new AbortController()
    this.controllers.set(controller,id)
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combined = AbortSignal.any([controller.signal, timeoutSignal, ...(signal ? [signal] : [])])
    try {
      combined.throwIfAborted()
      const result = await operation(new ExternalKnowledgeClient({provider:instance.provider,baseUrl:instance.baseUrl,apiKey:key,timeoutMs:timeout,fetcher:this.fetcher}),combined)
      combined.throwIfAborted()
      return result
    } catch (error) {
      if (combined.aborted) {
        const timedOut = timeoutSignal.aborted && combined.reason === timeoutSignal.reason
        throw new ExternalKnowledgeError(timedOut ? 'EXTERNAL_KB_TIMEOUT' : 'EXTERNAL_KB_CANCELLED',
          timedOut ? 'External knowledge request timed out' : 'External knowledge request was cancelled')
      }
      throw error
    } finally {this.controllers.delete(controller)}
  }
  async testInstance(id:string):Promise<ExternalKnowledgeInstanceSummary> {
    const instance=this.instance(id)
    let probeStatus:StoredExternalInstance['probeStatus']='catalog-ready'
    let lastErrorCode:string|undefined
    try {await this.listCatalog({instanceId:id})} catch(error) {
      lastErrorCode=error instanceof ExternalKnowledgeError ? error.code : error instanceof Error && /^EXTERNAL_KB_/.test(error.message) ? error.message : 'EXTERNAL_KB_NETWORK'
      probeStatus=lastErrorCode==='EXTERNAL_KB_FORBIDDEN'?'list-restricted':lastErrorCode==='EXTERNAL_KB_AUTH'?'auth-failed':lastErrorCode==='EXTERNAL_KB_NETWORK'||lastErrorCode==='EXTERNAL_KB_TIMEOUT'?'unreachable':'failed'
    }
    const current = this.instance(id)
    if (instanceConfiguration(current) !== instanceConfiguration(instance)) throw new Error('EXTERNAL_KB_CONFIG_CHANGED')
    this.database.externalStore.saveInstance({...current,probeStatus,lastErrorCode,lastTestedAt:new Date().toISOString()})
    return this.listInstances().find(item=>item.id===id)!
  }
  listCatalog(input:{instanceId:string;page?:number;pageSize?:number;parentId?:string|null;search?:string},signal?:AbortSignal) {
    return this.request(input.instanceId,15000,signal,(client,current)=>client.listKnowledgeBases(current,input))
  }
  getCatalog(input:{instanceId:string;remoteKnowledgeBaseId:string},signal?:AbortSignal) {
    return this.request(input.instanceId,15000,signal,(client,current)=>client.getKnowledgeBase(input.remoteKnowledgeBaseId,current))
  }
  async testRetrieval(raw:ExternalKnowledgeBindingTestInput,signal?:AbortSignal):Promise<ExternalKnowledgeTestResult> {
    const input=externalKnowledgeBindingTestInputSchema.parse(raw)
    const instance=this.instance(input.instanceId)
    if(instance.provider!==input.providerConfig.provider) throw new Error('EXTERNAL_KB_CONFIG_INVALID')
    const started=Date.now()
    const results=await this.request(input.instanceId,input.commonConfig.requestTimeoutMs,signal,async (client,current)=>{
      if(input.providerConfig.provider==='ragflow' && (input.providerConfig.useKg||input.providerConfig.includeKnowledgeCompilation)) {
        const detail=await client.getKnowledgeBase(input.remoteKnowledgeBaseId,current)
        if((input.providerConfig.useKg&&!detail.graphEnabled)||(input.providerConfig.includeKnowledgeCompilation&&!detail.knowledgeCompilationEnabled)) throw new Error('EXTERNAL_KB_CAPABILITY_UNAVAILABLE')
      }
      return client.retrieve(input.remoteKnowledgeBaseId,input.testQuery,input.providerConfig,current)
    })
    if (instanceConfiguration(instance) !== instanceConfiguration(this.instance(input.instanceId))) throw new Error('EXTERNAL_KB_CONFIG_CHANGED')
    let remaining = 48_000
    const bounded = results.slice(0, input.commonConfig.resultLimit).map(item => {
      const snippet = item.snippet.slice(0, Math.min(remaining, input.commonConfig.maxSnippetCharacters))
      remaining -= snippet.length
      return { ...item, snippet }
    }).filter(item => item.snippet.length > 0)
    return {results:bounded,durationMs:Date.now()-started}
  }
  async saveBinding(raw:ExternalKnowledgeBindingSaveInput & {knowledgeBaseId?:string}):Promise<ExternalKnowledgeBinding> {
    this.checkActive()
    const input=raw.knowledgeBaseId !== undefined ? externalKnowledgeBindingUpdateInputSchema.parse(raw):externalKnowledgeBindingSaveInputSchema.parse(raw)
    const knowledgeBaseId = 'knowledgeBaseId' in input ? input.knowledgeBaseId : undefined
    const existing=knowledgeBaseId ? this.database.externalStore.listBindings().find(item=>item.knowledgeBaseId===knowledgeBaseId):undefined
    if(knowledgeBaseId&&!existing) throw new Error('EXTERNAL_KB_NOT_FOUND')
    if(this.database.externalStore.listBindings().some(item=>item.instanceId===input.instanceId&&item.remoteKnowledgeBaseId===input.remoteKnowledgeBaseId&&item.knowledgeBaseId!==existing?.knowledgeBaseId)) throw new Error('EXTERNAL_KB_DUPLICATE_BINDING')
    const instance = this.instance(input.instanceId)
    await this.testRetrieval({instanceId:input.instanceId,remoteKnowledgeBaseId:input.remoteKnowledgeBaseId,commonConfig:input.commonConfig,providerConfig:input.providerConfig,testQuery:input.testQuery})
    if (instanceConfiguration(instance) !== instanceConfiguration(this.instance(input.instanceId))) throw new Error('EXTERNAL_KB_CONFIG_CHANGED')
    const bindings = this.database.externalStore.listBindings()
    if (existing && JSON.stringify(bindings.find(item => item.knowledgeBaseId === existing.knowledgeBaseId)) !== JSON.stringify(existing)) throw new Error('EXTERNAL_KB_CONFIG_CHANGED')
    if (bindings.some(item => item.instanceId === input.instanceId && item.remoteKnowledgeBaseId === input.remoteKnowledgeBaseId && item.knowledgeBaseId !== existing?.knowledgeBaseId)) throw new Error('EXTERNAL_KB_DUPLICATE_BINDING')
    return this.database.saveExternalBinding({instanceId:input.instanceId,provider:input.providerConfig.provider,remoteKnowledgeBaseId:input.remoteKnowledgeBaseId,remoteName:input.remoteName,commonConfig:input.commonConfig,providerConfig:input.providerConfig,lastVerifiedAt:new Date().toISOString()}, {name:input.name,description:input.description,knowledgeBaseId:existing?.knowledgeBaseId})
  }
}
