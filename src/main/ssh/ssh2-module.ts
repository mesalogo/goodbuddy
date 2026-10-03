import { createLazyRequire } from '../lazy-require'

/**
 * Loads ssh2 on the first SSH connection instead of at Main startup (P6):
 * evaluating it costs ~65 ms and most sessions never open a remote host.
 * Synchronous so existing client factories keep their signatures.
 */
export const loadSsh2 = createLazyRequire<typeof import('ssh2')>('ssh2')
