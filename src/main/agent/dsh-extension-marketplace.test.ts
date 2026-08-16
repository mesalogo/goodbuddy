import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DshNpmExtensionInstaller,
  DshNpmMarketplaceCatalog,
  type PackageManagerRunner
} from './dsh-extension-marketplace'

const temporaryDirectories: string[] = []

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('DSH npm marketplace', () => {
  it('loads every npm search page and keeps only DSH plugin packages', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const from = Number(new URL(String(input)).searchParams.get('from'))
      return response({
        total: 251,
        objects:
          from === 0
            ? [
                {
                  package: {
                    name: 'dsh-plugin-greet',
                    version: '0.1.0',
                    description: 'A greeting tool.',
                    keywords: ['dsh-plugin'],
                    license: 'MIT',
                    links: {
                      repository:
                        'git+https://github.com/example/greet.git'
                    }
                  }
                },
                {
                  package: {
                    name: 'not-a-plugin',
                    version: '1.0.0',
                    keywords: ['unrelated']
                  }
                }
              ]
            : [
                {
                  package: {
                    name: 'dsh-second-plugin',
                    version: '2.0.0',
                    keywords: ['dsh-plugin']
                  }
                }
              ]
      })
    })
    const catalog = new DshNpmMarketplaceCatalog({
      fetcher,
      cacheTtlMs: 60_000
    })

    const entries = await catalog.list()

    expect(entries.map((entry) => entry.package.name)).toEqual([
      'dsh-plugin-greet',
      'dsh-second-plugin'
    ])
    expect(entries[0]).toMatchObject({
      description: 'A greeting tool.',
      repository: 'https://github.com/example/greet.git'
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await catalog.list()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent catalog loads', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    const catalog = new DshNpmMarketplaceCatalog({ fetcher })

    const first = catalog.list()
    const second = catalog.list()
    expect(fetcher).toHaveBeenCalledOnce()
    resolveFetch?.(
      response({
        total: 1,
        objects: [
          {
            package: {
              name: 'dsh-plugin-greet',
              version: '0.1.0',
              keywords: ['dsh-plugin']
            }
          }
        ]
      })
    )

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        expect.objectContaining({
          package: expect.objectContaining({
            name: 'dsh-plugin-greet'
          })
        })
      ],
      [
        expect.objectContaining({
          package: expect.objectContaining({
            name: 'dsh-plugin-greet'
          })
        })
      ]
    ])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('uses bundled npm to install the exact package and verifies its entrypoint', async () => {
    const destinationDirectory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-dsh-npm-installer-')
    )
    temporaryDirectories.push(destinationDirectory)
    const integrity = `sha512-${Buffer.from('verified').toString(
      'base64'
    )}`
    const packageName = 'dsh-plugin-greet'
    const version = '0.1.0'
    const manifest = {
      name: packageName,
      version,
      main: 'index.js',
      dist: { integrity },
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }
    const npmCliPath = join(destinationDirectory, 'npm-cli.js')
    await writeFile(npmCliPath, '// bundled npm fixture\n', 'utf8')
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        versions: {
          [version]: manifest
        }
      })
    )
    const runner: PackageManagerRunner = vi.fn(
      async (_command, _args, options) => {
        const installedDirectory = join(
          options.cwd,
          'node_modules',
          packageName
        )
        await mkdir(installedDirectory, { recursive: true })
        await Promise.all([
          writeFile(
            join(installedDirectory, 'package.json'),
            JSON.stringify(manifest),
            'utf8'
          ),
          writeFile(
            join(installedDirectory, 'index.js'),
            'export function apply() {}\n',
            'utf8'
          ),
          writeFile(
            join(options.cwd, 'package-lock.json'),
            JSON.stringify({
              packages: {
                [`node_modules/${packageName}`]: { integrity }
              }
            }),
            'utf8'
          )
        ])
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    )
    const installer = new DshNpmExtensionInstaller({
      dshHome: destinationDirectory,
      npmCliPath,
      fetcher,
      runner,
      environment: { PATH: 'C:\\Node' }
    })

    await expect(
      installer.install({
        entry: {
          id: 'greet',
          package: { name: packageName, version },
          displayName: packageName,
          description: 'A greeting tool.'
        },
        destinationDirectory
      })
    ).resolves.toEqual({
      entrypoint: `node_modules/${packageName}/index.js`,
      integrity
    })
    expect(runner).toHaveBeenCalledWith(
      process.execPath,
      [
        npmCliPath,
        'install',
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--dangerously-allow-all-scripts',
        '--loglevel=error',
        `${packageName}@${version}`
      ],
      expect.objectContaining({
        cwd: destinationDirectory,
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          npm_execpath: npmCliPath,
          npm_node_execpath: process.execPath
        })
      })
    )
    expect(
      (
        await stat(
          join(
            destinationDirectory,
            'package-manager-bin',
            process.platform === 'win32' ? 'node.cmd' : 'node'
          )
        )
      ).isFile()
    ).toBe(true)
  })

  it('rejects packages that do not declare a DSH bundle', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-dsh-not-plugin-')
    )
    temporaryDirectories.push(directory)
    const installer = new DshNpmExtensionInstaller({
      dshHome: directory,
      fetcher: vi.fn<typeof fetch>(async () =>
        response({
          versions: {
            '1.0.0': {
              name: 'not-a-dsh-plugin',
              version: '1.0.0',
              main: 'index.js',
              dist: {
                integrity: `sha512-${Buffer.from('verified').toString(
                  'base64'
                )}`
              }
            }
          }
        })
      ),
      runner: vi.fn()
    })

    await expect(
      installer.install({
        entry: {
          id: 'not-plugin',
          package: {
            name: 'not-a-dsh-plugin',
            version: '1.0.0'
          },
          displayName: 'Not a plugin',
          description: 'Missing DSH bundle metadata.'
        },
        destinationDirectory: directory
      })
    ).rejects.toThrow()
  })
})
