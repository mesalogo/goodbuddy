export function formatShortcutForDisplay(
  accelerator: string,
  platform: string
): string {
  return accelerator
    .split('+')
    .map((key) => {
      if (key === 'CommandOrControl' || key === 'CmdOrCtrl') {
        return platform === 'darwin' ? 'Command' : 'Ctrl'
      }
      if (key === 'Control' || key === 'Ctrl') {
        return 'Ctrl'
      }
      if (key === 'Cmd' || key === 'Command') {
        return 'Command'
      }
      return key
    })
    .join('+')
}
