import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStylesheetBundle } from './stylesheet-bundle'

const css = readStylesheetBundle()
const supervisorCss = readStylesheetBundle('supervisor-workspace.css')
const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'HeartbeatCenter.tsx'), 'utf8')

describe('supervisor page layout', () => {
  it('declares the heartbeat-center container only on the page root', () => {
    expect(css).toMatch(/\.heartbeat-center\s*\{[^}]*container:\s*heartbeat-center\s*\/\s*inline-size;/u)
    // The automatic-plan tab content has its own class, so the page container is not nested.
    expect(source.match(/className="heartbeat-center[ "]/gu)).toHaveLength(1)
    expect(source).toContain('className="heartbeat-sections"')
    expect(supervisorCss).toMatch(/\.heartbeat-sections\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--space-6\);/u)
    expect(supervisorCss).not.toMatch(/\.heartbeat-sections\s*\{[^}]*container:/u)
    expect(supervisorCss).toMatch(/\.heartbeat-sections > \.heartbeat-center__section-heading\s*\{/u)
  })

  it('uses the same tab spacing as the activity page', () => {
    expect(css).toMatch(/\.heartbeat-center > \.page-tabs\s*\{\s*padding:\s*var\(--space-4\) 0;/u)
    expect(css).toMatch(/\.activity-panel > \.page-tabs\s*\{\s*padding:\s*var\(--space-4\) 0;/u)
  })

  it('has no header action rules for a header without actions', () => {
    expect(css).not.toContain('.heartbeat-center .page-header__actions')
  })
})
