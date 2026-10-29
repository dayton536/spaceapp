import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import { projectMemoryPoint } from "./memory-3d.js";
import { selectMemoryLabels3D } from "./memory-3d-labels.js";

/** Canvas 2D fallback never paints more than the historical overview sample. */
export const CANVAS_2D_NODE_CAP = 2_000;
export const CANVAS_2D_EDGE_CAP = 6_000;

export type MemoryRendererMode = "webgl2" | "canvas2d";

/** Renderer mode after WebGL availability and context-loss events. */
export function nextMemoryRendererMode(current: MemoryRendererMode, event: "context-lost" | "context-restored" | "webgl-unavailable" | "webgl-ready"): MemoryRendererMode {
  if (event === "context-lost" || event === "webgl-unavailable") return "canvas2d";
  if (event === "context-restored" || event === "webgl-ready") return "webgl2";
  return current;
}

/**
 * Subscribes to context loss and restoration. Loss is cancelled so the browser may restore the context.
 * Returns a function that removes both listeners.
 */
export function bindMemoryGraphContextRecovery(canvas: HTMLCanvasElement, handlers: { onLost: () => void; onRestored: () => void }): () => void {
  const onLost = (event: Event) => {
    event.preventDefault();
    handlers.onLost();
  };
  const onRestored = () => handlers.onRestored();
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return () => {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}

/**
 * Keeps core and source nodes, then fills up to the Canvas 2D cap.
 * Edges are limited to connections inside that subset.
 */
export function capMemoryGraphForCanvas2D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  if (nodes.length <= CANVAS_2D_NODE_CAP && edges.length <= CANVAS_2D_EDGE_CAP) return { nodes, edges };
  const ranked = [...nodes].sort((a, b) =>
    Number(isMemoryCoreLabel(b.label)) - Number(isMemoryCoreLabel(a.label)) ||
    Number(b.type === "SOURCE") - Number(a.type === "SOURCE") ||
    a.id.localeCompare(b.id)
  ).slice(0, CANVAS_2D_NODE_CAP);
  const ids = new Set(ranked.map(node => node.id));
  const keptEdges = edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
    .sort((a, b) => Number(b.type === "CONTAINS" || b.type === "DERIVED_FROM") - Number(a.type === "CONTAINS" || a.type === "DERIVED_FROM") || a.id.localeCompare(b.id))
    .slice(0, CANVAS_2D_EDGE_CAP);
  return { nodes: ranked, edges: keptEdges };
}

export interface Canvas2DDrawInput {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, { color?: string }>;
  coordinates: Map<string, MemoryPoint3D>;
  camera: MemoryCamera3D;
  width: number;
  height: number;
  showTitles: boolean;
  focusId: string | null;
}

/**
 * Draws the historical Canvas 2D memory graph: edges, depth-sorted discs, then LOD labels.
 * Returns the projected discs so hit-testing can share the same positions.
 */
export function drawMemoryGraphCanvas2D(context: CanvasRenderingContext2D, input: Canvas2DDrawInput): Array<{ id: string; x: number; y: number; z: number; radius: number }> {
  const { nodes, edges, positions, coordinates, camera, width, height, showTitles, focusId } = input;
  context.clearRect(0, 0, width, height);
  let extent = 60;
  for (const point of coordinates.values()) {
    const distance = Math.hypot(point.x, point.y, point.z);
    if (distance > extent) extent = distance;
  }
  const scale = Math.min(width, height) * 0.4 / extent;
  const projected = new Map(nodes.flatMap(node => {
    const point = coordinates.get(node.id);
    return point ? [[node.id, projectMemoryPoint(point, camera, scale, width, height)] as const] : [];
  }));
  const neighbors = new Set<string>();
  if (focusId) for (const edge of edges) {
    if (edge.source === focusId) neighbors.add(edge.target);
    if (edge.target === focusId) neighbors.add(edge.source);
  }
  context.lineWidth = 0.55;
  for (const edge of edges) {
    const a = projected.get(edge.source), b = projected.get(edge.target);
    if (!a || !b) continue;
    const incident = edge.source === focusId || edge.target === focusId;
    context.strokeStyle = incident ? "#98dafa" : focusId ? "#14202b" : edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
    context.lineWidth = incident ? 1.15 : 0.55;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  const points: Array<{ id: string; x: number; y: number; z: number; radius: number }> = [];
  const ordered = nodes.filter(node => projected.has(node.id)).sort((a, b) => projected.get(b.id)!.z - projected.get(a.id)!.z);
  const screenX = new Float32Array(ordered.length);
  const screenY = new Float32Array(ordered.length);
  const screenZ = new Float32Array(ordered.length);
  for (let index = 0; index < ordered.length; index++) {
    const node = ordered[index]!;
    const point = projected.get(node.id)!;
    const highlighted = node.id === focusId;
    const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * point.perspective * Math.sqrt(camera.zoom)) * (highlighted ? 1.5 : 1);
    points.push({ id: node.id, ...point, radius });
    screenX[index] = point.x;
    screenY[index] = point.y;
    screenZ[index] = point.z;
    context.globalAlpha = focusId && !highlighted && !neighbors.has(node.id) ? 0.2 : Math.max(0.4, Math.min(1, point.perspective));
    context.fillStyle = highlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
    if (root || highlighted) {
      context.shadowColor = context.fillStyle;
      context.shadowBlur = 13;
    }
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }
  context.globalAlpha = 1;
  context.font = "11px system-ui, sans-serif";
  if (showTitles) {
    const labels = selectMemoryLabels3D({
      nodes: ordered,
      screenX,
      screenY,
      screenZ,
      focusId,
      zoom: camera.zoom,
      width,
      height,
      showTitles,
      measure: text => context.measureText(text).width
    });
    context.font = "11px system-ui, sans-serif";
    for (const label of labels) {
      context.fillStyle = "#09111bea";
      context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
      context.fillStyle = label.core ? "#fff0b0" : "#c6dfed";
      context.fillText(label.text, label.x, label.y + 1);
    }
  }
  return points;
}
