export type CapabilityStatus = 'supported' | 'degraded' | 'unavailable'

export type CapabilityCheck = {
  capability:
    | 'session-bus'
    | 'accessibility'
    | 'portal-screen-cast'
    | 'portal-remote-desktop'
    | 'pipewire'
    | 'eis'
    | 'x11'
    | 'xtest'
    | 'ydotool'
    | 'electron-capture'
  status: CapabilityStatus
  diagnostic: string
}

export type LinuxDesktopCapabilities = {
  overall: CapabilityStatus
  checks: CapabilityCheck[]
  sessionLabels: string[]
}

export interface LinuxCapabilityProbes {
  sessionBus(): Promise<boolean>
  accessibilityBus(): Promise<{
    busOwner: boolean
    registryOwner: boolean
  }>
  portalVersions(): Promise<{
    screenCast?: number
    remoteDesktop?: number
  }>
  pipeWire(): Promise<boolean>
  eis(): Promise<boolean>
  x11(): Promise<boolean>
  xTest(): Promise<boolean>
  ydotool(): Promise<boolean>
  electronCapture(): Promise<boolean>
}

const diagnostic = (
  available: boolean,
  positive: string,
  negative: string
): string => (available ? positive : negative)

const statusRank: Record<CapabilityStatus, number> = {
  unavailable: 0,
  degraded: 1,
  supported: 2
}

const settle = async <T>(
  probe: () => Promise<T>,
  fallback: T
): Promise<T> => {
  try {
    return await probe()
  } catch {
    return fallback
  }
}

const sessionLabels = (source: NodeJS.ProcessEnv): string[] => {
  const text = [
    source.XDG_CURRENT_DESKTOP,
    source.XDG_SESSION_DESKTOP,
    source.DESKTOP_SESSION
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(':')
    .toLowerCase()
  const labels = [
    ['gnome', 'GNOME'],
    ['kde', 'KDE'],
    ['deepin', 'DDE'],
    ['dde', 'DDE'],
    ['treeland', 'Treeland'],
    ['ukui', 'UKUI']
  ] as const
  return [
    ...new Set(
      labels
        .filter(([needle]) => text.includes(needle))
        .map(([, label]) => label)
    )
  ]
}

/**
 * Probes protocols and concrete operations. Desktop names are intentionally
 * excluded from capability decisions and are returned only as diagnostics.
 */
export async function probeLinuxDesktopCapabilities(
  probes: LinuxCapabilityProbes,
  environment: NodeJS.ProcessEnv = process.env
): Promise<LinuxDesktopCapabilities> {
  const [
    bus,
    accessibility,
    portals,
    pipeWire,
    eis,
    x11,
    xTest,
    ydotool,
    electronCapture
  ] = await Promise.all([
    settle(() => probes.sessionBus(), false),
    settle(() => probes.accessibilityBus(), {
      busOwner: false,
      registryOwner: false
    }),
    settle(() => probes.portalVersions(), {}),
    settle(() => probes.pipeWire(), false),
    settle(() => probes.eis(), false),
    settle(() => probes.x11(), false),
    settle(() => probes.xTest(), false),
    settle(() => probes.ydotool(), false),
    settle(() => probes.electronCapture(), false)
  ])

  const screenCast = portals.screenCast ?? 0
  const remoteDesktop = portals.remoteDesktop ?? 0
  const checks: CapabilityCheck[] = [
    {
      capability: 'session-bus',
      status: bus ? 'supported' : 'unavailable',
      diagnostic: diagnostic(
        bus,
        'Session bus responded',
        'Session bus did not respond'
      )
    },
    {
      capability: 'accessibility',
      status:
        accessibility.busOwner && accessibility.registryOwner
          ? 'supported'
          : accessibility.busOwner
            ? 'degraded'
            : 'unavailable',
      diagnostic:
        accessibility.busOwner && accessibility.registryOwner
          ? 'Accessibility bus and registry responded'
          : accessibility.busOwner
            ? 'Accessibility bus responded but registry is unavailable'
            : 'Accessibility bus is unavailable'
    },
    {
      capability: 'portal-screen-cast',
      status: screenCast > 0 ? 'supported' : 'unavailable',
      diagnostic:
        screenCast > 0
          ? `ScreenCast portal version ${screenCast} responded`
          : 'ScreenCast portal is unavailable'
    },
    {
      capability: 'portal-remote-desktop',
      status: remoteDesktop > 0 ? 'supported' : 'unavailable',
      diagnostic:
        remoteDesktop > 0
          ? `RemoteDesktop portal version ${remoteDesktop} responded`
          : 'RemoteDesktop portal is unavailable'
    },
    {
      capability: 'pipewire',
      status: pipeWire ? 'supported' : 'unavailable',
      diagnostic: diagnostic(
        pipeWire,
        'PipeWire connection succeeded',
        'PipeWire connection failed'
      )
    },
    {
      capability: 'eis',
      status: eis ? 'supported' : 'unavailable',
      diagnostic: diagnostic(
        eis,
        'EIS helper handshake succeeded',
        'EIS helper handshake failed'
      )
    },
    {
      capability: 'x11',
      status: x11 ? 'supported' : 'unavailable',
      diagnostic: diagnostic(
        x11,
        'X11 connection succeeded',
        'X11 connection failed'
      )
    },
    {
      capability: 'xtest',
      status: x11 && xTest ? 'supported' : 'unavailable',
      diagnostic:
        x11 && xTest
          ? 'XTest extension query succeeded'
          : 'XTest is unavailable on the proven display connection'
    },
    {
      capability: 'ydotool',
      status: ydotool ? 'supported' : 'unavailable',
      diagnostic: ydotool
        ? 'Optional ydotool helper passed its direct probe'
        : 'Optional ydotool helper is unavailable'
    },
    {
      capability: 'electron-capture',
      status: electronCapture ? 'supported' : 'unavailable',
      diagnostic: diagnostic(
        electronCapture,
        'Electron one-shot capture succeeded',
        'Electron one-shot capture failed'
      )
    }
  ]

  const usable = checks.filter(
    (check) =>
      check.capability !== 'session-bus' &&
      check.capability !== 'ydotool'
  )
  const best = usable.reduce<CapabilityStatus>(
    (current, check) =>
      statusRank[check.status] > statusRank[current] ? check.status : current,
    'unavailable'
  )

  return {
    overall: best,
    checks,
    sessionLabels: sessionLabels(environment)
  }
}
