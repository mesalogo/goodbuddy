import { describe, expect, it, vi } from 'vitest'
import {
  AtspiSemanticCore,
  type AtspiRawNode,
  type AtspiTransport
} from './atspi-semantic-core'

const transportFor = (
  nodes: Record<string, AtspiRawNode>,
  children: Record<string, string[]>
): AtspiTransport => ({
  readNode: vi.fn(async (reference) => {
    const node = nodes[reference]
    if (!node) {
      throw new Error('missing node')
    }
    return node
  }),
  listChildren: vi.fn(async (reference) => children[reference] ?? []),
  invoke: vi.fn(async () => true),
  setText: vi.fn(async () => true),
  select: vi.fn(async () => true),
  focus: vi.fn(async () => true)
})

const node = (
  nativeReference: string,
  overrides: Partial<AtspiRawNode> = {}
): AtspiRawNode => ({
  nativeReference,
  owner: 'private-owner',
  window: 'private-window',
  role: 'push button',
  name: 'Action',
  states: ['enabled', 'enabled'],
  actions: ['Click'],
  geometry: { x: -10, y: 20, width: 100, height: 30 },
  ...overrides
})

describe('AtspiSemanticCore', () => {
  it('traverses a cyclic tree safely and returns only normalized opaque data', async () => {
    const transport = transportFor(
      {
        '/raw/root': node('/raw/root', {
          role: 'Application',
          name: '  Demo\u0000 app  '
        }),
        '/raw/child': node('/raw/child')
      },
      {
        '/raw/root': ['/raw/child'],
        '/raw/child': ['/raw/root']
      }
    )
    let token = 0
    const core = new AtspiSemanticCore(transport, {
      createToken: () => `opaque-${++token}`
    })
    const tree = await core.snapshot('/raw/root', new AbortController().signal)
    const serialized = JSON.stringify(tree)

    expect(tree.truncated).toBe(true)
    expect(tree.root).toMatchObject({
      ref: 'opaque-1',
      role: 'application',
      name: 'Demo app',
      states: ['enabled'],
      children: [
        {
          ref: 'opaque-2',
          role: 'push-button',
          actions: ['click'],
          children: []
        }
      ]
    })
    expect(serialized).not.toContain('/raw/')
    expect(serialized).not.toContain('private-owner')
    expect(serialized).not.toContain('private-window')
  })

  it('bounds node count, depth, children, text, and invalid geometry', async () => {
    const transport = transportFor(
      {
        root: node('root', {
          text: 'abcdef',
          geometry: { x: 0, y: 0, width: -1, height: 10 }
        }),
        one: node('one'),
        two: node('two')
      },
      { root: ['one', 'two'] }
    )
    let token = 0
    const core = new AtspiSemanticCore(transport, {
      createToken: () => `ref-${++token}`,
      maximumNodes: 2,
      maximumChildrenPerNode: 1,
      maximumTextLength: 3
    })
    const tree = await core.snapshot('root', new AbortController().signal)

    expect(tree.truncated).toBe(true)
    expect(tree.root.text).toBe('abc')
    expect(tree.root.geometry).toBeUndefined()
    expect(tree.root.children).toHaveLength(1)
  })

  it('redacts and refuses protected and password elements', async () => {
    const transport = transportFor(
      {
        password: node('password', {
          role: 'password text',
          name: 'bank password',
          text: 'hunter2',
          value: 123,
          password: true
        })
      },
      {}
    )
    const core = new AtspiSemanticCore(transport, {
      createToken: () => 'protected-ref'
    })
    const tree = await core.snapshot(
      'password',
      new AbortController().signal
    )

    expect(tree.root).toMatchObject({
      ref: 'protected-ref',
      name: '受保护内容',
      actions: [],
      protected: true
    })
    expect(tree.root.text).toBeUndefined()
    expect(tree.root.value).toBeUndefined()
    await expect(
      core.focus('protected-ref', new AbortController().signal)
    ).rejects.toThrow('Protected')
    expect(transport.focus).not.toHaveBeenCalled()
  })

  it('routes semantic operations and rejects stale or unsupported references', async () => {
    let now = 10
    let token = 0
    const transport = transportFor(
      {
        first: node('first', { owner: 'owner-a', window: 'window-a' }),
        second: node('second', { owner: 'owner-b', window: 'window-b' })
      },
      {}
    )
    const core = new AtspiSemanticCore(transport, {
      now: () => now,
      referenceTtlMs: 50,
      createToken: () => `ref-${++token}`
    })
    await core.snapshot('first', new AbortController().signal)
    await expect(
      core.invoke('ref-1', 'CLICK', new AbortController().signal)
    ).resolves.toBe(true)
    await expect(
      core.setText('ref-1', 'new text', new AbortController().signal)
    ).resolves.toBe(true)
    await expect(
      core.select('ref-1', new AbortController().signal)
    ).resolves.toBe(true)
    await expect(
      core.invoke('ref-1', 'delete', new AbortController().signal)
    ).rejects.toThrow('unavailable')

    core.invalidateWindow('owner-a', 'window-a')
    await expect(
      core.focus('ref-1', new AbortController().signal)
    ).rejects.toThrow('stale')

    await core.snapshot('second', new AbortController().signal)
    core.invalidateOwner('owner-b')
    await expect(
      core.focus('ref-2', new AbortController().signal)
    ).rejects.toThrow('stale')

    await core.snapshot('first', new AbortController().signal)
    now = 60
    await expect(
      core.focus('ref-3', new AbortController().signal)
    ).rejects.toThrow('stale')

    now = 10
    await core.snapshot('first', new AbortController().signal)
    core.invalidateRegistryOwner()
    await expect(
      core.focus('ref-4', new AbortController().signal)
    ).rejects.toThrow('stale')
  })

  it('invalidates every reference from snapshot N when snapshot N+1 starts', async () => {
    let token = 0
    const core = new AtspiSemanticCore(
      transportFor(
        {
          first: node('first'),
          second: node('second')
        },
        {}
      ),
      { createToken: () => `generation-ref-${++token}` }
    )

    await core.snapshot('first', new AbortController().signal)
    await core.snapshot('second', new AbortController().signal)

    await expect(
      core.focus('generation-ref-1', new AbortController().signal)
    ).rejects.toThrow('stale')
    await expect(
      core.focus('generation-ref-2', new AbortController().signal)
    ).resolves.toBe(true)
  })

  it('keeps the opaque reference registry hard bounded across snapshots', async () => {
    let token = 0
    const core = new AtspiSemanticCore(
      transportFor(
        {
          root: node('root'),
          child: node('child'),
          extra: node('extra')
        },
        { root: ['child', 'extra'] }
      ),
      {
        maximumReferences: 2,
        createToken: () => `bounded-ref-${++token}`
      }
    )

    for (let index = 0; index < 50; index += 1) {
      const tree = await core.snapshot(
        'root',
        new AbortController().signal
      )
      expect(tree.truncated).toBe(true)
      expect(
        (
          core as unknown as {
            references: Map<string, unknown>
          }
        ).references.size
      ).toBeLessThanOrEqual(2)
    }
  })

  it('does not surface raw transport errors or accept duplicate opaque tokens', async () => {
    const failedTransport = transportFor({ root: node('root') }, {})
    failedTransport.readNode = vi.fn(async () => {
      throw new Error('private bus path /org/a11y/atspi/accessible/123')
    })
    const failedCore = new AtspiSemanticCore(failedTransport)
    await expect(
      failedCore.snapshot('root', new AbortController().signal)
    ).rejects.toThrow('could not be read')
    await expect(
      failedCore.snapshot('root', new AbortController().signal)
    ).rejects.not.toThrow('/org/a11y/')

    const duplicateCore = new AtspiSemanticCore(
      transportFor(
        { root: node('root'), child: node('child') },
        { root: ['child'] }
      ),
      { createToken: () => 'duplicate-token' }
    )
    await expect(
      duplicateCore.snapshot('root', new AbortController().signal)
    ).rejects.toThrow('reference creation failed')
  })
})
