import type { TranslationShape } from '../../resource-types'
import type { warnings as chineseWarnings } from '../zh-CN/warnings'

export const warnings = {
  'application-settings-recovered':
    'The application settings file was corrupt. The original file was isolated, and safe defaults are now in use.',
  'document-parsing-settings-recovered':
    'The document parsing settings file was corrupt. The original file was isolated, and safe defaults are now in use.',
  'capability-settings-recovered':
    'The capability settings file was corrupt. The original file was isolated. Web search, the built-in browser, and computer control remain off until you review and enable them.',
  'runtime-settings-recovered':
    'The Runtime settings file was corrupt. The original file was isolated, and defaults are now in use.',
  'runtime-model-credential-unreadable':
    'The API Key for model connection “{{subject}}” cannot be read. Re-enter or clear this credential.',
  'runtime-model-credential-binding-mismatch':
    'The service address for model connection “{{subject}}” does not match its saved API Key. Re-enter or clear this credential.',
  'runtime-embedding-credential-unreadable':
    'The embedding model API Key cannot be read. Re-enter or clear this credential.',
  'runtime-embedding-credential-binding-mismatch':
    'The embedding endpoint does not match its saved API Key. Re-enter or clear this credential.',
  'runtime-rerank-credential-unreadable':
    'The rerank model API Key cannot be read. Re-enter or clear this credential.',
  'runtime-rerank-credential-binding-mismatch':
    'The rerank endpoint does not match its saved API Key. Re-enter or clear this credential.',
  'channel-settings-recovered':
    'The channel settings file was corrupt. The original file was isolated, and all channels were restored as disabled.',
  'channel-weixin-credential-unreadable':
    'The WeChat connection credential cannot be read, so the channel is temporarily disabled. Connect it again with a QR code.',
  'channel-weixin-secure-storage-unavailable':
    'Secure system storage is temporarily unavailable, so the WeChat channel is disabled. Retry after secure storage recovers.',
  'channel-weixin-legacy-binding-invalid':
    'The legacy WeChat connection could not be migrated safely. Connect it again with a QR code.',
  'channel-wecom-environment-invalid':
    'The WeCom environment configuration is invalid or incomplete, so the channel remains off.',
  'channel-dingtalk-environment-invalid':
    'The DingTalk environment configuration is invalid or incomplete, so the channel remains off.',
  'channel-wecom-credential-unreadable':
    'The WeCom Secret cannot be read. Re-enter or clear this credential.',
  'channel-dingtalk-credential-unreadable':
    'The DingTalk Client Secret cannot be read. Re-enter or clear this credential.',
  'channel-runtime-selections-repaired':
    'Repaired {{count}} unavailable backend selections for unattended channels. Review each channel project setting.'
} as const satisfies TranslationShape<typeof chineseWarnings>

export default warnings
