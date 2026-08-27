import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  brandingLogoMaximumBytes,
  brandingNameMaximumLength,
  defaultBrandingPreferences,
  loadBrandingPreferences,
  normalizeBrandingPreferences,
  saveBrandingPreferences
} from './branding'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('branding preferences', () => {
  it('uses defaults when no valid preference is stored', () => {
    expect(loadBrandingPreferences()).toEqual(defaultBrandingPreferences)

    localStorage.setItem('goodbuddy.branding.v1', '{"name":true}')
    expect(loadBrandingPreferences()).toEqual(defaultBrandingPreferences)
  })

  it('normalizes text and accepts only bounded inline image data', () => {
    expect(
      normalizeBrandingPreferences({
        name: `  ${'B'.repeat(brandingNameMaximumLength + 4)}  `,
        subtitleZhCN: '  中文品牌  ',
        subtitleEnUS: '  English brand  ',
        logoDataUrl: 'https://example.com/logo.png'
      })
    ).toEqual({
      name: 'B'.repeat(brandingNameMaximumLength),
      subtitleZhCN: '中文品牌',
      subtitleEnUS: 'English brand'
    })

    expect(
      normalizeBrandingPreferences({
        name: ' ',
        subtitleZhCN: '',
        subtitleEnUS: '',
        logoDataUrl: 'data:image/png;base64,iVBORw0KGgo='
      })
    ).toEqual({
      name: 'GoodBuddy',
      subtitleZhCN: '',
      subtitleEnUS: '',
      logoDataUrl: 'data:image/png;base64,iVBORw0KGgo='
    })
  })

  it('persists and reloads valid preferences', () => {
    const preferences = {
      name: '团队助手',
      subtitleZhCN: '研发工作台',
      subtitleEnUS: 'Engineering Workspace',
      logoDataUrl: 'data:image/png;base64,iVBORw0KGgo='
    }

    expect(saveBrandingPreferences(preferences)).toBe(true)
    expect(loadBrandingPreferences()).toEqual(preferences)
  })

  it('rejects a logo whose bytes do not match its declared type', () => {
    expect(
      normalizeBrandingPreferences({
        ...defaultBrandingPreferences,
        logoDataUrl: 'data:image/jpeg;base64,iVBORw0KGgo='
      })
    ).toEqual(defaultBrandingPreferences)
  })

  it('rejects oversized encoded logos before decoding them', () => {
    const decode = vi.spyOn(globalThis, 'atob')

    expect(
      normalizeBrandingPreferences({
        ...defaultBrandingPreferences,
        logoDataUrl: `data:image/png;base64,${'A'.repeat(
          Math.ceil((brandingLogoMaximumBytes * 4) / 3) + 8
        )}`
      })
    ).toEqual(defaultBrandingPreferences)
    expect(decode).not.toHaveBeenCalled()
  })

  it('reports unavailable local storage without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(
      saveBrandingPreferences(defaultBrandingPreferences)
    ).toBe(false)
  })
})
