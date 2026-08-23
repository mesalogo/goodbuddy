import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-web/wasm'
import type {
  EmbeddingInferenceEngine,
  EmbeddingOnnxRuntime,
  EmbeddingTokenizer
} from './embedding-inference-worker'

const MODEL_FILE = 'model_quantized.onnx'
const TOKENIZER_FILE = 'tokenizer.json'
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json'
const MAX_TOKENS = 32_768
const EMBEDDING_DIMENSIONS = 384

type Encoding = {
  readonly ids: readonly number[]
  readonly attention_mask: readonly number[]
  readonly token_type_ids?: readonly number[]
}

export interface GraniteTokenizerLike {
  encode(text: string, options?: {
    readonly add_special_tokens?: boolean
    readonly return_token_type_ids?: boolean | null
  }): Encoding
  token_to_id(token: string): number | undefined
}

export interface GraniteTensorLike {
  readonly type: string
  readonly dims: readonly number[]
  readonly data: ArrayLike<number>
}

export interface GraniteSessionLike {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(
    feeds: Readonly<Record<string, unknown>>
  ): Promise<Readonly<Record<string, GraniteTensorLike>>>
  release?(): void
}

type LoadedEngine = {
  readonly tokenizer: GraniteTokenizerLike
  readonly padTokenId: number
  readonly session: GraniteSessionLike
}

export interface GraniteEmbeddingEngineDependencies {
  readonly loadTokenizer?: (
    tokenizerJson: unknown,
    tokenizerConfig: unknown
  ) => GraniteTokenizerLike
  readonly createSession?: (model: Uint8Array) => Promise<GraniteSessionLike>
  readonly createInt64Tensor?: (
    data: BigInt64Array,
    dimensions: readonly [number, number]
  ) => unknown
  readonly readFile?: (filePath: string) => Promise<Uint8Array>
}

type TokenizedBatch = {
  readonly batchSize: number
  readonly sequenceLength: number
  readonly inputIds: BigInt64Array
  readonly attentionMask: BigInt64Array
  readonly tokenTypeIds?: BigInt64Array
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('Embedding inference was cancelled')
  }
}

function asJsonObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function resolvePadTokenId(
  tokenizer: GraniteTokenizerLike,
  rawConfig: unknown
): number {
  const config = asJsonObject(rawConfig, TOKENIZER_CONFIG_FILE)
  const configuredId = config.pad_token_id
  if (
    typeof configuredId === 'number' &&
    Number.isSafeInteger(configuredId) &&
    configuredId >= 0
  ) {
    return configuredId
  }
  if (typeof config.pad_token === 'string') {
    const tokenId = tokenizer.token_to_id(config.pad_token)
    if (tokenId !== undefined) {
      return tokenId
    }
  }
  throw new Error('Tokenizer configuration does not define a valid pad token')
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error(`${name} is not valid JSON`)
  }
}

export function buildGraniteInputBatch(options: {
  readonly tokenizer: GraniteTokenizerLike
  readonly texts: readonly string[]
  readonly padTokenId: number
  readonly includeTokenTypeIds: boolean
}): TokenizedBatch {
  if (options.texts.length === 0) {
    throw new RangeError('At least one text is required')
  }
  const encodings = options.texts.map((text) =>
    options.tokenizer.encode(text, {
      add_special_tokens: true,
      return_token_type_ids: options.includeTokenTypeIds
    })
  )
  const sequenceLength = Math.max(...encodings.map(({ ids }) => ids.length))
  if (sequenceLength > MAX_TOKENS) {
    throw new RangeError(
      `Embedding input exceeds the ${MAX_TOKENS} token limit`
    )
  }
  if (sequenceLength < 1) {
    throw new RangeError('Tokenizer produced an empty input')
  }

  const itemCount = options.texts.length * sequenceLength
  const inputIds = new BigInt64Array(itemCount)
  inputIds.fill(BigInt(options.padTokenId))
  const attentionMask = new BigInt64Array(itemCount)
  const tokenTypeIds = options.includeTokenTypeIds
    ? new BigInt64Array(itemCount)
    : undefined

  for (const [batchIndex, encoding] of encodings.entries()) {
    if (
      encoding.attention_mask.length !== encoding.ids.length ||
      (options.includeTokenTypeIds &&
        encoding.token_type_ids !== undefined &&
        encoding.token_type_ids.length !== encoding.ids.length)
    ) {
      throw new Error('Tokenizer produced inconsistent input lengths')
    }
    const offset = batchIndex * sequenceLength
    for (let index = 0; index < encoding.ids.length; index += 1) {
      const tokenId = encoding.ids[index]
      const mask = encoding.attention_mask[index]
      if (
        tokenId === undefined ||
        mask === undefined ||
        !Number.isSafeInteger(tokenId) ||
        !Number.isSafeInteger(mask)
      ) {
        throw new Error('Tokenizer produced an invalid token')
      }
      inputIds[offset + index] = BigInt(tokenId)
      attentionMask[offset + index] = BigInt(mask)
      if (tokenTypeIds) {
        tokenTypeIds[offset + index] = BigInt(
          encoding.token_type_ids?.[index] ?? 0
        )
      }
    }
  }

  return {
    batchSize: options.texts.length,
    sequenceLength,
    inputIds,
    attentionMask,
    tokenTypeIds
  }
}

export function poolGraniteClsEmbeddings(options: {
  readonly outputs: Readonly<Record<string, GraniteTensorLike>>
  readonly outputNames: readonly string[]
  readonly batchSize: number
  readonly sequenceLength: number
}): number[][] {
  const preferred = options.outputs.last_hidden_state
  const output =
    preferred?.dims.length === 3 &&
    (preferred.type === 'float32' || preferred.type === 'float64')
      ? preferred
      : options.outputNames
          .map((name) => options.outputs[name])
          .find(
            (candidate) =>
              candidate?.dims.length === 3 &&
              (candidate.type === 'float32' ||
                candidate.type === 'float64')
          )
  if (!output) {
    throw new Error('ONNX model did not return a rank-3 float output')
  }
  const [batchSize, sequenceLength, dimensions] = output.dims
  if (
    batchSize !== options.batchSize ||
    sequenceLength !== options.sequenceLength ||
    dimensions !== EMBEDDING_DIMENSIONS ||
    output.data.length !== batchSize * sequenceLength * dimensions
  ) {
    throw new Error('ONNX embedding output has invalid dimensions')
  }

  const vectors: number[][] = []
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
    const offset = batchIndex * sequenceLength * dimensions
    const vector = Array.from(
      { length: dimensions },
      (_, index) => output.data[offset + index] ?? Number.NaN
    )
    const magnitude = Math.hypot(...vector)
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      throw new Error('ONNX embedding output has an invalid CLS vector')
    }
    vectors.push(vector.map((component) => component / magnitude))
  }
  return vectors
}

export class GraniteEmbeddingEngine implements EmbeddingInferenceEngine {
  readonly tokenizer: EmbeddingTokenizer
  readonly onnx: EmbeddingOnnxRuntime

  private readonly dependencies: Required<GraniteEmbeddingEngineDependencies>
  private loadTask?: Promise<LoadedEngine>
  private modelDirectory?: string
  private disposed = false

  constructor(dependencies: GraniteEmbeddingEngineDependencies = {}) {
    this.dependencies = {
      loadTokenizer:
        dependencies.loadTokenizer ??
        ((tokenizerJson, tokenizerConfig) =>
          new Tokenizer(
            asJsonObject(tokenizerJson, TOKENIZER_FILE),
            asJsonObject(tokenizerConfig, TOKENIZER_CONFIG_FILE)
          )),
      createSession:
        dependencies.createSession ??
        (async (model) =>
          (await ort.InferenceSession.create(model, {
            executionProviders: ['wasm']
          })) as GraniteSessionLike),
      createInt64Tensor:
        dependencies.createInt64Tensor ??
        ((data, dimensions) => new ort.Tensor('int64', data, dimensions)),
      readFile:
        dependencies.readFile ??
        (async (filePath) => new Uint8Array(await readFile(filePath)))
    }
    this.tokenizer = {
      tokenize: async ({ texts, signal }) => {
        const loaded = await this.load(this.requiredModelDirectory(), signal)
        return buildGraniteInputBatch({
          tokenizer: loaded.tokenizer,
          texts,
          padTokenId: loaded.padTokenId,
          includeTokenTypeIds:
            loaded.session.inputNames.includes('token_type_ids')
        })
      }
    }
    this.onnx = {
      run: async ({ modelDirectory, inputs, signal }) => {
        const loaded = await this.load(modelDirectory, signal)
        abortIfRequested(signal)
        const output = await loaded.session.run(
          inputs as Readonly<Record<string, unknown>>
        )
        abortIfRequested(signal)
        return output
      }
    }
  }

  async embed(options: Parameters<EmbeddingInferenceEngine['embed']>[0]) {
    void options.role
    const loaded = await this.load(options.modelDirectory, options.signal)
    abortIfRequested(options.signal)
    const batch = buildGraniteInputBatch({
      tokenizer: loaded.tokenizer,
      texts: options.texts,
      padTokenId: loaded.padTokenId,
      includeTokenTypeIds:
        loaded.session.inputNames.includes('token_type_ids')
    })
    abortIfRequested(options.signal)
    const dimensions: [number, number] = [
      batch.batchSize,
      batch.sequenceLength
    ]
    const feeds: Record<string, unknown> = {
      input_ids: this.dependencies.createInt64Tensor(
        batch.inputIds,
        dimensions
      ),
      attention_mask: this.dependencies.createInt64Tensor(
        batch.attentionMask,
        dimensions
      )
    }
    if (batch.tokenTypeIds) {
      feeds.token_type_ids = this.dependencies.createInt64Tensor(
        batch.tokenTypeIds,
        dimensions
      )
    }
    const outputs = await loaded.session.run(feeds)
    abortIfRequested(options.signal)
    return poolGraniteClsEmbeddings({
      outputs,
      outputNames: loaded.session.outputNames,
      batchSize: batch.batchSize,
      sequenceLength: batch.sequenceLength
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const loaded = await this.loadTask?.catch(() => undefined)
    loaded?.session.release?.()
  }

  private requiredModelDirectory(): string {
    if (!this.modelDirectory) {
      throw new Error('The Granite model has not been selected')
    }
    return this.modelDirectory
  }

  private load(
    modelDirectory: string,
    signal: AbortSignal
  ): Promise<LoadedEngine> {
    abortIfRequested(signal)
    if (this.disposed) {
      throw new Error('Granite embedding engine is disposed')
    }
    const normalizedDirectory = path.normalize(modelDirectory)
    if (
      this.modelDirectory &&
      this.modelDirectory !== normalizedDirectory
    ) {
      throw new Error('Granite embedding engine cannot change model directory')
    }
    this.modelDirectory = normalizedDirectory
    this.loadTask ??= this.loadFiles(normalizedDirectory)
    return this.loadTask.then((loaded) => {
      abortIfRequested(signal)
      return loaded
    })
  }

  private async loadFiles(modelDirectory: string): Promise<LoadedEngine> {
    const [tokenizerBytes, tokenizerConfigBytes, modelBytes] =
      await Promise.all([
        this.dependencies.readFile(
          path.join(modelDirectory, TOKENIZER_FILE)
        ),
        this.dependencies.readFile(
          path.join(modelDirectory, TOKENIZER_CONFIG_FILE)
        ),
        this.dependencies.readFile(path.join(modelDirectory, MODEL_FILE))
      ])
    const tokenizerJson = parseJson(tokenizerBytes, TOKENIZER_FILE)
    const tokenizerConfig = parseJson(
      tokenizerConfigBytes,
      TOKENIZER_CONFIG_FILE
    )
    const tokenizer = this.dependencies.loadTokenizer(
      tokenizerJson,
      tokenizerConfig
    )
    const [padTokenId, session] = await Promise.all([
      Promise.resolve(resolvePadTokenId(tokenizer, tokenizerConfig)),
      this.dependencies.createSession(modelBytes)
    ])
    return { tokenizer, padTokenId, session }
  }
}
