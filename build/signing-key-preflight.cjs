function preflightRegisteredProductionKey(options) {
  const keyId = options.keyId
  if (!keyId) {
    throw new Error(options.missingKeyIdMessage)
  }
  const signingRecord = options.registry.keys.find(
    (key) => key.keyId === keyId
  )
  if (!signingRecord) {
    throw new Error(
      `Production ${options.component} public signing key ID "${keyId}" is absent from resources/agent-release-keys.json; provision the matching public key before building a release`
    )
  }
  if (signingRecord.environment !== 'production') {
    throw new Error(
      `Production ${options.component} signing key ID "${keyId}" is not registered for production`
    )
  }
  if (
    options.registry.revocations.some(
      (revocation) => revocation.keyId === keyId
    )
  ) {
    throw new Error(
      `Production ${options.component} signing key ID "${keyId}" is revoked`
    )
  }
  return signingRecord
}

module.exports = { preflightRegisteredProductionKey }
