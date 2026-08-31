export type TextModelRequestPolicy = {
  protocol:
    | 'anthropic-messages'
    | 'openai-chat-completions'
    | 'openai-responses'
  model: string
  supportsImageInput: boolean
}

export class ModelRequestPolicyError extends Error {
  constructor() {
    super('Model request does not match the selected text model policy')
    this.name = 'ModelRequestPolicyError'
  }
}

export function assertTextModelRequestPolicy(
  policy: TextModelRequestPolicy,
  value: unknown
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.model !== policy.model) {
    throw new ModelRequestPolicyError()
  }
  if (!policy.supportsImageInput && containsImageInput(value)) {
    throw new ModelRequestPolicyError()
  }
  if (
    value.background === true ||
    value.store === true ||
    value.web_search_options !== undefined ||
    value.mcp_servers !== undefined ||
    value.conversation !== undefined ||
    value.previous_response_id !== undefined ||
    (value.service_tier !== undefined &&
      value.service_tier !== 'auto' &&
      value.service_tier !== 'default') ||
    (Array.isArray(value.modalities) &&
      value.modalities.some((modality) => modality !== 'text'))
  ) {
    throw new ModelRequestPolicyError()
  }
  if (
    Array.isArray(value.include) &&
    value.include.some(
      (item) =>
        typeof item !== 'string' ||
        /(?:web_search|file_search|computer|code_interpreter|mcp|image_generation)/iu.test(
          item
        )
    )
  ) {
    throw new ModelRequestPolicyError()
  }
  if (value.tools === undefined) {
    return
  }
  if (!Array.isArray(value.tools)) {
    throw new ModelRequestPolicyError()
  }
  for (const tool of value.tools) {
    if (!isRecord(tool)) {
      throw new ModelRequestPolicyError()
    }
    if (policy.protocol === 'anthropic-messages') {
      if (tool.type !== undefined && tool.type !== 'custom') {
        throw new ModelRequestPolicyError()
      }
    } else if (tool.type !== 'function') {
      throw new ModelRequestPolicyError()
    }
  }
}

function containsImageInput(value: unknown): boolean {
  const maximumNodes = 100_000
  const pending: unknown[] = [value]
  let visited = 0
  while (pending.length > 0) {
    visited += 1
    if (visited > maximumNodes) {
      throw new ModelRequestPolicyError()
    }
    const current = pending.pop()
    if (Array.isArray(current)) {
      if (visited + pending.length + current.length > maximumNodes) {
        throw new ModelRequestPolicyError()
      }
      pending.push(...current)
      continue
    }
    if (!isRecord(current)) {
      continue
    }
    if (
      current.type === 'image' ||
      current.type === 'image_url' ||
      current.type === 'input_image'
    ) {
      return true
    }
    const values = Object.values(current)
    if (visited + pending.length + values.length > maximumNodes) {
      throw new ModelRequestPolicyError()
    }
    pending.push(...values)
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}
