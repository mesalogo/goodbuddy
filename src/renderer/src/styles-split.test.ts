/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import postcss, { type Rule, type Root } from 'postcss'
import { describe, expect, it } from 'vitest'

function loadStyles(file: string): Root {
  const root = postcss.parse(readFileSync(file, 'utf8'), { from: file })
  root.walkAtRules('import', (rule) => {
    const target = /^['"](.+)['"]$/.exec(rule.params)
    if (!target?.[1]) throw new Error(`Unsupported import: ${rule.params}`)
    rule.replaceWith(loadStyles(resolve(dirname(file), target[1])).nodes)
  })
  return root
}

const css = loadStyles(join(process.cwd(), 'src/renderer/src/styles.css'))
const rules: Rule[] = []
css.walkRules((rule) => { rules.push(rule) })
const matching = (selector: string): Rule[] =>
  rules.filter((rule) => rule.selectors.includes(selector))
function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rule of matching(selector)) {
    rule.walkDecls((decl) => { result[decl.prop] = decl.value })
  }
  return result
}

describe('split stylesheet declarations and import order', () => {
  it.each(['', ' button', ' button:hover', ' button:disabled'])(
    'shares task actions%s with conversation details', (suffix) => {
      const shared = matching(`.conversation-task-details__actions${suffix}`)
      expect(shared).toHaveLength(1)
      expect(shared[0]?.selectors).toContain(`.task-center__actions${suffix}`)
      expect(declarations(`.task-center__actions${suffix}`)).toEqual(
        declarations(`.conversation-task-details__actions${suffix}`)
      )
    }
  )

  it.each([
    ['.tool-execution__details pre', '.tool-execution__error pre', 'styles-chat.css'],
    ['.subagent-status-card', '.subagent-status-card--failed', 'styles-chat.css'],
    ['.subagent-status-card', '.subagent-status-card--cancelled', 'styles-chat.css'],
    ['.knowledge-settings__toggle', '.knowledge-settings__toggle--pending', 'styles-knowledge.css']
  ])('loads the complete %s base before %s', (base, state, file) => {
    const bases = matching(base)
    const states = matching(state)
    expect(bases).toHaveLength(1)
    expect(states).toHaveLength(1)
    if (!bases[0] || !states[0]) throw new Error(`Missing rules: ${base}, ${state}`)
    expect(bases[0].source?.input.file).toBe(resolve('src/renderer/src', file))
    expect(rules.indexOf(bases[0])).toBeLessThan(rules.indexOf(states[0]))
    states[0].walkDecls((decl) => { expect(decl.important).toBeFalsy() })
  })

  it('preserves terminal state declarations', () => {
    expect(declarations('.tool-execution__error pre')).toEqual({
      'border-color': 'var(--danger-border)', color: 'var(--danger)'
    })
    for (const state of ['failed', 'cancelled']) {
      expect(declarations(`.subagent-status-card--${state}`)).toEqual({
        'border-color': 'var(--danger-border)', background: 'var(--danger-subtle)',
        'box-shadow': 'inset 3px 0 0 var(--danger)'
      })
    }
    expect(declarations('.knowledge-settings__toggle--pending')).toEqual({ cursor: 'wait' })
    expect(declarations('.knowledge-settings__toggle')).toEqual({
      display: 'grid', 'align-items': 'flex-start', 'justify-content': 'initial',
      padding: 'var(--space-3)', gap: 'var(--space-3)',
      'grid-template-columns': 'auto minmax(0, 1fr)',
      border: '1px solid var(--border-default)', 'border-radius': 'var(--radius-control)',
      background: 'var(--surface-raised)', cursor: 'pointer'
    })
  })

  it('retains the distinct execution layout declarations', () => {
    expect(declarations('.subagent-status-card__task').gap).toBe('var(--space-1)')
    for (const selector of ['.subagent-status-card__details', '.subagent-status-card__progress']) {
      expect(declarations(selector)).toMatchObject({
        display: 'grid', 'min-width': '0', gap: 'var(--space-3)',
        'grid-template-columns': 'minmax(0, 1fr)'
      })
    }
    for (const selector of ['.subagent-status-card__details section', '.tool-execution__details section']) {
      expect(declarations(selector)).toMatchObject({
        display: 'grid', 'min-width': '0', gap: 'var(--space-2)',
        'grid-template-columns': 'minmax(0, 1fr)'
      })
    }
    expect(declarations('.subagent-status-card__badge')).not.toHaveProperty('white-space')
    expect(declarations('.tool-execution > summary').transition).toBe('background var(--motion-fast) ease-out')
    expect(declarations('.tool-execution-list > ol > li')['min-width']).toBe('0')
  })

  it('retains the complete active status shimmer and its keyframes', () => {
    const shimmer = declarations('.message__status--active .message__status-label')
    expect(Object.fromEntries(Object.entries(shimmer).map(([key, value]) => [key, value.replace(/\s+/g, ' ')]))).toEqual({
      background: 'linear-gradient( 105deg, var(--text-muted) 0%, var(--text-muted) 38%, var(--text-primary) 50%, var(--text-muted) 62%, var(--text-muted) 100% )',
      'background-size': '320% 100%', 'background-position': '140% 0',
      'background-clip': 'text', '-webkit-background-clip': 'text',
      '-webkit-text-fill-color': 'transparent', animation: 'message-status-shimmer 2.2s linear infinite'
    })
    const frames: Record<string, string> = {}
    css.walkAtRules('keyframes', (rule) => {
      if (rule.params !== 'message-status-shimmer') return
      rule.walkRules((frame) => {
        frame.walkDecls('background-position', (decl) => {
          for (const selector of frame.selectors) frames[selector] = decl.value
        })
      })
    })
    expect(frames).toEqual({ '0%': '140% 0', '12%': '140% 0', '88%': '-40% 0', '100%': '-40% 0' })
  })

  it('loads the domain files in a fixed order from the styles.css entry', () => {
    const entry = postcss.parse(readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8'))
    const imports: string[] = []
    entry.walkAtRules('import', (rule) => { imports.push(rule.params.replace(/^['"]\.\/|['"]$/g, '')) })
    expect(imports).toEqual([
      'styles-foundations.css',
      'styles-workspace-common.css',
      'styles-app-shell.css',
      'styles-chat.css',
      'styles-knowledge.css',
      'styles-magic-notes.css',
      'styles-workbar.css',
      'styles-settings.css',
      'styles-operations.css'
    ])
    const first = entry.first
    expect(first?.type === 'atrule' && first.name === 'import').toBe(true)
  })

  it('loads shared controls before domain rules so domain overrides win', () => {
    const shared = rules.find((rule) => rule.selectors.includes('.secondary-button') && rule.parent?.type === 'root')
    const mobileBack = rules.find((rule) => rule.selector === '.knowledge-workspace__mobile-back' && rule.parent?.type === 'root')
    if (!shared || !mobileBack) throw new Error('Missing shared button or knowledge mobile back rule')
    expect(rules.indexOf(shared)).toBeLessThan(rules.indexOf(mobileBack))
    expect(declarations('.knowledge-workspace__mobile-back').display).toBeDefined()
    const pairs: Array<[string, string]> = [['.settings-section', '.settings-section--danger'], ['.toggle-row', '.knowledge-settings__toggle'],
      ['.knowledge-source-row__status', '.knowledge-source-row__status--ready']]
    for (const [base, state] of pairs) {
      const baseIndex = rules.findIndex((rule) => rule.selectors.includes(base) && rule.parent?.type === 'root')
      const stateIndex = rules.findIndex((rule) => rule.selectors.includes(state) && rule.parent?.type === 'root')
      expect(baseIndex, base).toBeGreaterThanOrEqual(0)
      expect(baseIndex, `${base} before ${state}`).toBeLessThan(stateIndex)
    }
  })

  it('keeps the global focus ring after the domain files without overriding the composer input', () => {
    const ring = rules.find((rule) => rule.selectors.includes('textarea:focus-visible'))
    const composer = rules.find((rule) => rule.selectors.includes('.composer__input textarea'))
    if (!ring || !composer) throw new Error('Missing focus ring or composer input rule')
    expect(ring.source?.input.file).toBe(resolve('src/renderer/src/styles.css'))
    expect(rules.indexOf(ring)).toBeGreaterThan(rules.indexOf(composer))
    expect(declarations('.composer__input textarea:focus-visible')).toEqual({ outline: '0' })
  })

  it('keeps the sidebar search ring on the container only', () => {
    expect(declarations('.sidebar-search:focus-within').outline).toBe('2px solid var(--accent)')
    expect(declarations('.sidebar-search input:focus-visible')).toEqual({ outline: '0' })
  })
})
