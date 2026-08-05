import { randomBytes } from 'node:crypto'

export type AtspiNativeReference = string

export type AtspiRect = {
  x: number
  y: number
  width: number
  height: number
}

export type AtspiRawNode = {
  nativeReference: AtspiNativeReference
  owner: string
  window: string
  role?: string
  name?: string
  states?: string[]
  actions?: string[]
  text?: string
  value?: number
  geometry?: AtspiRect
  protected?: boolean
  password?: boolean
}

export interface AtspiTransport {
  readNode(
    reference: AtspiNativeReference,
    signal: AbortSignal
  ): Promise<AtspiRawNode>
  listChildren(
    reference: AtspiNativeReference,
    signal: AbortSignal
  ): Promise<AtspiNativeReference[]>
  invoke(
    reference: AtspiNativeReference,
    action: string,
    signal: AbortSignal
  ): Promise<boolean>
  setText(
    reference: AtspiNativeReference,
    text: string,
    signal: AbortSignal
  ): Promise<boolean>
  select(
    reference: AtspiNativeReference,
    signal: AbortSignal
  ): Promise<boolean>
  focus(
    reference: AtspiNativeReference,
    signal: AbortSignal
  ): Promise<boolean>
}

export type SemanticElement = {
  ref: string
  role: string
  name: string
  states: string[]
  actions: string[]
  text?: string
  value?: number
  geometry?: AtspiRect
  protected: boolean
  children: SemanticElement[]
}

export type SemanticTree = {
  generation: number
  truncated: boolean
  root: SemanticElement
}

export type AtspiSemanticCoreOptions = {
  now?: () => number
  createToken?: () => string
  referenceTtlMs?: number
  maximumNodes?: number
  maximumDepth?: number
  maximumChildrenPerNode?: number
  maximumTextLength?: number
  maximumReferences?: number
}

type StoredReference = {
  nativeReference: AtspiNativeReference
  owner: string
  window: string
  generation: number
  expiresAt: number
  protected: boolean
  actions: Set<string>
}

const cleanText = (
  value: string | undefined,
  maximumLength: number,
  fallback = ''
): string => {
  if (!value) {
    return fallback
  }
  const clean = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
  return clean.slice(0, maximumLength) || fallback
}

const normalizeIdentifier = (
  value: string | undefined,
  fallback: string
): string => {
  const normalized = cleanText(value, 64, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

const normalizeGeometry = (geometry: AtspiRect | undefined): AtspiRect | undefined => {
  if (
    !geometry ||
    !Number.isFinite(geometry.x) ||
    !Number.isFinite(geometry.y) ||
    !Number.isFinite(geometry.width) ||
    !Number.isFinite(geometry.height) ||
    geometry.width < 0 ||
    geometry.height < 0
  ) {
    return undefined
  }
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height
  }
}

const sensitiveRoles = new Set([
  'password-text',
  'password',
  'secret',
  'credential'
])

export class AtspiSemanticCore {
  private readonly now: () => number
  private readonly createToken: () => string
  private readonly referenceTtlMs: number
  private readonly maximumNodes: number
  private readonly maximumDepth: number
  private readonly maximumChildrenPerNode: number
  private readonly maximumTextLength: number
  private readonly maximumReferences: number
  private readonly references = new Map<string, StoredReference>()
  private generation = 0

  constructor(
    private readonly transport: AtspiTransport,
    options: AtspiSemanticCoreOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.createToken =
      options.createToken ?? (() => randomBytes(24).toString('base64url'))
    this.referenceTtlMs = options.referenceTtlMs ?? 3_000
    this.maximumNodes = options.maximumNodes ?? 500
    this.maximumDepth = options.maximumDepth ?? 24
    this.maximumChildrenPerNode = options.maximumChildrenPerNode ?? 100
    this.maximumTextLength = options.maximumTextLength ?? 4_096
    this.maximumReferences =
      options.maximumReferences ?? this.maximumNodes
    if (
      !Number.isSafeInteger(this.maximumReferences) ||
      this.maximumReferences < 1 ||
      this.maximumReferences > 10_000
    ) {
      throw new Error('Invalid semantic reference capacity')
    }
  }

  async snapshot(
    rootReference: AtspiNativeReference,
    signal: AbortSignal
  ): Promise<SemanticTree> {
    this.generation += 1
    const snapshotGeneration = this.generation
    this.pruneReferences()
    const visited = new Set<AtspiNativeReference>()
    let remaining = Math.min(
      this.maximumNodes,
      this.maximumReferences
    )
    let truncated = false

    const visit = async (
      reference: AtspiNativeReference,
      depth: number
    ): Promise<SemanticElement | undefined> => {
      if (
        signal.aborted ||
        visited.has(reference) ||
        depth > this.maximumDepth ||
        remaining <= 0
      ) {
        truncated = true
        return undefined
      }
      visited.add(reference)
      remaining -= 1
      let raw: AtspiRawNode
      try {
        raw = await this.transport.readNode(reference, signal)
      } catch {
        throw new Error('Accessibility element could not be read')
      }
      if (snapshotGeneration !== this.generation) {
        throw new Error('Accessibility snapshot was superseded')
      }
      const role = normalizeIdentifier(raw.role, 'unknown')
      const isProtected =
        raw.protected === true ||
        raw.password === true ||
        sensitiveRoles.has(role)
      const actions = [
        ...new Set(
          (raw.actions ?? []).map((action) =>
            normalizeIdentifier(action, 'action')
          )
        )
      ].slice(0, 32)
      const states = [
        ...new Set(
          (raw.states ?? []).map((state) =>
            normalizeIdentifier(state, 'state')
          )
        )
      ].slice(0, 64)
      const opaqueReference = this.createToken()
      if (
        !/^[A-Za-z0-9_-]{5,256}$/.test(opaqueReference) ||
        this.references.has(opaqueReference)
      ) {
        throw new Error('Opaque accessibility reference creation failed')
      }
      while (this.references.size >= this.maximumReferences) {
        const oldest = this.references.keys().next().value
        if (oldest === undefined) {
          break
        }
        this.references.delete(oldest)
        truncated = true
      }
      this.references.set(opaqueReference, {
        nativeReference: raw.nativeReference,
        owner: raw.owner,
        window: raw.window,
        generation: snapshotGeneration,
        expiresAt: this.now() + this.referenceTtlMs,
        protected: isProtected,
        actions: new Set(actions)
      })
      const element: SemanticElement = {
        ref: opaqueReference,
        role,
        name: isProtected
          ? '受保护内容'
          : cleanText(raw.name, 256, role),
        states,
        actions: isProtected ? [] : actions,
        protected: isProtected,
        children: []
      }
      if (!isProtected) {
        const text = cleanText(raw.text, this.maximumTextLength)
        if (text) {
          element.text = text
        }
        if (raw.value !== undefined && Number.isFinite(raw.value)) {
          element.value = raw.value
        }
      }
      const geometry = normalizeGeometry(raw.geometry)
      if (geometry) {
        element.geometry = geometry
      }

      if (depth === this.maximumDepth || remaining <= 0) {
        truncated = true
        return element
      }
      let children: AtspiNativeReference[]
      try {
        children = await this.transport.listChildren(reference, signal)
      } catch {
        throw new Error('Accessibility children could not be read')
      }
      if (snapshotGeneration !== this.generation) {
        throw new Error('Accessibility snapshot was superseded')
      }
      if (children.length > this.maximumChildrenPerNode) {
        truncated = true
      }
      for (const child of children.slice(0, this.maximumChildrenPerNode)) {
        const normalized = await visit(child, depth + 1)
        if (normalized) {
          element.children.push(normalized)
        }
      }
      return element
    }

    const root = await visit(rootReference, 0)
    if (snapshotGeneration !== this.generation) {
      throw new Error('Accessibility snapshot was superseded')
    }
    if (!root) {
      throw new Error('Accessibility tree root is unavailable')
    }
    return {
      generation: snapshotGeneration,
      truncated,
      root
    }
  }

  invalidateRegistryOwner(): void {
    this.generation += 1
    this.references.clear()
  }

  invalidateOwner(owner: string): void {
    for (const [reference, stored] of this.references) {
      if (stored.owner === owner) {
        this.references.delete(reference)
      }
    }
  }

  invalidateWindow(owner: string, window: string): void {
    for (const [reference, stored] of this.references) {
      if (stored.owner === owner && stored.window === window) {
        this.references.delete(reference)
      }
    }
  }

  async invoke(
    reference: string,
    action: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = this.resolve(reference)
    const normalizedAction = normalizeIdentifier(action, 'action')
    if (!stored.actions.has(normalizedAction)) {
      throw new Error('Semantic action is unavailable')
    }
    try {
      return await this.transport.invoke(
        stored.nativeReference,
        normalizedAction,
        signal
      )
    } catch {
      throw new Error('Semantic action failed')
    }
  }

  async setText(
    reference: string,
    text: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = this.resolve(reference)
    if (text.length > this.maximumTextLength) {
      throw new Error('Text exceeds the semantic input limit')
    }
    try {
      return await this.transport.setText(stored.nativeReference, text, signal)
    } catch {
      throw new Error('Semantic text update failed')
    }
  }

  async select(
    reference: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = this.resolve(reference)
    try {
      return await this.transport.select(stored.nativeReference, signal)
    } catch {
      throw new Error('Semantic selection failed')
    }
  }

  async focus(
    reference: string,
    signal: AbortSignal
  ): Promise<boolean> {
    const stored = this.resolve(reference)
    try {
      return await this.transport.focus(stored.nativeReference, signal)
    } catch {
      throw new Error('Semantic focus failed')
    }
  }

  private resolve(reference: string): StoredReference {
    this.pruneReferences()
    const stored = this.references.get(reference)
    if (
      !stored ||
      stored.generation !== this.generation ||
      this.now() >= stored.expiresAt
    ) {
      this.references.delete(reference)
      throw new Error('Semantic element is stale')
    }
    if (stored.protected) {
      throw new Error('Protected semantic element cannot be controlled')
    }
    return stored
  }

  private pruneReferences(): void {
    const timestamp = this.now()
    for (const [reference, stored] of this.references) {
      if (
        stored.generation !== this.generation ||
        timestamp >= stored.expiresAt
      ) {
        this.references.delete(reference)
      }
    }
  }
}
