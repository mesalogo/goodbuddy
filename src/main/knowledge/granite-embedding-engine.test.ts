import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildGraniteInputBatch,
  GraniteEmbeddingEngine,
  poolGraniteClsEmbeddings,
  type GraniteSessionLike,
  type GraniteTokenizerLike
} from './granite-embedding-engine'

function tokenizer(encodings: Record<string, readonly number[]>): GraniteTokenizerLike {
  return {
    encode(text) {
      const ids = encodings[text]
      if (!ids) {
        throw new Error('Unexpected test text')
      }
      return {
        ids,
        attention_mask: ids.map(() => 1),
        token_type_ids: ids.map(() => 0)
      }
    },
    token_to_id: () => 7
  }
}

describe('GraniteEmbeddingEngine', () => {
  it('pads int64 model inputs and includes token types only when requested', () => {
    const batch = buildGraniteInputBatch({
      tokenizer: tokenizer({ short: [101, 9, 102], long: [101, 8, 6, 102] }),
      texts: ['short', 'long'],
      padTokenId: 7,
      includeTokenTypeIds: true
    })

    expect(batch.sequenceLength).toBe(4)
    expect([...batch.inputIds]).toEqual([
      101n, 9n, 102n, 7n, 101n, 8n, 6n, 102n
    ])
    expect([...batch.attentionMask]).toEqual([
      1n, 1n, 1n, 0n, 1n, 1n, 1n, 1n
    ])
    expect(batch.tokenTypeIds).toBeInstanceOf(BigInt64Array)
  })

  it('rejects tokenized input beyond the Granite context limit', () => {
    const ids = Array.from({ length: 32_769 }, () => 1)
    expect(() =>
      buildGraniteInputBatch({
        tokenizer: tokenizer({ oversized: ids }),
        texts: ['oversized'],
        padTokenId: 0,
        includeTokenTypeIds: false
      })
    ).toThrow(/32768 token limit/u)
  })

  it('selects last_hidden_state, CLS pools, and normalizes 384 dimensions', () => {
    const data = new Float32Array(2 * 384)
    data[0] = 3
    data[1] = 4
    data[384] = 100

    const vectors = poolGraniteClsEmbeddings({
      outputs: {
        other: {
          type: 'float32',
          dims: [1, 2, 384],
          data: new Float32Array(768).fill(1)
        },
        last_hidden_state: {
          type: 'float32',
          dims: [1, 2, 384],
          data
        }
      },
      outputNames: ['other', 'last_hidden_state'],
      batchSize: 1,
      sequenceLength: 2
    })

    expect(vectors[0]?.slice(0, 3)).toEqual([0.6, 0.8, 0])
    expect(vectors[0]).toHaveLength(384)
  })

  it('loads once and runs an injected ONNX session with int64 inputs', async () => {
    const run = vi.fn<GraniteSessionLike['run']>(async (feeds) => {
      const input = feeds.input_ids as {
        readonly dimensions: readonly [number, number]
      }
      const [batchSize, sequenceLength] = input.dimensions
      const output = new Float32Array(
        batchSize * sequenceLength * 384
      )
      output[0] = 1
      if (batchSize > 1) {
        output[sequenceLength * 384] = 1
      }
      return {
        last_hidden_state: {
          type: 'float32',
          dims: [batchSize, sequenceLength, 384],
          data: output
        }
      }
    })
    const session: GraniteSessionLike = {
      inputNames: ['input_ids', 'attention_mask'],
      outputNames: ['last_hidden_state'],
      run
    }
    const readFile = vi.fn(async (filePath: string) =>
      new TextEncoder().encode(
        filePath.endsWith('.onnx')
          ? 'model'
          : filePath.endsWith('tokenizer_config.json')
            ? '{"pad_token":"[PAD]"}'
            : '{}'
      )
    )
    const createTensor = vi.fn(
      (data: BigInt64Array, dimensions: readonly [number, number]) => ({
        data,
        dimensions,
        type: 'int64'
      })
    )
    const engine = new GraniteEmbeddingEngine({
      readFile,
      loadTokenizer: () => tokenizer({ a: [1, 2], b: [3] }),
      createSession: async () => session,
      createInt64Tensor: createTensor
    })

    const options = {
      modelDirectory: path.resolve('granite-model'),
      role: 'query' as const,
      signal: new AbortController().signal
    }
    const first = await engine.embed({ ...options, texts: ['a', 'b'] })
    await engine.embed({ ...options, texts: ['a'] })

    expect(first).toHaveLength(2)
    expect(readFile).toHaveBeenCalledTimes(3)
    expect(createTensor).toHaveBeenCalledTimes(4)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty('token_type_ids')
  })
})
