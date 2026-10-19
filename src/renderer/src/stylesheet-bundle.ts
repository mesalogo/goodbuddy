/// <reference types="node" />

// Test helper: reads the renderer stylesheet as the browser receives it.
// `styles.css` is only an entry that @imports the domain files; tests that inspect CSS text
// should read the expanded bundle so they keep working when rules move between domain files.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const importPattern = /@import\s+['"]([^'"]+)['"]\s*;/g

function expand(file: string, seen: Set<string>): string {
  if (seen.has(file)) return ''
  seen.add(file)
  const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  return source.replace(importPattern, (_statement, target: string) =>
    expand(resolve(dirname(file), target), seen)
  )
}

/** The full renderer stylesheet with every @import inlined in load order. */
export function readStylesheetBundle(entry = 'styles.css'): string {
  return expand(join(process.cwd(), 'src', 'renderer', 'src', entry), new Set())
}
