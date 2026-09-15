import { describe, expect, it } from 'vitest'
import {
  builtinModelToolGroups,
  builtinModelTools
} from './builtin-model-tools'

describe('built-in model tool catalog', () => {
  it('uses unique tool names', () => {
    const names = builtinModelTools.map((tool) => tool.name)

    expect(new Set(names).size).toBe(names.length)
  })

  it('places direct-model groups outside the shared browser and managed image capabilities', () => {
    const groupedNames = builtinModelToolGroups.flatMap((group) =>
      group.tools.map((tool) => tool.name)
    )
    const directModelTools = builtinModelTools.filter(
      (tool) => tool.group !== 'browser' && tool.group !== 'image'
    )

    expect(groupedNames).toHaveLength(directModelTools.length)
    expect(new Set(groupedNames).size).toBe(directModelTools.length)
    expect(groupedNames).toEqual(
      expect.arrayContaining(directModelTools.map((tool) => tool.name))
    )
    expect(groupedNames).not.toContain('generate_image')
    expect(builtinModelTools.find((tool) => tool.name === 'generate_image')).toMatchObject({
      group: 'image', access: 'write'
    })

    for (const group of builtinModelToolGroups) {
      expect(group.tools.every((tool) => tool.group === group.id)).toBe(true)
    }

    expect(
      builtinModelToolGroups
        .find((group) => group.id === 'programming')
        ?.tools.map((tool) => tool.name)
    ).toEqual(['process_execute', 'output_read', 'subagent_delegate'])
  })

  it('classifies programming tool access for mode filtering', () => {
    const programmingAccess = Object.fromEntries(
      builtinModelTools
        .filter((tool) => tool.group === 'programming')
        .map((tool) => [tool.name, tool.access])
    )

    expect(programmingAccess).toEqual({
      process_execute: 'write',
      output_read: 'read',
      subagent_delegate: 'read'
    })
  })

})
