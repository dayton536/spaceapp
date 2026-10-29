import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphOverviewPayload } from "@space/contracts";
import { MEMORY_GRAPH_OVERVIEW_MAX_EDGE_LIMIT, MEMORY_GRAPH_OVERVIEW_MAX_NODE_LIMIT } from "@space/contracts";

export interface SyntheticMemoryGraphSize {
  nodes: number;
  edges: number;
}

/**
 * Clamps a requested benchmark size to the overview maximum and the 3:1 edge ratio.
 * 2,000 nodes target 6,000 edges; 50,000 nodes target 150,000 edges.
 */
export function syntheticMemoryGraphSize(nodeCount: number): SyntheticMemoryGraphSize {
  const nodes = Math.max(1, Math.min(MEMORY_GRAPH_OVERVIEW_MAX_NODE_LIMIT, Math.floor(nodeCount)));
  const edges = Math.min(MEMORY_GRAPH_OVERVIEW_MAX_EDGE_LIMIT, nodes * 3);
  return { nodes, edges };
}

/**
 * Builds a deterministic archive: one core file, a handful of sources, memories, and stable links.
 * The payload validates against `memoryGraphOverviewPayloadSchema`.
 */
export async function generateSyntheticMemoryGraph(nodeCount: number): Promise<MemoryGraphOverviewPayload> {
  const size = syntheticMemoryGraphSize(nodeCount);
  const sourceCount = Math.min(12, size.nodes);
  const nodes: MemoryGraphNode[] = [];
  for (let index = 0; index < size.nodes; index++) {
    nodes.push(syntheticNode(index, sourceCount));
    if (index > 0 && index % 4_000 === 0) await yieldToMain();
  }
  const edges: MemoryGraphEdge[] = [];
  const memories = size.nodes - sourceCount;
  for (let index = 0; index < memories && edges.length < size.edges; index++) {
    const source = index % sourceCount;
    edges.push({
      id: edgeId(edges.length),
      type: "CONTAINS",
      source: nodeId(source, sourceCount),
      target: nodeId(sourceCount + index, sourceCount)
    });
    if (edges.length % 6_000 === 0) await yieldToMain();
  }
  const memoryStart = sourceCount;
  let cursor = 0;
  while (edges.length < size.edges && memories > 1) {
    const from = memoryStart + (cursor % memories);
    const to = memoryStart + ((cursor * 17 + 1) % memories);
    if (from !== to) {
      edges.push({
        id: edgeId(edges.length),
        type: cursor % 5 === 0 ? "DERIVED_FROM" : "CONTAINS",
        source: nodeId(from, sourceCount),
        target: nodeId(to, sourceCount)
      });
    }
    cursor += 1;
    if (cursor % 6_000 === 0) await yieldToMain();
    if (cursor > memories * 4) break;
  }
  return overviewFrom(nodes, edges, sourceCount);
}

function syntheticNode(index: number, sourceCount: number): MemoryGraphNode {
  if (index < sourceCount) {
    const core = index === 0;
    const month = String((index % 8) + 1).padStart(2, "0");
    return {
      id: nodeId(index, sourceCount),
      type: "SOURCE",
      label: core ? "space.md" : `source-${index}.md`,
      sourcePath: core ? "/demo/memory/space.md" : `/demo/memory/space_memory_2026-${month}.md`,
      recordId: null
    };
  }
  const month = String((index % 8) + 1).padStart(2, "0");
  return {
    id: nodeId(index, sourceCount),
    type: "MEMORY",
    label: `Memory ${index}`,
    sourcePath: `/demo/memory/space_memory_2026-${month}.md`,
    recordId: nodeId(index, sourceCount)
  };
}

function overviewFrom(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], sourceCount: number): MemoryGraphOverviewPayload {
  const recordCount = nodes.filter(node => node.type === "MEMORY").length;
  return {
    version: 1,
    generatedAt: "2026-01-15T00:00:00.000Z",
    sourceHash: hex64(`synthetic:${nodes.length}:${edges.length}`),
    revisionHash: hex64(`revision:${nodes.length}:${edges.length}`),
    isStale: false,
    summary: {
      sourceCount,
      recordCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      issueCount: 0
    },
    nodes,
    edges,
    totalMatchingNodes: nodes.length,
    totalMatchingEdges: edges.length,
    truncated: false,
    layoutVersion: 1,
    filters: {
      q: null,
      nodeType: null,
      scope: null,
      roomId: null,
      sourcePath: null,
      lifecycleStatus: null,
      relationMode: "RELATIONS",
      month: null
    },
    months: ["2026-01"]
  };
}

function nodeId(index: number, sourceCount: number): string {
  if (index === 0) return "source:space-md";
  if (index < sourceCount) return `source:syn-${String(index).padStart(4, "0")}`;
  return `memory:syn-${String(index).padStart(6, "0")}`;
}

function edgeId(index: number): string {
  return `edge:syn-${String(index).padStart(6, "0")}`;
}

function hex64(seed: string): string {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const chunk = (hash >>> 0).toString(16).padStart(8, "0");
  return (chunk.repeat(8)).slice(0, 64);
}

function yieldToMain(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
