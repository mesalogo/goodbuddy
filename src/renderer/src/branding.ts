import { detectSupportedImage } from '../../shared/image-media-type'

export type BrandingPreferences = {
  name: string
  subtitleZhCN: string
  subtitleEnUS: string
  logoDataUrl?: string
}

export const defaultBrandingPreferences: BrandingPreferences = {
  name: 'GoodBuddy',
  subtitleZhCN: '智能工作台',
  subtitleEnUS: 'Intelligent Workspace'
}

export const brandingNameMaximumLength = 32
export const brandingSubtitleMaximumLength = 48
export const brandingLogoMaximumBytes = 512 * 1024

const storageKey = 'goodbuddy.branding.v1'
const supportedLogoDataUrlPattern =
  /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/]+={0,2})$/iu

export function isValidBrandingLogoDataUrl(value: string): boolean {
  const match = supportedLogoDataUrlPattern.exec(value)
  if (!match) {
    return false
  }
  try {
    const encoded = match[2]!
    if (
      encoded.length >
      Math.ceil((brandingLogoMaximumBytes * 4) / 3) + 4
    ) {
      return false
    }
    const decoded = atob(encoded)
    if (
      decoded.length === 0 ||
      decoded.length > brandingLogoMaximumBytes
    ) {
      return false
    }
    const header = Uint8Array.from(
      decoded
        .slice(0, 12)
        .split('')
        .map((character) => character.charCodeAt(0))
    )
    return (
      detectSupportedImage(header).mimeType === match[1]!.toLowerCase()
    )
  } catch {
    return false
  }
}

export function normalizeBrandingPreferences(
  value: BrandingPreferences
): BrandingPreferences {
  const name = value.name.trim()
  const subtitleZhCN = value.subtitleZhCN.trim()
  const subtitleEnUS = value.subtitleEnUS.trim()
  return {
    name:
      name.length > 0
        ? name.slice(0, brandingNameMaximumLength)
        : defaultBrandingPreferences.name,
    subtitleZhCN: subtitleZhCN.slice(
      0,
      brandingSubtitleMaximumLength
    ),
    subtitleEnUS: subtitleEnUS.slice(
      0,
      brandingSubtitleMaximumLength
    ),
    ...(value.logoDataUrl &&
    isValidBrandingLogoDataUrl(value.logoDataUrl)
      ? { logoDataUrl: value.logoDataUrl }
      : {})
  }
}

export function loadBrandingPreferences(): BrandingPreferences {
  try {
    const value = localStorage.getItem(storageKey)
    if (!value) {
      return { ...defaultBrandingPreferences }
    }
    const parsed = JSON.parse(value) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).name !== 'string' ||
      typeof (parsed as Record<string, unknown>).subtitleZhCN !==
        'string' ||
      typeof (parsed as Record<string, unknown>).subtitleEnUS !==
        'string'
    ) {
      return { ...defaultBrandingPreferences }
    }
    const candidate = parsed as BrandingPreferences
    return normalizeBrandingPreferences({
      name: candidate.name,
      subtitleZhCN: candidate.subtitleZhCN,
      subtitleEnUS: candidate.subtitleEnUS,
      ...(typeof candidate.logoDataUrl === 'string'
        ? { logoDataUrl: candidate.logoDataUrl }
        : {})
    })
  } catch {
    return { ...defaultBrandingPreferences }
  }
}

export function saveBrandingPreferences(
  value: BrandingPreferences
): boolean {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(normalizeBrandingPreferences(value))
    )
    return true
  } catch {
    return false
  }
}

export function brandingPreferencesEqual(
  left: BrandingPreferences,
  right: BrandingPreferences
): boolean {
  return (
    left.name === right.name &&
    left.subtitleZhCN === right.subtitleZhCN &&
    left.subtitleEnUS === right.subtitleEnUS &&
    left.logoDataUrl === right.logoDataUrl
  )
}
