import type { DatabaseSync } from 'node:sqlite'
import type { ExternalKnowledgeBinding, ExternalKnowledgeInstanceSummary } from '../../../shared/external-knowledge-contracts'
import type { EncryptedSettingsCredential } from '../../settings-credential-cipher'

export type StoredExternalInstance = Omit<ExternalKnowledgeInstanceSummary, 'credentialStatus' | 'bindingCount'> & {credential?:EncryptedSettingsCredential}

export class ExternalKnowledgeStore {
  constructor(private readonly database: DatabaseSync) {}
  getInstance(id: string): StoredExternalInstance | undefined {
    const row = this.database.prepare('SELECT value_json FROM external_knowledge_instances WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value_json)) as StoredExternalInstance : undefined
  }
  listInstances(): StoredExternalInstance[] {
    return this.database.prepare('SELECT value_json FROM external_knowledge_instances ORDER BY rowid').all().map(row => JSON.parse(String(row.value_json)) as StoredExternalInstance)
  }
  saveInstance(value: StoredExternalInstance): void {
    this.database.prepare('INSERT INTO external_knowledge_instances(id,value_json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(value.id, JSON.stringify(value))
  }
  deleteInstance(id: string): void {
    this.database.prepare('DELETE FROM external_knowledge_instances WHERE id=?').run(id)
  }
  getBinding(knowledgeBaseId: string): ExternalKnowledgeBinding | undefined {
    const row = this.database.prepare('SELECT value_json FROM external_knowledge_bindings WHERE knowledge_base_id=?').get(knowledgeBaseId)
    return row ? JSON.parse(String(row.value_json)) as ExternalKnowledgeBinding : undefined
  }
  hasBinding(knowledgeBaseId: string): boolean {
    return this.database.prepare('SELECT 1 FROM external_knowledge_bindings WHERE knowledge_base_id=?').get(knowledgeBaseId) !== undefined
  }
  getBindingsForInstance(instanceId: string): ExternalKnowledgeBinding[] {
    return this.database.prepare('SELECT value_json FROM external_knowledge_bindings WHERE instance_id=? ORDER BY rowid').all(instanceId).map(row => JSON.parse(String(row.value_json)) as ExternalKnowledgeBinding)
  }
  listBindings(): ExternalKnowledgeBinding[] {
    return this.database.prepare('SELECT value_json FROM external_knowledge_bindings ORDER BY rowid').all().map(row => JSON.parse(String(row.value_json)) as ExternalKnowledgeBinding)
  }
  saveBinding(value: ExternalKnowledgeBinding): void {
    this.database.prepare('INSERT INTO external_knowledge_bindings(knowledge_base_id,instance_id,remote_id,value_json) VALUES (?,?,?,?) ON CONFLICT(knowledge_base_id) DO UPDATE SET instance_id=excluded.instance_id,remote_id=excluded.remote_id,value_json=excluded.value_json').run(value.knowledgeBaseId,value.instanceId,value.remoteKnowledgeBaseId,JSON.stringify(value))
  }
}
