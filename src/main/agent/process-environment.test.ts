import { describe, expect, it } from 'vitest'
import {
  applyLaunchEnvironmentPath,
  buildCredentialFilteredUserEnvironment,
  buildExplicitProfileRuntimeEnvironment,
  buildControlledHarnessEnvironment,
  buildRuntimeEnvironment
} from './process-environment'

describe('buildRuntimeEnvironment', () => {
  it('uses a fresh tool PATH snapshot without importing credentials', () => {
    let generation = 0
    const provider = () =>
      Object.freeze({
        PATH: `/managed-${++generation}:/system`,
        OPENAI_API_KEY: 'must-not-leak',
        ELECTRON_RUN_AS_NODE: '1'
      })
    const source = {
      PATH: '/system',
      OPENAI_API_KEY: 'inherited-secret',
      ELECTRON_RUN_AS_NODE: '1',
      HOME: '/home/user'
    }

    expect(
      applyLaunchEnvironmentPath(
        buildCredentialFilteredUserEnvironment(source),
        provider
      )
    ).toEqual({
      PATH: '/managed-1:/system',
      HOME: '/home/user'
    })
    expect(
      applyLaunchEnvironmentPath(
        buildCredentialFilteredUserEnvironment(source),
        provider
      ).PATH
    ).toBe('/managed-2:/system')
  })

  it('preserves one inherited PATH casing without duplicate keys', () => {
    expect(
      applyLaunchEnvironmentPath(
        { Path: 'C:\\Windows', PATH: 'duplicate', TEMP: 'C:\\Temp' },
        () => Object.freeze({ PATH: 'C:\\GoodBuddy;C:\\Windows' })
      )
    ).toEqual({
      Path: 'C:\\GoodBuddy;C:\\Windows',
      TEMP: 'C:\\Temp'
    })
  })

  it('keeps required runtime values and excludes unrelated parent secrets', () => {
    const environment = buildRuntimeEnvironment(
      {
        GOODBUDDY_RUNTIME_TOKEN: 'scoped-token'
      },
      {
        PATH: 'C:\\Tools',
        TEMP: 'C:\\Temp',
        ANTHROPIC_API_KEY: 'provider-key',
        GOODBUDDY_DELEGATION_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        NODE_OPTIONS: '--require malicious.js'
      }
    )

    expect(environment).toEqual({
      PATH: 'C:\\Tools',
      TEMP: 'C:\\Temp',
      ANTHROPIC_API_KEY: 'provider-key',
      GOODBUDDY_RUNTIME_TOKEN: 'scoped-token',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
  })

  it('always propagates intranet TLS compatibility to child runtimes', () => {
    const source = {
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '1'
    }

    expect(buildRuntimeEnvironment({}, source)).toEqual({
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
    expect(
      buildRuntimeEnvironment(
        { NODE_TLS_REJECT_UNAUTHORIZED: '1' },
        source
      )
    ).toEqual({
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
  })

  it('isolates an explicit profile from inherited provider and cloud credentials', () => {
    const source = {
      PATH: '/tools',
      ANTHROPIC_API_KEY: 'inherited-anthropic',
      OPENAI_API_KEY: 'inherited-openai',
      GOOGLE_GENERATIVE_AI_API_KEY: 'inherited-google',
      GEMINI_API_KEY: 'inherited-gemini',
      GROQ_API_KEY: 'inherited-groq',
      AZURE_OPENAI_API_KEY: 'inherited-azure',
      AWS_ACCESS_KEY_ID: 'inherited-aws-access',
      AWS_SECRET_ACCESS_KEY: 'inherited-aws-secret',
      AWS_SESSION_TOKEN: 'inherited-aws-session',
      AWS_REGION: 'inherited-aws-region',
      AWS_PROFILE: 'inherited-aws-profile',
      OPENROUTER_API_KEY: 'inherited-openrouter',
      XAI_API_KEY: 'inherited-xai',
      MISTRAL_API_KEY: 'inherited-mistral',
      COHERE_API_KEY: 'inherited-cohere'
    }

    expect(
      buildExplicitProfileRuntimeEnvironment(
        { GOODBUDDY_RUNTIME_TOKEN: 'scoped-token' },
        { name: 'OPENAI_API_KEY', value: 'selected-key' },
        source
      )
    ).toEqual({
      PATH: '/tools',
      GOODBUDDY_RUNTIME_TOKEN: 'scoped-token',
      OPENAI_API_KEY: 'selected-key',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
    expect(
      buildExplicitProfileRuntimeEnvironment({}, undefined, source)
    ).toEqual({
      PATH: '/tools',
      NODE_TLS_REJECT_UNAUTHORIZED: '0'
    })
  })

  it('builds a credential-free, telemetry-disabled Harness environment', () => {
    expect(
      buildControlledHarnessEnvironment('C:\\isolated-dsh', {
        PATH: 'C:\\Tools',
        TEMP: 'C:\\Temp',
        OPENAI_API_KEY: 'must-not-leak',
        DEEPSEEK_API_KEY: 'must-not-leak',
        DSH_HOME: 'C:\\user-dsh',
        NODE_OPTIONS: '--require malicious.js'
      })
    ).toMatchObject({
      PATH: 'C:\\Tools',
      TEMP: 'C:\\Temp',
      DSH_HOME: 'C:\\isolated-dsh',
      DSH_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
      OTEL_SDK_DISABLED: 'true'
    })
    expect(
      buildControlledHarnessEnvironment('C:\\isolated-dsh', {
        OPENAI_API_KEY: 'must-not-leak',
        DEEPSEEK_API_KEY: 'must-not-leak'
      })
    ).not.toHaveProperty('OPENAI_API_KEY')
  })
})
