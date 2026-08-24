const packageJson = require('../package.json')
const {
  supportedArchitectures,
  targetName
} = require('./agent-bundle.cjs')

const remoteRuntimeResources = supportedArchitectures.map(
  (architecture) => {
    const target = targetName(architecture)
    return {
      from: `.remote-runtime-resources/${target}`,
      to: `remote-runtimes/${target}`,
      filter: ['**/*']
    }
  }
)

const agentResources = [
  ...supportedArchitectures.map((architecture) => {
    const target = targetName(architecture)
    return {
      from: `.agent-resources/${target}`,
      to: `agents/${target}`,
      filter: ['**/*']
    }
  })
]

module.exports = {
  ...packageJson.build,
  extraResources: [
    ...packageJson.build.extraResources,
    ...agentResources,
    ...remoteRuntimeResources
  ]
}
