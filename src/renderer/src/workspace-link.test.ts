import { describe, expect, it } from 'vitest'
import { resolveWorkspaceLink } from './workspace-link'

describe('workspace links', () => {
  it.each([
    ['README.md:43', 'D:\\work', 'README.md'],
    ['./README.md:43:2', 'D:\\work', 'README.md'],
    ['D:/my_git/goodbuddy/docs/features/assistant-workbar/workspace-files.md:43', 'D:\\my_git\\goodbuddy', 'docs/features/assistant-workbar/workspace-files.md'],
    ['images/a%20b.png:12:3', '/work', 'images/a b.png'],
    ['/work/image.png#L12', '/work', 'image.png'],
    ['/D:/WORK/image.png', 'D:\\work', 'image.png'],
    ['D:/work/image.png:12', 'D:\\work', 'image.png'],
    ['/Work/image.png', '/work', undefined],
    ['/elsewhere/image.png', 'D:\\work', undefined],
    ['https://example.com/image.png', '/work', undefined],
    ['http://example.com/image.png', '/work', undefined],
    ['//example.com/image.png', '/work', undefined],
    ['../image.png', '/work', undefined],
    ['%invalid', '/work', undefined]
  ])('%s in %s', (href, root, expected) => {
    expect(resolveWorkspaceLink(href, root)).toBe(expected)
  })
})
