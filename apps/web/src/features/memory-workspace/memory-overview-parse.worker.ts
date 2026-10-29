import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

interface OverviewBody {
  nodes?: MemoryGraphNode[];
  edges?: MemoryGraphEdge[];
}

/**
 * Parses a large overview payload off the UI thread and posts it back in bounded chunks.
 * The buffer is transferred, so the caller does not keep a second copy.
 */
self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const text = new TextDecoder().decode(event.data);
    const parsed = JSON.parse(text) as { data?: OverviewBody } | OverviewBody;
    const data = "data" in parsed && parsed.data ? parsed.data : parsed as OverviewBody;
    const nodes = data.nodes ?? [];
    const edges = data.edges ?? [];
    const header = { ...data };
    delete header.nodes;
    delete header.edges;
    self.postMessage({ kind: "header", header });
    for (let index = 0; index < nodes.length; index += 2_000) {
      self.postMessage({ kind: "nodes", nodes: nodes.slice(index, index + 2_000) });
    }
    for (let index = 0; index < edges.length; index += 4_000) {
      self.postMessage({ kind: "edges", edges: edges.slice(index, index + 4_000) });
    }
    self.postMessage({ kind: "done" });
  } catch (error) {
    self.postMessage({ kind: "error", message: error instanceof Error ? error.message : "Overview parse failed" });
  }
};
