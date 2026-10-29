import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { memoryGraphOverviewPayloadSchema, type MemoryGraphEdge, type MemoryGraphNode } from "@space/contracts";
import { generateSyntheticMemoryGraph, syntheticMemoryGraphSize } from "../src/demo/synthetic-memory-graph.js";
import { MemoryGraph3D } from "../src/features/memory-workspace/MemoryGraph3D.js";
import { createMemoryLayoutStreamer } from "../src/features/memory-workspace/memory-layout-stream.js";
import { createMemoryNetwork3DSession, DEFAULT_MEMORY_CAMERA, layoutMemoryNetwork3D, projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";
import { createMemorySpatialPicker3D, projectMemoryCoordinates } from "../src/features/memory-workspace/memory-3d-pick.js";
import { MAX_MEMORY_3D_LABELS_DRAWN, MAX_MEMORY_3D_LABELS_MEASURED, selectMemoryLabels3D } from "../src/features/memory-workspace/memory-3d-labels.js";
import { bindMemoryGraphContextRecovery, CANVAS_2D_NODE_CAP, capMemoryGraphForCanvas2D, nextMemoryRendererMode } from "../src/features/memory-workspace/memory-graph-canvas2d.js";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY", label = id): MemoryGraphNode => ({
  id, type, label, sourcePath: null, recordId: type === "MEMORY" ? id : null
});

describe("memory graph WebGL helpers", () => {
  it("builds a contract-valid synthetic benchmark graph", async () => {
    expect(syntheticMemoryGraphSize(50_000)).toEqual({ nodes: 50_000, edges: 150_000 });
    expect(syntheticMemoryGraphSize(2_000)).toEqual({ nodes: 2_000, edges: 6_000 });
    const graph = await generateSyntheticMemoryGraph(48);
    expect(memoryGraphOverviewPayloadSchema.parse(graph).nodes.some(node => node.label === "space.md")).toBe(true);
    expect(graph.summary.sourceCount).toBeLessThanOrEqual(24);
  });

  it("projects packed coordinates with the same camera math as projectMemoryPoint", () => {
    const xyz = new Float32Array([12, -4, 30, 0, 0, 0]);
    const present = new Uint8Array([1, 1]);
    const sx = new Float32Array(2);
    const sy = new Float32Array(2);
    const sz = new Float32Array(2);
    const sp = new Float32Array(2);
    projectMemoryCoordinates(xyz, present, DEFAULT_MEMORY_CAMERA, 2, 1000, 700, sx, sy, sz, sp);
    const single = projectMemoryPoint({ x: 12, y: -4, z: 30 }, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    expect(sx[0]).toBeCloseTo(single.x);
    expect(sy[0]).toBeCloseTo(single.y);
    expect(sz[0]).toBeCloseTo(single.z);
    expect(sp[0]).toBeCloseTo(single.perspective);
  });

  it("picks the nearer node from the spatial index in under 4 ms at 50,000 nodes", () => {
    const count = 50_000;
    const ids = Array.from({ length: count }, (_, index) => `memory:${String(index).padStart(6, "0")}`);
    const xs = new Float32Array(count);
    const ys = new Float32Array(count);
    const zs = new Float32Array(count);
    const radii = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      xs[index] = (index * 17) % 1200;
      ys[index] = (index * 29) % 800;
      zs[index] = index;
      radii[index] = 4;
    }
    xs[10] = 400;
    ys[10] = 300;
    zs[10] = -1_000_000;
    const picker = createMemorySpatialPicker3D();
    for (let warm = 0; warm < 2; warm++) picker.rebuild(ids, xs, ys, zs, radii, 1200, 800);
    const rebuilds: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const started = performance.now();
      picker.rebuild(ids, xs, ys, zs, radii, 1200, 800);
      rebuilds.push(performance.now() - started);
    }
    const picks: number[] = [];
    for (let sample = 0; sample < 40; sample++) {
      const started = performance.now();
      expect(picker.pick(400, 300)).toBe("memory:000010");
      picks.push(performance.now() - started);
    }
    const percentile = (values: number[], p: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
    };
    const pickP95 = percentile(picks, 0.95);
    const rebuildP95 = percentile(rebuilds, 0.95);
    process.stdout.write(`MEMORY_PICK_BENCH ${JSON.stringify({ nodes: count, pickP95Ms: pickP95, rebuildP95Ms: rebuildP95 })}\n`);
    expect(pickP95).toBeLessThan(4);
    expect(rebuildP95).toBeLessThan(16);
    expect(picker.pick(5000, 5000)).toBeNull();
  });

  it("measures and draws a bounded number of labels and keeps the focused core", () => {
    const nodes = [node("source:space-md", "SOURCE", "space.md"), node("memory:focus", "MEMORY", "Focused memory")];
    for (let index = 0; index < 5_000; index++) nodes.push(node(`memory:${String(index).padStart(6, "0")}`, "MEMORY", `Memory ${index}`));
    const screenX = new Float32Array(nodes.length);
    const screenY = new Float32Array(nodes.length);
    const screenZ = new Float32Array(nodes.length);
    for (let index = 0; index < nodes.length; index++) {
      screenX[index] = 20 + (index % 40) * 12;
      screenY[index] = 30 + (index % 20) * 8;
      screenZ[index] = index;
    }
    screenX[0] = 400;
    screenY[0] = 80;
    screenX[1] = 40;
    screenY[1] = 400;
    let measured = 0;
    const labels = selectMemoryLabels3D({
      nodes,
      screenX,
      screenY,
      screenZ,
      focusId: "memory:focus",
      zoom: 2,
      width: 800,
      height: 600,
      showTitles: true,
      measure: () => { measured += 1; return 40; }
    });
    expect(measured).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_MEASURED);
    expect(labels.length).toBeLessThanOrEqual(MAX_MEMORY_3D_LABELS_DRAWN);
    expect(labels.map(label => label.id)).toContain("memory:focus");
    expect(labels.map(label => label.id)).toContain("source:space-md");
    expect(selectMemoryLabels3D({ ...{ nodes, screenX, screenY, screenZ, focusId: null, zoom: 2, width: 800, height: 600, measure: () => 10 }, showTitles: false })).toEqual([]);
  });

  it("streams layout snapshots and finishes on the same coordinates as the full solver", () => {
    const nodes = [node("source:space-md", "SOURCE", "space.md")];
    const edges: MemoryGraphEdge[] = [];
    for (let index = 0; index < 20; index++) {
      const id = `memory:stream-${String(index).padStart(4, "0")}`;
      nodes.push(node(id));
      edges.push({ id: `edge:stream-${String(index).padStart(4, "0")}`, type: "CONTAINS", source: "source:space-md", target: id });
    }
    const messages: Array<{ phase: string; step: number; xyz: Float32Array }> = [];
    const streamer = createMemoryLayoutStreamer(nodes, edges, message => {
      messages.push({ phase: message.phase, step: message.step, xyz: new Float32Array(message.xyz) });
    });
    let done = false;
    for (let guard = 0; guard < 1000 && !done; guard++) done = streamer.tick(50);
    expect(done).toBe(true);
    expect(messages[0]).toMatchObject({ phase: "depth", step: 0 });
    expect(messages.some(message => message.phase === "positions")).toBe(true);
    const layout = layoutMemoryNetwork3D(nodes, edges);
    const depth = [...messages].reverse().find(message => message.phase === "depth")!;
    const ids = [...layout.keys()].sort((a, b) => a.localeCompare(b));
    ids.forEach((id, index) => {
      const point = layout.get(id)!;
      expect(depth.xyz[index * 3]).toBeCloseTo(point.x, 2);
      expect(depth.xyz[index * 3 + 1]).toBeCloseTo(point.y, 2);
      expect(depth.xyz[index * 3 + 2]).toBeCloseTo(point.z, 2);
    });
    const boundedA = createMemoryNetwork3DSession(nodes, edges, { mode: "bounded" });
    const boundedB = createMemoryNetwork3DSession([...nodes].reverse(), [...edges].reverse(), { mode: "bounded" });
    boundedA.advance(boundedA.totalSteps);
    boundedB.advance(boundedB.totalSteps);
    expect([...boundedB.toMap()]).toEqual([...boundedA.toMap()]);
  });

  it("falls back to a 2,000 node canvas sample and restores after context loss", () => {
    expect(nextMemoryRendererMode("webgl2", "context-lost")).toBe("canvas2d");
    expect(nextMemoryRendererMode("canvas2d", "context-restored")).toBe("webgl2");
    expect(nextMemoryRendererMode("webgl2", "webgl-unavailable")).toBe("canvas2d");
    const nodes = Array.from({ length: 2_050 }, (_, index) => index === 0 ? node("source:space-md", "SOURCE", "space.md") : node(`memory:${String(index).padStart(6, "0")}`));
    const edges = nodes.slice(1, 20).map((item, index) => ({ id: `edge:cap-${String(index).padStart(4, "0")}`, type: "CONTAINS" as const, source: "source:space-md", target: item.id }));
    const capped = capMemoryGraphForCanvas2D(nodes, edges);
    expect(capped.nodes).toHaveLength(CANVAS_2D_NODE_CAP);
    expect(capped.nodes[0]?.id).toBe("source:space-md");
    const canvas = document.createElement("canvas");
    let lost = 0;
    let restored = 0;
    const unbind = bindMemoryGraphContextRecovery(canvas, { onLost: () => { lost += 1; }, onRestored: () => { restored += 1; } });
    const event = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(lost).toBe(1);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(restored).toBe(1);
    unbind();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(lost).toBe(1);
  });
});

describe("MemoryGraph3D fallback canvas", () => {
  it("keeps the accessible canvas and keyboard rotation when WebGL2 is missing", async () => {
    const context = {
      clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
      fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 24 }), setTransform: vi.fn(),
      lineWidth: 1, strokeStyle: "", fillStyle: "", globalAlpha: 1, font: "", shadowColor: "", shadowBlur: 0
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, type: string) {
      return (type === "webgl2" ? null : context) as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 640, height: 480, left: 0, top: 0, right: 640, bottom: 480, x: 0, y: 0, toJSON() { return {}; }
    });
    const nodes = [node("source:space-md", "SOURCE", "space.md"), node("memory:alpha")];
    const coordinates = new Map([["source:space-md", { x: 0, y: 0, z: 0 }], ["memory:alpha", { x: 30, y: 10, z: -20 }]]);
    render(<MemoryGraph3D nodes={nodes} edges={[]} positions={new Map()} coordinates={coordinates} showTitles selectedNodeId={null} onSelectNode={vi.fn()} loading={false} resetToken={0} />);
    const canvas = await screen.findByRole("application", { name: /3D memory graph/i });
    await waitFor(() => expect(canvas.getAttribute("data-renderer")).toBe("canvas2d"));
    expect(canvas.getAttribute("aria-busy")).toBe("false");
    expect(canvas.getAttribute("data-titles-visible")).toBe("true");
    expect(canvas.getAttribute("data-layout-volume")).toBeTruthy();
    const before = canvas.getAttribute("data-rotation");
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    await waitFor(() => expect(canvas.getAttribute("data-rotation")).not.toBe(before));
    vi.restoreAllMocks();
  });
});
