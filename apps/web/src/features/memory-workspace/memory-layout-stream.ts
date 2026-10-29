import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryNetwork3DSession, MEMORY_3D_EXACT_LAYOUT_LIMIT, type MemoryNetwork3DSession } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";

export interface MemoryLayoutStreamMessage {
  type: "tick" | "done";
  phase: "depth" | "positions";
  step: number;
  totalSteps: number;
  /** Node ids, in the same order as `xyz`. Omitted after the first depth snapshot. */
  ids?: string[];
  /** Depth snapshots are `[x, y, z, ...]`. The final positions snapshot is `[x, y, ...]`. */
  xyz: Float32Array;
}

export interface MemoryLayoutStreamer {
  /** Advances one time slice and emits a snapshot. Returns true when the stream is finished. */
  tick(budgetMs?: number): boolean;
}

/**
 * Streams 3D coordinates while the force simulation runs, then emits the 2D layout once.
 * The final 3D positions match `layoutMemoryNetwork3D` for graphs that use the exact solver.
 */
export function createMemoryLayoutStreamer(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  emit: (message: MemoryLayoutStreamMessage, transfer: ArrayBuffer[]) => void,
  now: () => number = () => performance.now()
): MemoryLayoutStreamer {
  const mode = nodes.length > MEMORY_3D_EXACT_LAYOUT_LIMIT ? "bounded" : "exact";
  const session = createMemoryNetwork3DSession(nodes, edges, { mode });
  let phase: "initial" | "depth" | "positions" | "complete" = session.totalSteps === 0 ? "positions" : "initial";
  let idsSent = false;
  return {
    tick(budgetMs = 12) {
      if (phase === "complete") return true;
      if (phase === "initial") {
        emitDepth(session, emit, "tick", idsSent);
        idsSent = true;
        phase = "depth";
        return false;
      }
      if (phase === "depth") {
        const started = now();
        while (!session.done && now() - started < budgetMs) session.advance(1);
        emitDepth(session, emit, "tick", false);
        if (!session.done) return false;
        phase = "positions";
        return false;
      }
      const positions = nodes.length > MEMORY_3D_EXACT_LAYOUT_LIMIT
        ? seedMemoryNetworkPositions(nodes, edges)
        : layoutMemoryNetwork(nodes, edges);
      const xyz = new Float32Array(session.ids.length * 2);
      session.ids.forEach((id, index) => {
        const point = positions.get(id);
        xyz[index * 2] = point?.x ?? 0;
        xyz[index * 2 + 1] = point?.y ?? 0;
      });
      emit({ type: "done", phase: "positions", step: 1, totalSteps: 1, ids: [...session.ids], xyz }, [xyz.buffer as ArrayBuffer]);
      phase = "complete";
      return true;
    }
  };
}

function emitDepth(
  session: MemoryNetwork3DSession,
  emit: (message: MemoryLayoutStreamMessage, transfer: ArrayBuffer[]) => void,
  type: "tick" | "done",
  includeIds: boolean
) {
  const xyz = session.snapshot();
  emit({
    type,
    phase: "depth",
    step: session.step,
    totalSteps: session.totalSteps,
    ...(includeIds ? { ids: [...session.ids] } : {}),
    xyz
  }, [xyz.buffer as ArrayBuffer]);
}

/**
 * Deterministic 2D seed used when the archive is too large for the full relaxation.
 * Small graphs still run `layoutMemoryNetwork`.
 */
export function seedMemoryNetworkPositions(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, { x: number; y: number }> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const points = ordered.map((node, i) => ({
    x: Math.cos((i / Math.max(1, ordered.length)) * Math.PI * 2) * 180,
    y: Math.sin((i / Math.max(1, ordered.length)) * Math.PI * 2) * 140
  }));
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (edge.type !== "CONTAINS") continue;
    const parent = index.get(edge.source);
    const child = index.get(edge.target);
    if (parent === undefined || child === undefined) continue;
    const angle = (child / Math.max(1, ordered.length)) * Math.PI * 2;
    points[child] = { x: points[parent]!.x + Math.cos(angle) * 28, y: points[parent]!.y + Math.sin(angle) * 28 };
  }
  return new Map(ordered.map((node, i) => [node.id, points[i]!]));
}

/**
 * Posts the graph to a layout worker in bounded chunks so no single clone exceeds a long task.
 * Returns a cancel function for the chunk timers.
 */
export function postMemoryLayoutGraph(worker: Worker, nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): () => void {
  const nodeChunk = 1_000;
  const edgeChunk = 3_000;
  let nodeOffset = 0;
  let edgeOffset = 0;
  let timer = 0;
  let cancelled = false;
  const pump = () => {
    if (cancelled) return;
    if (nodeOffset < nodes.length) {
      const next = Math.min(nodes.length, nodeOffset + nodeChunk);
      worker.postMessage({ kind: "nodes", offset: nodeOffset, total: nodes.length, nodes: nodes.slice(nodeOffset, next) });
      nodeOffset = next;
      timer = window.setTimeout(pump, 0);
      return;
    }
    if (edgeOffset < edges.length) {
      const next = Math.min(edges.length, edgeOffset + edgeChunk);
      worker.postMessage({ kind: "edges", offset: edgeOffset, total: edges.length, edges: edges.slice(edgeOffset, next) });
      edgeOffset = next;
      timer = window.setTimeout(pump, 0);
      return;
    }
    worker.postMessage({ kind: "start" });
  };
  pump();
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
