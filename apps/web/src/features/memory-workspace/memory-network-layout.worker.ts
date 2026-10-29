import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryLayoutStreamer, type MemoryLayoutStreamMessage } from "./memory-layout-stream.js";

interface NodeChunk { kind: "nodes"; offset: number; total: number; nodes: MemoryGraphNode[] }
interface EdgeChunk { kind: "edges"; offset: number; total: number; edges: MemoryGraphEdge[] }
interface StartMessage { kind: "start" }

let nodes: MemoryGraphNode[] = [];
let edges: MemoryGraphEdge[] = [];

/** Receives chunked graph payloads, then streams layout snapshots back to the UI thread. */
self.onmessage = (event: MessageEvent<NodeChunk | EdgeChunk | StartMessage>) => {
  const message = event.data;
  if (message.kind === "nodes") {
    if (message.offset === 0) nodes = new Array(message.total);
    for (let index = 0; index < message.nodes.length; index++) nodes[message.offset + index] = message.nodes[index]!;
    return;
  }
  if (message.kind === "edges") {
    if (message.offset === 0) edges = new Array(message.total);
    for (let index = 0; index < message.edges.length; index++) edges[message.offset + index] = message.edges[index]!;
    return;
  }
  const post = (self as unknown as { postMessage: (message: MemoryLayoutStreamMessage, transfer: ArrayBuffer[]) => void }).postMessage.bind(self);
  const streamer = createMemoryLayoutStreamer(nodes, edges, (snapshot, transfer) => {
    post(snapshot, transfer);
  });
  const pump = () => {
    if (streamer.tick()) return;
    self.setTimeout(pump, 0);
  };
  pump();
};
