import { createContext, useRef } from "react";
import { useRegisterTreeStore } from "@/chessin/keymap/treeStores";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import type { TreeState } from "@/utils/treeReducer";

export const TreeStateContext = createContext<TreeStore | null>(null);

export function TreeStateProvider({
  id,
  initial,
  children,
}: {
  id?: string;
  initial?: TreeState;
  children: React.ReactNode;
}) {
  const store = useRef(createTreeStore(id, initial)).current;
  // Chessin: expose the store to app-wide commands (undo / redo / copy PGN from the palette).
  useRegisterTreeStore(id, store);

  return <TreeStateContext.Provider value={store}>{children}</TreeStateContext.Provider>;
}
