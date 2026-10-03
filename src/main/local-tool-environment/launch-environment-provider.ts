/**
 * Supplies a fresh, immutable snapshot of the environment prepared for local
 * tool launches. Consumers must only copy the values they explicitly support.
 */
export type LaunchEnvironmentProvider = () => Readonly<NodeJS.ProcessEnv>

/**
 * Settles once the launch environment has been built at startup. Consumers that
 * can run before startup finishes await it before reading the provider.
 */
export type LaunchEnvironmentReady = () => Promise<void>