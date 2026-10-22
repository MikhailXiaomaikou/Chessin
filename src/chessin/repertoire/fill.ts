import type { TreeStore } from "@/state/store/tree";
import { getNodeAtPath } from "@/utils/treeReducer";
import type { Gap } from "./gaps";

/**
 * "填补": adds the gap's opponent move (reused when the tree already has it)
 * and optionally the chosen reply under it, as one undoable `makeMoves`
 * action, leaving the board on the last added node.
 */
export function fillGap(store: TreeStore, gap: Gap, replySan?: string): boolean {
    const state = store.getState();
    const parent = getNodeAtPath(state.root, gap.path);
    if (!parent || parent.fen !== gap.fen) return false;
    const before = store.getState().root;
    state.goToMove(gap.path);
    const payload = replySan ? [gap.san, replySan] : [gap.san];
    state.makeMoves({ payload, mainline: false, changeHeaders: false });
    const after = store.getState();
    const landed = getNodeAtPath(after.root, after.position);
    const expectedDepth = gap.path.length + payload.length;
    if (after.position.length !== expectedDepth) {
        // Nothing legal was added: put the board back where the caller left it.
        if (after.root === before) state.goToMove(gap.path);
        return false;
    }
    return landed.san === (replySan ?? gap.san);
}
