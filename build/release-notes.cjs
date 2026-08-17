const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
)
const releaseNotesFile = JSON.parse(
  readFileSync(join(root, 'resources', 'release-notes.json'), 'utf8')
)

function fail(message) {
  throw new Error(`Release notes validation failed: ${message}`)
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function validateItems(value, label) {
  if (!Array.isArray(value) || value.length > 20) {
    fail(`${label} must contain no more than 20 items`)
  }
  return value.map((item) => {
    if (typeof item !== 'string') {
      fail(`${label} contains a non-string item`)
    }
    const normalized = item.trim()
    if (!normalized || normalized.length > 500) {
      fail(`${label} contains an empty or oversized item`)
    }
    return normalized
  })
}

const releaseNoteSections = [
  'highlights',
  'features',
  'fixes',
  'notices'
]
const legacyReleaseNoteSections = ['features', 'fixes']

function validateRelease(value, index) {
  const label = `releases[${index}]`
  if (!hasExactKeys(value, ['version', 'releasedAt', 'notes'])) {
    fail(`${label} has invalid fields`)
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
    value.version
  )) {
    fail(`${label}.version must be a stable semantic version`)
  }
  const date = new Date(`${value.releasedAt}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.releasedAt) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value.releasedAt
  ) {
    fail(`${label}.releasedAt must be a real YYYY-MM-DD date`)
  }
  if (!hasExactKeys(value.notes, ['zh-CN', 'en-US'])) {
    fail(`${label}.notes must contain zh-CN and en-US`)
  }
  const notes = Object.fromEntries(
    ['zh-CN', 'en-US'].map((locale) => {
      const localized = value.notes[locale]
      const isCurrentFormat = hasExactKeys(
        localized,
        releaseNoteSections
      )
      const isLegacyFormat = hasExactKeys(
        localized,
        legacyReleaseNoteSections
      )
      if (!isCurrentFormat && !isLegacyFormat) {
        fail(`${label}.notes.${locale} has invalid fields`)
      }
      const normalized = Object.fromEntries(
        releaseNoteSections.map((section) => [
          section,
          section in localized
            ? validateItems(
                localized[section],
                `${label}.notes.${locale}.${section}`
              )
            : []
        ])
      )
      if (normalized.highlights.length > 3) {
        fail(
          `${label}.notes.${locale}.highlights must contain no more than 3 items`
        )
      }
      if (
        releaseNoteSections.every(
          (section) => normalized[section].length === 0
        )
      ) {
        fail(`${label}.notes.${locale} must not be empty`)
      }
      return [locale, normalized]
    })
  )
  for (const section of releaseNoteSections) {
    if (
      notes['zh-CN'][section].length !==
      notes['en-US'][section].length
    ) {
      fail(`${label} localized ${section} counts do not match`)
    }
  }
  return {
    version: value.version,
    releasedAt: value.releasedAt,
    notes
  }
}

if (
  !hasExactKeys(releaseNotesFile, ['formatVersion', 'releases']) ||
  releaseNotesFile.formatVersion !== 1 ||
  !Array.isArray(releaseNotesFile.releases) ||
  releaseNotesFile.releases.length < 1 ||
  releaseNotesFile.releases.length > 100
) {
  fail('unsupported file format')
}

const allReleases = releaseNotesFile.releases.map(validateRelease)
const uniqueVersionCount = new Set(
  allReleases.map((release) => release.version)
).size
if (uniqueVersionCount !== allReleases.length) {
  fail('release versions must be unique')
}

const releases = allReleases.filter(
  (release) => release?.version === packageJson.version
)
if (releases.length !== 1) {
  fail(
    `expected exactly one entry for package version ${packageJson.version}`
  )
}

const release = releases[0]

const localizedDefinitions = [
  {
    locale: 'zh-CN',
    title: `GoodBuddy ${release.version} 更新内容`,
    highlights: '本次亮点',
    features: '功能更新',
    fixes: '问题修复',
    notices: '使用前请留意'
  },
  {
    locale: 'en-US',
    title: `What's New in GoodBuddy ${release.version}`,
    highlights: 'Highlights',
    features: 'Features',
    fixes: 'Bug Fixes',
    notices: 'Before You Start'
  }
]

function markdownSection(title, items) {
  if (items.length === 0) {
    return []
  }
  return [`## ${title}`, '', ...items.map((item) => `- ${item}`), '']
}

const markdown = localizedDefinitions
  .flatMap((definition, index) => {
    const notes = release.notes[definition.locale]
    return [
      ...(index === 0 ? [] : ['---', '']),
      `# ${definition.title}`,
      '',
      ...markdownSection(
        definition.highlights,
        notes.highlights
      ),
      ...markdownSection(definition.features, notes.features),
      ...markdownSection(definition.fixes, notes.fixes),
      ...markdownSection(definition.notices, notes.notices)
    ]
  })
  .join('\n')
  .trimEnd()
  .concat('\n')

const outputIndex = process.argv.indexOf('--output')
if (outputIndex >= 0) {
  const outputPath = process.argv[outputIndex + 1]
  if (!outputPath) {
    fail('--output requires a path')
  }
  writeFileSync(resolve(root, outputPath), markdown, 'utf8')
} else {
  process.stdout.write(
    `Validated bilingual release notes for ${packageJson.version}\n`
  )
}
