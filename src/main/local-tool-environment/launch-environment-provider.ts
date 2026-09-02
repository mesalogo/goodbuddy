/**
 * Supplies a fresh, immutable snapshot of the environment prepared for local
 * tool launches. Consumers must only copy the values they explicitly support.
 */
export type LaunchEnvironmentProvider = () => Readonly<NodeJS.ProcessEnv>
