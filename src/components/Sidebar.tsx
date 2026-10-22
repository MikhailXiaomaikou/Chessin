import Nav from "@/chessin/shell/Nav";

/**
 * Chessin (S3-6): the icon-only sidebar became the six-position navigation
 * with text labels (`@/chessin/shell/Nav`, docs/chessbase-teardown.md §8.3
 * IA-1). The upstream export is kept so `__root.tsx` is unchanged here.
 */
export function SideBar() {
  return <Nav />;
}
