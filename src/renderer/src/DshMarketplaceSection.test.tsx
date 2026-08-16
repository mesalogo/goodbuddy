import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/contracts'
import type {
  RuntimeExtensionCatalogEntry,
  RuntimeExtensionMarketplaceInstalledState,
  RuntimeExtensionMarketplaceSnapshot
} from '../../shared/runtime-extension-contracts'
import { DshMarketplaceSection } from './DshMarketplaceSection'

const greet: RuntimeExtensionCatalogEntry = {
  id: 'dsh-plugin-greet',
  package: {
    name: 'dsh-plugin-greet',
    version: '0.1.0'
  },
  displayName: 'Greet',
  description: 'A deterministic greeting tool.',
  license: 'MIT'
}

const finder: RuntimeExtensionCatalogEntry = {
  id: 'dsh-find-plugin',
  package: {
    name: 'dsh-find-plugin',
    version: '0.3.6'
  },
  displayName: 'Plugin Finder',
  description: 'Find DSH plugins.',
  license: 'MIT'
}

const installedGreet: RuntimeExtensionMarketplaceInstalledState = {
  id: greet.id,
  package: greet.package,
  installedAt: '2026-08-16T00:00:00.000Z',
  enabled: true,
  configuration: {}
}

function marketplaceSnapshot(
  installed: RuntimeExtensionMarketplaceInstalledState[] = [],
  marketplaceEnabled = true
): RuntimeExtensionMarketplaceSnapshot {
  return {
    marketplaceEnabled,
    catalog: [greet, finder],
    installed
  }
}

let getSnapshot: ReturnType<typeof vi.fn>
let apply: ReturnType<typeof vi.fn>

beforeEach(() => {
  getSnapshot = vi.fn(async () => marketplaceSnapshot())
  apply = vi.fn(async () => marketplaceSnapshot([installedGreet]))
  Object.defineProperty(window, 'goodbuddy', {
    configurable: true,
    value: {
      runtimeExtensions: {
        getSnapshot,
        apply
      }
    } as unknown as DesktopApi
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DshMarketplaceSection', () => {
  it('starts off, loads no catalog UI, and can be enabled explicitly', async () => {
    const disabledSnapshot = {
      ...marketplaceSnapshot([], false),
      catalog: []
    }
    getSnapshot
      .mockResolvedValueOnce(disabledSnapshot)
      .mockResolvedValueOnce(marketplaceSnapshot())
    apply
      .mockResolvedValueOnce(marketplaceSnapshot())
      .mockResolvedValueOnce(disabledSnapshot)

    render(<DshMarketplaceSection onNotify={vi.fn()} />)

    const marketplaceSwitch = await screen.findByRole('switch', {
      name: '启用 DSH 插件市场'
    })
    expect(marketplaceSwitch).not.toBeChecked()
    expect(
      screen.getByText(/插件市场默认关闭/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()

    fireEvent.click(marketplaceSwitch)
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        type: 'set-marketplace-enabled',
        enabled: true
      })
    )
    expect(await screen.findByRole('searchbox')).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledTimes(2)

    fireEvent.click(
      screen.getByRole('switch', {
        name: '启用 DSH 插件市场'
      })
    )
    await waitFor(() =>
      expect(apply).toHaveBeenLastCalledWith({
        type: 'set-marketplace-enabled',
        enabled: false
      })
    )
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(
      screen.getByText(/不会停用或卸载已有插件/)
    ).toBeInTheDocument()
  })

  it('loads the catalog, filters locally, and shows startup failures', async () => {
    getSnapshot.mockResolvedValueOnce(
      marketplaceSnapshot([
        {
          ...installedGreet,
          enabled: false,
          lastError: 'Extension failed to start.'
        }
      ])
    )

    render(<DshMarketplaceSection onNotify={vi.fn()} />)

    expect(
      await screen.findByRole('heading', {
        name: 'DSH 插件市场'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/第三方插件的安装脚本、初始化代码及工具均以当前用户权限运行/)
    ).toBeInTheDocument()
    expect(screen.getByText('Greet')).toBeInTheDocument()
    expect(screen.getByText('Plugin Finder')).toBeInTheDocument()
    expect(
      screen.getByText(/插件上次启动失败，已自动停用/)
    ).toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'finder' }
    })

    expect(screen.queryByText('Greet')).not.toBeInTheDocument()
    expect(screen.getByText('Plugin Finder')).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledOnce()
  })

  it('requires explicit current-user permission confirmation before install', async () => {
    const onNotify = vi.fn()
    render(<DshMarketplaceSection onNotify={onNotify} />)
    await screen.findByText('Greet')

    fireEvent.click(
      screen.getAllByRole('button', {
        name: '安装并启用'
      })[0]!
    )

    const confirm = screen.getByRole('button', {
      name: '确认安装'
    })
    expect(confirm).toBeDisabled()
    expect(
      screen.getByText(/npm 会运行该包及其依赖声明的安装脚本/)
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByLabelText(
        '我信任 dsh-plugin-greet@0.1.0，并了解其代码将以当前用户权限运行。'
      )
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: '刷新 DSH 插件市场'
      })
    )
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2))
    expect(
      screen.queryByRole('button', {
        name: '确认安装'
      })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getAllByRole('button', {
        name: '安装并启用'
      })[0]!
    )
    const refreshedConfirm = screen.getByRole('button', {
      name: '确认安装'
    })
    expect(refreshedConfirm).toBeDisabled()
    fireEvent.click(
      screen.getByLabelText(
        '我信任 dsh-plugin-greet@0.1.0，并了解其代码将以当前用户权限运行。'
      )
    )
    fireEvent.click(refreshedConfirm)

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        type: 'install',
        extensionId: greet.id,
        package: greet.package
      })
    )
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'success',
        message: '已安装并启用 Greet'
      })
    )
  })

  it('toggles, configures, and removes installed plugins', async () => {
    getSnapshot.mockResolvedValueOnce(
      marketplaceSnapshot([installedGreet])
    )
    apply.mockImplementation(async (action) => {
      if (action.type === 'remove') {
        return marketplaceSnapshot()
      }
      return marketplaceSnapshot([
        {
          ...installedGreet,
          enabled:
            action.type === 'set-enabled'
              ? action.enabled
              : installedGreet.enabled,
          configuration:
            action.type === 'configure'
              ? action.configuration
              : installedGreet.configuration
        }
      ])
    })

    render(<DshMarketplaceSection onNotify={vi.fn()} />)
    const toggle = await screen.findByRole('switch', {
      name: '启用 Greet'
    })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        type: 'set-enabled',
        extensionId: greet.id,
        enabled: false
      })
    )

    fireEvent.click(screen.getByRole('button', { name: '配置' }))
    const editor = screen.getByRole('textbox', {
      name: 'Greet 配置 JSON'
    })
    fireEvent.change(editor, { target: { value: '[]' } })
    fireEvent.click(
      screen.getByRole('button', { name: '保存配置' })
    )
    expect(
      screen.getByText('配置必须是有效的 JSON 对象。')
    ).toBeInTheDocument()

    fireEvent.change(editor, {
      target: { value: '{"salutation":"你好"}' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存配置' })
    )
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        type: 'configure',
        extensionId: greet.id,
        configuration: { salutation: '你好' }
      })
    )

    fireEvent.click(
      screen.getByRole('button', { name: '移除 Greet' })
    )
    expect(
      screen.getByRole('alertdialog', { name: '移除 Greet' })
    ).toHaveAccessibleDescription(
      '移除 Greet 及其由 GoodBuddy 托管的文件？'
    )
    fireEvent.click(
      screen.getByRole('button', { name: '移除 Greet' })
    )
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        type: 'remove',
        extensionId: greet.id
      })
    )
  })

  it('keeps actions responsive through the Strict Mode effect cycle', async () => {
    const onNotify = vi.fn()
    getSnapshot.mockResolvedValue(
      marketplaceSnapshot([installedGreet])
    )
    apply.mockResolvedValue(
      marketplaceSnapshot([
        { ...installedGreet, enabled: false }
      ])
    )

    render(
      <StrictMode>
        <DshMarketplaceSection onNotify={onNotify} />
      </StrictMode>
    )
    fireEvent.click(
      await screen.findByRole('switch', {
        name: '启用 Greet'
      })
    )

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'success'
        })
      )
    )
    expect(
      screen.getByRole('switch', { name: '启用 Greet' })
    ).not.toBeDisabled()
  })

  it('keeps a failed catalog load recoverable', async () => {
    getSnapshot
      .mockRejectedValueOnce(new Error('npm registry unavailable'))
      .mockResolvedValueOnce(marketplaceSnapshot())

    render(<DshMarketplaceSection onNotify={vi.fn()} />)

    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent('npm registry unavailable')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('Greet')).toBeInTheDocument()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
  })

  it('keeps installed plugins manageable when npm catalog refresh fails', async () => {
    getSnapshot.mockResolvedValueOnce({
      marketplaceEnabled: true,
      catalog: [],
      installed: [installedGreet],
      catalogError: 'npm registry unavailable'
    })

    render(<DshMarketplaceSection onNotify={vi.fn()} />)

    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent(
      '无法刷新 npm 插件目录：npm registry unavailable。已安装插件仍可管理。'
    )
    expect(
      screen.getByRole('switch', { name: '启用 dsh-plugin-greet' })
    ).toBeChecked()
    expect(
      screen.getByRole('button', {
        name: '移除 dsh-plugin-greet'
      })
    ).toBeEnabled()
  })
})
