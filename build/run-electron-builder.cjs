'use strict'

function configureElectronBuilderLogLevels(
  moduleManager = require(
    'app-builder-lib/out/node-module-collector/moduleManager'
  )
) {
  const duplicateReferenceMessage =
    moduleManager.LogMessageByKey.PKG_DUPLICATE_REF
  if (
    !duplicateReferenceMessage ||
    !moduleManager.logMessageLevelByKey[
      duplicateReferenceMessage
    ]
  ) {
    throw new Error(
      '当前 electron-builder 不支持依赖引用日志级别配置'
    )
  }
  moduleManager.logMessageLevelByKey[
    duplicateReferenceMessage
  ] = 'debug'
}

if (require.main === module) {
  configureElectronBuilderLogLevels()
  require('electron-builder/cli')
}

module.exports = {
  configureElectronBuilderLogLevels
}
