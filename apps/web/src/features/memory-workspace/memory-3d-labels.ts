import type { MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

/** Hard cap on `measureText` calls per frame, whatever the graph size. */
export const MAX_MEMORY_3D_LABELS_MEASURED = 96;
/** Hard cap on labels actually painted after collision rejection. */
export const MAX_MEMORY_3D_LABELS_DRAWN = 40;

export interface MemoryLabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  core: boolean;
}

export interface MemoryLabelSelection {
  nodes: readonly MemoryGraphNode[];
  screenX: ArrayLike<number>;
  screenY: ArrayLike<number>;
  screenZ: ArrayLike<number>;
  focusId: string | null;
  zoom: number;
  width: number;
  height: number;
  showTitles: boolean;
  measure: (text: string) => number;
  maxMeasured?: number;
  maxDrawn?: number;
}

/**
 * Picks core and source labels first, then nearer nodes when zoomed in.
 * At most `maxMeasured` strings are measured and `maxDrawn` survive collision tests.
 */
export function selectMemoryLabels3D(input: MemoryLabelSelection): MemoryLabelPlacement[] {
  if (!input.showTitles) return [];
  const maxMeasured = input.maxMeasured ?? MAX_MEMORY_3D_LABELS_MEASURED;
  const maxDrawn = input.maxDrawn ?? MAX_MEMORY_3D_LABELS_DRAWN;
  const chosen = chooseLabelCandidates(input, maxMeasured);
  const boxes: Array<{ x: number; y: number; w: number }> = [];
  const placed: MemoryLabelPlacement[] = [];
  for (const index of chosen) {
    if (placed.length >= maxDrawn) break;
    const node = input.nodes[index];
    if (!node) continue;
    const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const x = (input.screenX[index] ?? 0) + 9;
    const y = input.screenY[index] ?? 0;
    const w = input.measure(label);
    if (x + w > input.width || y < 14 || y > input.height - 5) continue;
    if (boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
    boxes.push({ x, y, w });
    placed.push({ id: node.id, text: label, x, y, width: w, core: isMemoryCoreLabel(node.label) });
  }
  return placed;
}

function chooseLabelCandidates(input: MemoryLabelSelection, maxMeasured: number): number[] {
  const focus: number[] = [];
  const cores: number[] = [];
  const sources: number[] = [];
  let rest: number[] = [];
  const zoomed = input.zoom >= 1.6;
  const stride = Math.max(1, Math.ceil(input.nodes.length / 512));
  for (let i = 0; i < input.nodes.length; i++) {
    const node = input.nodes[i];
    if (!node) continue;
    if (node.id === input.focusId) { focus.push(i); continue; }
    if (isMemoryCoreLabel(node.label)) { cores.push(i); continue; }
    if (node.type === "SOURCE") { sources.push(i); continue; }
    if (!zoomed || i % stride !== 0) continue;
    rest = insertNearest(rest, i, input.screenZ, maxMeasured);
  }
  sources.sort((a, b) => (input.screenZ[a] ?? 0) - (input.screenZ[b] ?? 0) || (input.nodes[a]?.id ?? "").localeCompare(input.nodes[b]?.id ?? ""));
  const ordered = [...focus, ...cores, ...sources, ...rest];
  return ordered.slice(0, maxMeasured);
}

function insertNearest(current: number[], index: number, depth: ArrayLike<number>, cap: number): number[] {
  const z = depth[index] ?? 0;
  if (current.length < cap) {
    current.push(index);
    if (current.length === cap) current.sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0));
    return current;
  }
  const worst = current[current.length - 1] ?? index;
  if (z >= (depth[worst] ?? 0)) return current;
  current[current.length - 1] = index;
  current.sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0));
  return current;
}
