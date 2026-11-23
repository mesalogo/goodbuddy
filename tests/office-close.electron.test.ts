// @vitest-environment node
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

// Opt-in: this probe registers a test device and uploads a generated document to
// the supplied real ShareServer/ONLYOFFICE stack. It never calls a model.
it.skipIf(!process.env.GB_OFFICE_TEST_WEB || process.platform !== 'linux')('keeps Office close decisions inside the document and recovers a real writeback conflict', async () => {
  const child = spawn(process.env.GB_OFFICE_TEST_PYTHON ?? 'python3', [
    'scripts/verify-office-desktop.py', '--web', process.env.GB_OFFICE_TEST_WEB!,
    '--registered-device', '--file-entry', '--close-tab'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let timedOut = false
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 160_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    expect(timedOut, output).toBe(false)
    expect(code, output).toBe(0)
    expect(output).toContain('PASS: close prompt belongs to document; other tab usable; cancel restores same view')
    expect(output).toContain('PASS: close conflict stays local; save-as recovers contents; no application message boxes')
  } finally { clearTimeout(timer) }
}, 180_000)
