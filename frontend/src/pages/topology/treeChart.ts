// Where each box of the tree chart goes. The chart reads left to right: the
// main NAS on the left, what it feeds in the next column, and so on, so a
// piece that feeds many others grows downward instead of sideways.
import type { NodeId, TreeNode } from './networkTree';

export const BOX = { width: 196, height: 46, gapX: 56, gapY: 12 };
/** A tree with more boxes than this starts with its deeper branches closed. */
export const OPEN_ALL_UP_TO = 40;

export interface Placed {
  node: TreeNode;
  parent: Placed | null;
  depth: number;
  x: number;
  y: number;
  open: boolean;
  /** How many pieces are under this one, shown or not. */
  below: number;
}
export interface ChartLayout { items: Placed[]; width: number; height: number }

export function countBelow(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countBelow(child), 0);
}

/**
 * Which branches start open: all of them in a small tree; in a large one only
 * the main NAS and the way down to anything that has a problem.
 */
export function openByDefault(root: TreeNode, troubled: (node: TreeNode) => boolean, limit = OPEN_ALL_UP_TO): Set<NodeId> {
  const open = new Set<NodeId>();
  const small = countBelow(root) + 1 <= limit;
  const visit = (node: TreeNode, depth: number): boolean => {
    let troubleBelow = false;
    for (const child of node.children) {
      const inChild = visit(child, depth + 1);
      troubleBelow = troubleBelow || inChild || troubled(child);
    }
    if (node.children.length > 0 && (small || depth === 0 || troubleBelow)) open.add(node.id);
    return troubleBelow;
  };
  visit(root, 0);
  return open;
}

/** Place a tree's boxes. A closed branch takes one row, like a leaf. */
export function layout(root: TreeNode, isOpen: (node: TreeNode) => boolean): ChartLayout {
  const items: Placed[] = [];
  let row = 0;
  let deepest = 0;
  const place = (node: TreeNode, depth: number, parent: Placed | null): Placed => {
    const open = node.children.length > 0 && isOpen(node);
    const placed: Placed = { node, parent, depth, x: depth * (BOX.width + BOX.gapX), y: 0, open, below: countBelow(node) };
    items.push(placed);
    deepest = Math.max(deepest, depth);
    if (!open) {
      placed.y = row * (BOX.height + BOX.gapY);
      row += 1;
    } else {
      const children = node.children.map(child => place(child, depth + 1, placed));
      placed.y = (children[0].y + children[children.length - 1].y) / 2;
    }
    return placed;
  };
  place(root, 0, null);
  return {
    items,
    width: deepest * (BOX.width + BOX.gapX) + BOX.width,
    height: row * (BOX.height + BOX.gapY) - BOX.gapY,
  };
}

/**
 * The line from a box to the one that feeds it. Each line is its own curve:
 * lines sharing a trunk would hide each other's colour.
 */
export function edgePath(child: Placed): string {
  if (!child.parent) return '';
  const fromX = child.parent.x + BOX.width;
  const fromY = child.parent.y + BOX.height / 2;
  const toY = child.y + BOX.height / 2;
  const midX = fromX + BOX.gapX / 2;
  return `M ${fromX} ${fromY} C ${midX} ${fromY} ${midX} ${toY} ${child.x} ${toY}`;
}
