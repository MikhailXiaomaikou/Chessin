import { useAtomValue } from "jotai";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { startWorkspace, workspaceReadyAtom } from "./workspace";

// The index route imports this module while the app boots, so the restore
// starts before React renders anything and the saved tabs are in the atoms
// before `BoardsPage` mounts.
void startWorkspace();

/** Renders `children` once the saved workspace has been applied (nothing until then). */
export function WorkspaceGate({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const ready = useAtomValue(workspaceReadyAtom);
  useEffect(() => {
    void startWorkspace();
  }, []);
  return <>{ready ? children : fallback}</>;
}

/** Wraps a route component in `WorkspaceGate` (returns a function component, as routes expect). */
export function withWorkspaceGate<P extends object>(Component: ComponentType<P>) {
  const Gated = (props: P) => (
    <WorkspaceGate>
      <Component {...props} />
    </WorkspaceGate>
  );
  Gated.displayName = `WorkspaceGate(${Component.displayName ?? Component.name ?? "Component"})`;
  return Gated;
}
