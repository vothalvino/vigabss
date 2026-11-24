// Shared by the Tree tab and the network map: the shape of GET /topology/tree
// and the small helpers both need.
import { apiFetch } from '@/api/apiFetch';

export type NodeId = number | string;

export interface TreeNode {
  id: NodeId;
  name: string;
  type: string;
  kind?: 'nas';
  nas_id?: number;
  make?: string | null;
  is_main?: boolean;
  status: string | null;
  ip_address: string | null;
  site_id: number | null;
  site_name: string | null;
  latitude: number | null;
  longitude: number | null;
  parent_id: number | null;
  children: TreeNode[];
}

export interface TreeSite { id: number; name: string; latitude: number | null; longitude: number | null }
export interface NetworkTree { trees: TreeNode[]; unplaced: TreeNode[]; sites: TreeSite[] }

export const TREE_QUERY_KEY = ['topology-tree'];

export async function fetchTree(): Promise<NetworkTree> {
  const res = await apiFetch<{ data: NetworkTree }>('/topology/tree');
  return res.data;
}

/** Every node of a list of trees, top first. */
export function flatten(list: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of list) { out.push(node); flatten(node.children, out); }
  return out;
}

/** The ids of a node and everything under it: where it cannot be moved to. */
export function branchIds(node: TreeNode): Set<NodeId> {
  return new Set(flatten([node]).map(n => n.id));
}

/** The translation key for a node's kind of equipment. */
export function typeKey(node: TreeNode): string {
  if (node.kind === 'nas') return node.is_main ? 'networkTree.types.mainNas' : 'networkTree.types.nas';
  return `networkTree.types.${node.type}`;
}
