import { z } from 'zod'

const id = z.string().trim().min(1).max(512)
export const externalKnowledgeProviderSchema = z.enum(['dify', 'fastgpt', 'ragflow'])
export type ExternalKnowledgeProvider = z.infer<typeof externalKnowledgeProviderSchema>
export const externalKnowledgeCommonConfigSchema = z.object({
  resultLimit: z.number().int().min(1).max(20).default(6),
  requestTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
  maxSnippetCharacters: z.number().int().min(100).max(8000).default(4000)
}).strict()
export type ExternalKnowledgeCommonConfig = z.infer<typeof externalKnowledgeCommonConfigSchema>
const retrievalModel = z.object({
  search_method: z.enum(['keyword_search', 'semantic_search', 'full_text_search', 'hybrid_search']),
  reranking_enable: z.boolean(), top_k: z.number().int().min(1).max(20),
  score_threshold_enabled: z.boolean(), score_threshold: z.number().min(0).max(1).optional(),
  reranking_mode: z.enum(['reranking_model', 'weighted_score']).optional(),
  reranking_model: z.object({reranking_provider_name: id, reranking_model_name: id}).strict().optional(),
  weights: z.object({weight_type: z.literal('customized'), vector_setting: z.object({vector_weight: z.number().min(0).max(1), embedding_provider_name: id, embedding_model_name: id}).strict(), keyword_setting: z.object({keyword_weight: z.number().min(0).max(1)}).strict()}).strict().optional()
}).strict().superRefine((value, ctx) => {
  if (value.score_threshold_enabled && value.score_threshold === undefined) ctx.addIssue({code:'custom',message:'Score threshold is required'})
  if (value.reranking_enable && (!value.reranking_mode || (value.reranking_mode === 'reranking_model' ? !value.reranking_model : !value.weights))) ctx.addIssue({code:'custom',message:'Complete reranking configuration is required'})
})
export const externalKnowledgeProviderConfigSchema = z.union([
  z.object({provider:z.literal('dify'),useDatasetDefaults:z.literal(true)}).strict(),
  z.object({provider:z.literal('dify'),useDatasetDefaults:z.literal(false),retrievalModel}).strict(),
  z.object({provider:z.literal('fastgpt'),searchMode:z.enum(['embedding','fullTextRecall','mixedRecall']),tokenLimit:z.number().int().min(1).max(30000),similarity:z.number().min(0).max(1),usingRerank:z.boolean()}).strict(),
  z.object({provider:z.literal('ragflow'),similarityThreshold:z.number().min(0).max(1),vectorSimilarityWeight:z.number().min(0).max(1),knnTopK:z.number().int().min(1).max(2048),useKg:z.boolean(),includeKnowledgeCompilation:z.boolean()}).strict()
])
export type ExternalKnowledgeProviderConfig = z.infer<typeof externalKnowledgeProviderConfigSchema>
export const externalKnowledgeInstanceSaveInputSchema = z.object({
  id:id.optional(),name:z.string().trim().min(1).max(512),provider:externalKnowledgeProviderSchema,
  baseUrl:z.string().trim().url().max(8192).refine((value)=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash},'Invalid service URL'),
  enabled:z.boolean(),credential:z.discriminatedUnion('action',[z.object({action:z.literal('keep')}).strict(),z.object({action:z.literal('clear')}).strict(),z.object({action:z.literal('replace'),value:z.string().trim().min(1).max(16384)}).strict()])
}).strict()
export type ExternalKnowledgeInstanceSaveInput = z.infer<typeof externalKnowledgeInstanceSaveInputSchema>
export const externalKnowledgeInstanceInputSchema = z.object({instanceId:id}).strict()
export const externalKnowledgeInstanceEnabledInputSchema = externalKnowledgeInstanceInputSchema.extend({enabled:z.boolean()})
export const externalKnowledgeCatalogListInputSchema = externalKnowledgeInstanceInputSchema.extend({page:z.number().int().min(1).max(500).optional(),pageSize:z.number().int().min(1).max(100).optional(),parentId:id.nullable().optional(),search:z.string().trim().max(512).optional()})
export const externalKnowledgeCatalogGetInputSchema = externalKnowledgeInstanceInputSchema.extend({remoteKnowledgeBaseId:id})
export const externalKnowledgeRetrievalInputSchema = externalKnowledgeCatalogGetInputSchema.extend({commonConfig:externalKnowledgeCommonConfigSchema,providerConfig:externalKnowledgeProviderConfigSchema,query:z.string().trim().min(1).max(4000)})
export type ExternalKnowledgeRetrievalInput = z.infer<typeof externalKnowledgeRetrievalInputSchema>
export const externalKnowledgeBindingTestInputSchema = externalKnowledgeCatalogGetInputSchema.extend({commonConfig:externalKnowledgeCommonConfigSchema,providerConfig:externalKnowledgeProviderConfigSchema,testQuery:z.string().trim().min(1).max(4000)})
export const externalKnowledgeBindingSaveInputSchema = externalKnowledgeBindingTestInputSchema.extend({name:z.string().trim().min(1).max(512),description:z.string().max(4000).optional(),remoteName:z.string().trim().min(1).max(512)})
export const externalKnowledgeBindingUpdateInputSchema = externalKnowledgeBindingSaveInputSchema.extend({knowledgeBaseId:id})
export type ExternalKnowledgeBindingTestInput = z.infer<typeof externalKnowledgeBindingTestInputSchema>
export type ExternalKnowledgeBindingSaveInput = z.infer<typeof externalKnowledgeBindingSaveInputSchema>
export type ExternalKnowledgeInstanceSummary = {id:string;name:string;provider:ExternalKnowledgeProvider;baseUrl:string;enabled:boolean;credentialStatus:'configured'|'missing'|'unavailable';probeStatus:'untested'|'catalog-ready'|'list-restricted'|'auth-failed'|'unreachable'|'failed';bindingCount:number;lastTestedAt?:string;lastErrorCode?:string}
export type ExternalKnowledgeCatalogItem = {id:string;name:string;description?:string;kind?:'dataset'|'folder';graphEnabled?:boolean;knowledgeCompilationEnabled?:boolean}
export type ExternalKnowledgeCatalogPage = {items:ExternalKnowledgeCatalogItem[];total?:number;hasMore:boolean}
export type ExternalKnowledgeRemoteResult = {documentTitle:string;sourceDisplayName:string;snippet:string;providerScore?:number;providerScores?:{type:string;value:number;index?:number}[];remoteDocumentId?:string;remoteChunkId?:string;location?:string}
export type ExternalKnowledgeTestResult = {results:ExternalKnowledgeRemoteResult[];durationMs:number}
export type ExternalKnowledgeBinding = {knowledgeBaseId:string;instanceId:string;provider:ExternalKnowledgeProvider;remoteKnowledgeBaseId:string;remoteName:string;commonConfig:ExternalKnowledgeCommonConfig;providerConfig:ExternalKnowledgeProviderConfig;lastVerifiedAt:string}
export const externalKnowledgeLocatorSchema = z.object({kind:z.literal('external'),provider:externalKnowledgeProviderSchema,instanceId:id,remoteKnowledgeBaseId:id,remoteDocumentId:id.optional(),remoteChunkId:id.optional(),providerScore:z.number().finite().optional(),providerScores:z.array(z.object({type:z.string().max(128),value:z.number().finite(),index:z.number().int().optional()}).strict()).max(20).optional(),location:z.string().max(8192).optional(),sourceUrl:z.string().max(8192).optional()}).strict()
export type ExternalKnowledgeLocator = z.infer<typeof externalKnowledgeLocatorSchema>
