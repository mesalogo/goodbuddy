import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface ElectronBuilderLogModule {
  LogMessageByKey: {
    PKG_DUPLICATE_REF: string
    PKG_DUPLICATE_REF_UNRESOLVED: string
  }
  logMessageLevelByKey: Record<string, string>
}

interface ElectronBuilderWrapper {
  configureElectronBuilderLogLevels: (
    moduleManager?: ElectronBuilderLogModule
  ) => void
}

const require = createRequire(import.meta.url)
const { configureElectronBuilderLogLevels } = require(
  '../build/run-electron-builder.cjs'
) as ElectronBuilderWrapper

describe('electron-builder logging', () => {
  it('keeps unresolved dependencies visible while hiding resolved duplicate references', () => {
    const moduleManager: ElectronBuilderLogModule = {
      LogMessageByKey: {
        PKG_DUPLICATE_REF: 'duplicate dependency references',
        PKG_DUPLICATE_REF_UNRESOLVED:
          'unresolved duplicate dependency references'
      },
      logMessageLevelByKey: {
        'duplicate dependency references': 'info',
        'unresolved duplicate dependency references': 'warn'
      }
    }

    configureElectronBuilderLogLevels(moduleManager)

    expect(
      moduleManager.logMessageLevelByKey[
        'duplicate dependency references'
      ]
    ).toBe('debug')
    expect(
      moduleManager.logMessageLevelByKey[
        'unresolved duplicate dependency references'
      ]
    ).toBe('warn')
  })

  it('fails clearly when the installed builder contract changes', () => {
    expect(() =>
      configureElectronBuilderLogLevels({
        LogMessageByKey: {
          PKG_DUPLICATE_REF: '',
          PKG_DUPLICATE_REF_UNRESOLVED:
            'unresolved duplicate dependency references'
        },
        logMessageLevelByKey: {}
      })
    ).toThrow(
      '当前 electron-builder 不支持依赖引用日志级别配置'
    )
  })
})
