import { workspaceFileIconName, workspaceFileIconUrl } from './workspace-file-icons'

export function WorkspaceFileIcon({ path, directory = false, expanded = false }: {
  path: string
  directory?: boolean
  expanded?: boolean
}): React.JSX.Element {
  const dark = workspaceFileIconName(path, directory, expanded)
  const light = workspaceFileIconName(path, directory, expanded, true)
  return <span className="workspace-file-icon" aria-hidden="true">
    <img className={light === dark ? undefined : 'workspace-file-icon__dark'} src={workspaceFileIconUrl(dark)} alt="" width={16} height={16} draggable={false} />
    {light !== dark && <img className="workspace-file-icon__light" src={workspaceFileIconUrl(light)} alt="" width={16} height={16} draggable={false} />}
  </span>
}
