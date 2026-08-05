import { describe, expect, it, vi } from 'vitest'
import type { ResolvedMcpServer } from './capability-service'
import {
  createCuratedMcpLaunch,
  type CuratedMcpFileSystem,
  type CuratedMcpPathMetadata
} from './curated-mcp-launch'

const transportMocks = vi.hoisted(() => ({
  stdio: vi.fn(function StdioClientTransport(options: unknown) {
    return { kind: 'stdio', options }
  }),
  http: vi.fn(),
  sse: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: transportMocks.stdio
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: transportMocks.http
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: transportMocks.sse
}))

import { createMcpTransport } from './mcp-client-transport'

const root = process.platform === 'win32' ? 'C:\\GoodBuddy' : '/opt/goodbuddy'
const executable =
  process.platform === 'win32'
    ? `${root}\\helpers\\curated.exe`
    : `${root}/helpers/curated`
const cwd =
  process.platform === 'win32'
    ? `${root}\\helpers`
    : `${root}/helpers`

const metadata = (
  canonicalPath: string,
  kind: 'directory' | 'file',
  overrides: Partial<CuratedMcpPathMetadata> = {}
): CuratedMcpPathMetadata => ({
  canonicalPath,
  uid: 1000,
  mode: kind === 'directory' ? 0o40755 : 0o100755,
  isDirectory: kind === 'directory',
  isFile: kind === 'file',
  isSymbolicLink: false,
  ...overrides
})

const fileSystem = (
  overrides: Readonly<Record<string, Partial<CuratedMcpPathMetadata>>> = {}
): CuratedMcpFileSystem => ({
  inspect: vi.fn(async (path: string) => {
    const kind = path === executable ? 'file' : 'directory'
    return metadata(path, kind, overrides[path])
  })
})

describe('curated MCP launches', () => {
  it('keeps raw custom stdio on the SDK default environment', () => {
    createMcpTransport({
      transport: 'stdio',
      command: 'custom-mcp',
      args: ['--serve'],
      env: { DISPLAY: ':0', TOKEN: 'secret' },
      cwd
    } as unknown as ResolvedMcpServer)

    expect(transportMocks.stdio).toHaveBeenLastCalledWith({
      command: 'custom-mcp',
      args: ['--serve'],
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
  })

  it('passes only validated values from an opaque curated descriptor', async () => {
    const validateLinuxDesktopEnvironment = vi.fn(async () => ({
      DISPLAY: ':1',
      WAYLAND_DISPLAY: 'wayland-1',
      XDG_RUNTIME_DIR: '/run/user/1000'
    }))
    const descriptor = await createCuratedMcpLaunch(
      {
        executable,
        args: ['--stdio'],
        cwd,
        ownedRoots: [root],
        ownerUid: 1000,
        allowedEnvironmentNames: ['LANG'],
        environment: { LANG: 'zh_CN.UTF-8' },
        linuxDesktopEnvironment: {
          source: {},
          uid: 1000,
          fileSystem: { inspect: vi.fn() }
        }
      },
      {
        fileSystem: fileSystem(),
        validateLinuxDesktopEnvironment
      }
    )

    createMcpTransport(descriptor)

    expect(validateLinuxDesktopEnvironment).toHaveBeenCalledOnce()
    expect(transportMocks.stdio).toHaveBeenLastCalledWith({
      command: executable,
      args: ['--stdio'],
      cwd,
      env: {
        LANG: 'zh_CN.UTF-8',
        DISPLAY: ':1',
        WAYLAND_DISPLAY: 'wayland-1',
        XDG_RUNTIME_DIR: '/run/user/1000'
      },
      stderr: 'ignore',
      maxBufferSize: 2 * 1024 * 1024
    })
  })

  it('rejects serialized attempts to spoof a curated descriptor', () => {
    expect(() =>
      createMcpTransport({
        transport: 'curated-stdio',
        command: executable,
        args: [],
        cwd,
        env: { DISPLAY: ':0' }
      } as unknown as ResolvedMcpServer)
    ).toThrow('无效的精选 MCP 启动描述')
  })

  it.each([
    ['symlink executable', { [executable]: { isSymbolicLink: true } }],
    [
      'non-canonical executable',
      { [executable]: { canonicalPath: `${executable}.real` } }
    ],
    ['wrong owner', { [cwd]: { uid: 2000 } }],
    ['writable root', { [root]: { mode: 0o40777 } }]
  ])('rejects an unsafe path: %s', async (_name, overrides) => {
    await expect(
      createCuratedMcpLaunch(
        {
          executable,
          cwd,
          ownedRoots: [root],
          ownerUid: 1000
        },
        { fileSystem: fileSystem(overrides) }
      )
    ).rejects.toThrow(/Unsafe curated MCP/u)
  })

  it.each([
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'GTK_MODULES',
    'QT_PLUGIN_PATH',
    'ELECTRON_RUN_AS_NODE',
    'CHROME_EXTRA_ARGS',
    'HTTPS_PROXY',
    'SERVICE_TOKEN'
  ])('rejects unsafe environment name %s', async (name) => {
    await expect(
      createCuratedMcpLaunch(
        {
          executable,
          cwd,
          ownedRoots: [root],
          ownerUid: 1000,
          allowedEnvironmentNames: [name],
          environment: { [name]: 'unsafe' }
        },
        { fileSystem: fileSystem() }
      )
    ).rejects.toThrow(/Unsafe curated MCP environment/u)
  })
})
