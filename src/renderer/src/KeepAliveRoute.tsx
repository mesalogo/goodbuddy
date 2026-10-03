import { memo, type ReactNode } from "react";
import {
  WorkspaceUnsavedChangesContext,
  type ReportWorkspaceUnsavedChanges,
} from "./workspace-unsaved-changes";

type KeepAliveRouteProps = {
  active: boolean;
  children: ReactNode;
  onUnsavedChanges?: ReportWorkspaceUnsavedChanges;
  route: string;
};

// A hidden route keeps its last rendering: App re-renders on every chat
// update, and a route nobody sees must not re-render with it. It catches up
// with the latest children in the render that shows it again.
const keepHiddenRoute = (
  previous: KeepAliveRouteProps,
  next: KeepAliveRouteProps,
): boolean =>
  !previous.active && !next.active &&
  previous.route === next.route &&
  previous.onUnsavedChanges === next.onUnsavedChanges;

export const KeepAliveRoute = memo(function KeepAliveRoute({
  active,
  children,
  onUnsavedChanges,
  route,
}: KeepAliveRouteProps): React.JSX.Element {
  return (
    <div
      aria-hidden={active ? undefined : "true"}
      className="workspace-route-cache"
      data-route={route}
      hidden={!active}
      inert={!active}
    >
      <WorkspaceUnsavedChangesContext.Provider value={onUnsavedChanges}>
        {children}
      </WorkspaceUnsavedChangesContext.Provider>
    </div>
  );
}, keepHiddenRoute);
