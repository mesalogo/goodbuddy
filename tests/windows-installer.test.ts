// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const templates = path.join(root, 'node_modules/app-builder-lib/templates/nsis')
const read = (file: string) => readFileSync(file, 'utf8')
const config = JSON.parse(read(path.join(root, 'package.json'))).build.nsis
const include = read(path.join(root, config.include))
const replacement = read(path.join(root, 'build/installer-arm64.nsh'))
const upstream = read(path.join(templates, 'multiUser.nsh'))
const installer = read(path.join(templates, 'installer.nsi'))
const assisted = read(path.join(templates, 'assistedInstaller.nsh'))

describe('Windows ARM64 installation directory', () => {
  it('uses the assisted installer hook before any install-mode macro expansion', () => {
    expect(config.oneClick).toBe(false)
    expect(config.allowToChangeInstallationDirectory).toBe(true)
    expect(include).toContain('!macro customWelcomePage')
    expect(installer.indexOf('!include "multiUser.nsh"')).toBeLessThan(
      installer.indexOf('!include "assistedInstaller.nsh"')
    )
    expect(assisted.indexOf('!insertmacro customWelcomePage')).toBeLessThan(
      assisted.indexOf('!insertmacro PAGE_INSTALL_MODE')
    )
    expect(installer.indexOf('!include "assistedInstaller.nsh"')).toBeLessThan(
      installer.indexOf('!insertmacro initMultiUser')
    )
    expect(assisted).toMatch(/!ifndef BUILD_UNINSTALLER\s+!ifmacrodef customWelcomePage/)
  })

  it('preserves the upstream machine-path logic except the ARM64 default root', () => {
    const body = upstream.match(/!macro setInstallModePerAllUsers([\s\S]*?)!macroend/)![1]!
      .replace(/!ifdef BUILD_UNINSTALLER[\s\S]*?!endif/, '')
      .replace(/StrCpy \$0 "\$PROGRAMFILES"\s+!ifdef APP_64[\s\S]*?!endif/,
        'StrCpy $0 "$PROGRAMFILES64"')
    const normalize = (text: string) => text.split('\n')
      .map((line) => line.replace(/#.*/, '').trim()).filter(Boolean).join('\n')
    expect(normalize(replacement.match(/!macro setInstallModePerAllUsers([\s\S]*?)!macroend/)![1]!))
      .toBe(normalize(body))
    expect(replacement).not.toContain('!macro setInstallModePerUser')
    expect(replacement).not.toMatch(/WriteReg|DeleteReg/)
  })

  // Opt-in compilation uses real upstream page/init macros and never runs the EXE.
  // CI without the NSIS toolchain still checks integration order and upstream drift.
  it.skipIf(!process.env.GB_TEST_MAKENSIS || !process.env.GB_TEST_NSIS_PLUGINS)(
    'compiles ARM64, x64, mixed, ia32 and uninstaller paths with the real NSIS compiler',
    () => {
      const require = createRequire(import.meta.url)
      const { NsisScriptGenerator } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator')
      const header = new NsisScriptGenerator()
      header.flags(['updated', 'allusers', 'currentuser'])
      const parent = path.join(root, 'temp')
      mkdirSync(parent, { recursive: true })
      const dir = mkdtempSync(path.join(parent, 'nsis-arm64-'))
      try {
        for (const defines of [
          ['APP_ARM64'], ['APP_64'], ['APP_ARM64', 'APP_64'],
          ['APP_32'], ['APP_ARM64', 'APP_32'], ['APP_ARM64', 'BUILD_UNINSTALLER']
        ]) {
          const script = String.raw`
Unicode true
Name "GoodBuddy NSIS compile check"
OutFile "${path.join(dir, 'check.exe')}"
RequestExecutionLevel user
!addincludedir "${templates}"
!addincludedir "${path.join(templates, 'include')}"
!addincludedir "${path.join(root, 'build')}"
!addplugindir /x86-unicode "${process.env.GB_TEST_NSIS_PLUGINS}"
!include LogicLib.nsh
!include StdUtils.nsh
!define PRODUCT_NAME GoodBuddy
!define PRODUCT_FILENAME GoodBuddy
!define VERSION 0.0.0
!define APP_FILENAME GoodBuddy
!define APP_GUID nsis-compile-check
!define UNINSTALL_APP_KEY nsis-compile-check
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
!define allowToChangeInstallationDirectory
!define HIDE_RUN_AFTER_FINISH
${defines.map((name) => `!define ${name}`).join('\n')}
${header.build()}
!include "${path.join(root, config.include)}"
!include "${path.join(templates, 'common.nsh')}"
!include MUI2.nsh
!include "${path.join(templates, 'multiUser.nsh')}"
!include "${path.join(templates, 'assistedInstaller.nsh')}"
!insertmacro MUI_LANGUAGE English
Function .onInit
  !insertmacro initMultiUser
FunctionEnd
Section
SectionEnd
`
          const file = path.join(dir, 'check.nsi')
          writeFileSync(file, script)
          const args = ['/V4', file]
          const options = { cwd: dir, encoding: 'utf8' as const,
            env: { ...process.env, TEMP: dir, TMP: dir }, timeout: 30_000 }
          const expanded = execFileSync(process.env.GB_TEST_MAKENSIS!, args, options)
          const machineDefaults = [...expanded.matchAll(/StrCpy \$0 "\$(PROGRAMFILES(?:64)?)"/g)]
            .map((match) => match[1])
          expect(machineDefaults.length).toBeGreaterThan(0)
          if (defines.length === 1 && defines[0] === 'APP_ARM64') {
            expect(new Set(machineDefaults)).toEqual(new Set(['PROGRAMFILES64']))
          } else {
            expect(machineDefaults).toContain('PROGRAMFILES')
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000
  )
})
