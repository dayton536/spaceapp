import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, memoryCoordinateExtent, type MemoryCamera3D, type MemoryPoint3D, type PackedMemoryCoordinates3D } from "./memory-3d.js";
import { createMemorySpatialPicker3D } from "./memory-3d-pick.js";
import { projectMemoryCoordinates } from "./memory-3d-pick.js";
import { selectMemoryLabels3D } from "./memory-3d-labels.js";
import { bindMemoryGraphContextRecovery, capMemoryGraphForCanvas2D, drawMemoryGraphCanvas2D, nextMemoryRendererMode, type MemoryRendererMode } from "./memory-graph-canvas2d.js";
import { createMemoryGraphWebGLRenderer, type MemoryGraphWebGLRenderer } from "./memory-graph-webgl.js";

export interface MemoryGraph3DHandle {
  /** Schedules a frame after streamed coordinates change. */
  redraw(): void;
}

export interface MemoryGraph3DProps {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  /** Packed worker snapshots. Read at draw time so layout ticks do not re-render React. */
  streamRef?: RefObject<PackedMemoryCoordinates3D | null>;
  /** Precomputed volume so a 50k cloud does not allocate a point per node on each render. */
  layoutVolume?: number;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  loading: boolean;
  resetToken: number;
}

const WEBGL_OPTIONS: WebGLContextAttributes = { alpha: true, antialias: false, depth: true, premultipliedAlpha: false, stencil: false };

/**
 * 3D memory graph. WebGL2 draws instanced nodes and batched edges; labels stay on a 2D overlay.
 * Without WebGL2, or after context loss, the same view falls back to the capped Canvas 2D renderer.
 */
export const MemoryGraph3D = forwardRef<MemoryGraph3DHandle, MemoryGraph3DProps>(function MemoryGraph3D(props, ref) {
  const { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, loading, resetToken, streamRef, layoutVolume } = props;
  const volumeRatio = useMemo(
    () => layoutVolume ?? memory3DVolumeRatio([...coordinates.values()]),
    [layoutVolume, coordinates]
  );
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, streamRef });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode, streamRef };
  const [rendererMode, setRendererMode] = useState<MemoryRendererMode | "pending">("pending");
  const rendererModeRef = useRef<MemoryRendererMode>("canvas2d");
  useImperativeHandle(ref, () => ({ redraw: () => redrawRef.current() }), []);
  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);
  useEffect(() => {
    const overlay = overlayRef.current;
    const glCanvas = glRef.current;
    if (!overlay || !glCanvas) return;
    const context = overlay.getContext("2d");
    const picker = createMemorySpatialPicker3D();
    let renderer: MemoryGraphWebGLRenderer | null = null;
    let frame = 0;
    let width = 1;
    let height = 1;
    let hover: string | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;
    let world = new Float32Array(0);
    let present = new Uint8Array(0);
    let sx = new Float32Array(0);
    let sy = new Float32Array(0);
    let sz = new Float32Array(0);
    let sp = new Float32Array(0);
    let radii = new Float32Array(0);
    let pickIds: string[] = [];
    let graphKey = "";
    let coordinateKey = "";
    let focusKey = "";
    let viewKey = "";
    let streamIds: readonly string[] | null = null;
    let streamLookup = new Map<string, number>();
    let mapCoordinates: Map<string, MemoryPoint3D> | null = null;
    let uploadGeneration = 1;
    let cachedExtent = 60;
    let cachedFocus: string | null | undefined;
    let cachedEdges: MemoryGraphEdge[] | null = null;
    let cachedNeighbors = new Set<string>();
    const lookupStream = (packed: PackedMemoryCoordinates3D) => {
      if (streamIds !== packed.ids) {
        streamIds = packed.ids;
        streamLookup = new Map(packed.ids.map((id, index) => [id, index]));
      }
      return streamLookup;
    };
    const applyMode = (mode: MemoryRendererMode) => {
      rendererModeRef.current = mode;
      overlay.dataset.renderer = mode;
      glCanvas.hidden = mode !== "webgl2";
      setRendererMode(mode);
    };
    const gl = glCanvas.getContext("webgl2", WEBGL_OPTIONS);
    const unbind = gl ? bindMemoryGraphContextRecovery(glCanvas, {
      onLost() {
        renderer?.dispose();
        renderer = null;
        applyMode(nextMemoryRendererMode(rendererModeRef.current, "context-lost"));
        redrawRef.current();
      },
      onRestored() {
        const restored = glCanvas.getContext("webgl2", WEBGL_OPTIONS);
        if (!restored) return;
        try {
          renderer = createMemoryGraphWebGLRenderer(restored);
          graphKey = "";
          coordinateKey = "";
          focusKey = "";
          applyMode(nextMemoryRendererMode("canvas2d", "context-restored"));
        } catch {
          renderer = null;
          applyMode("canvas2d");
        }
        redrawRef.current();
      }
    }) : () => {};
    if (gl) {
      try {
        renderer = createMemoryGraphWebGLRenderer(gl);
        applyMode("webgl2");
      } catch {
        renderer = null;
        applyMode("canvas2d");
      }
    } else applyMode("canvas2d");
    const ensure = (count: number) => {
      if (sx.length >= count) return;
      world = new Float32Array(count * 3);
      present = new Uint8Array(count);
      sx = new Float32Array(count);
      sy = new Float32Array(count);
      sz = new Float32Array(count);
      sp = new Float32Array(count);
      radii = new Float32Array(count);
      coordinateKey = "";
      mapCoordinates = null;
      viewKey = "";
    };
    const focusNeighbors = (focus: string | null, graphEdges: MemoryGraphEdge[]) => {
      if (focus === cachedFocus && graphEdges === cachedEdges) return cachedNeighbors;
      const neighbors = new Set<string>();
      if (focus) for (const edge of graphEdges) {
        if (edge.source === focus) neighbors.add(edge.target);
        else if (edge.target === focus) neighbors.add(edge.source);
      }
      cachedFocus = focus;
      cachedEdges = graphEdges;
      cachedNeighbors = neighbors;
      return neighbors;
    };
    const render = () => {
      frame = 0;
      const live = current.current;
      const mode = rendererModeRef.current;
      const streamed = live.streamRef?.current;
      const capped = mode === "canvas2d" ? capMemoryGraphForCanvas2D(live.nodes, live.edges) : { nodes: live.nodes, edges: live.edges };
      const focus = hover ?? live.selectedNodeId;
      if (mode === "canvas2d" && context) {
        const map = new Map<string, MemoryPoint3D>();
        if (streamed && streamed.generation > 0) {
          const lookup = lookupStream(streamed);
          for (const node of capped.nodes) {
            const slot = lookup.get(node.id);
            if (slot === undefined) continue;
            map.set(node.id, { x: streamed.xyz[slot * 3] ?? 0, y: streamed.xyz[slot * 3 + 1] ?? 0, z: streamed.xyz[slot * 3 + 2] ?? 0 });
          }
        } else for (const node of capped.nodes) {
          const point = live.coordinates.get(node.id);
          if (point) map.set(node.id, point);
        }
        const drawn = drawMemoryGraphCanvas2D(context, {
          nodes: capped.nodes, edges: capped.edges, positions: live.positions, coordinates: map,
          camera: cameraRef.current, width, height, showTitles: live.showTitles, focusId: focus
        });
        pickIds = drawn.map(point => point.id);
        ensure(drawn.length);
        for (let index = 0; index < drawn.length; index++) {
          sx[index] = drawn[index]!.x;
          sy[index] = drawn[index]!.y;
          sz[index] = drawn[index]!.z;
          radii[index] = drawn[index]!.radius;
        }
        picker.rebuild(pickIds, sx, sy, sz, radii, width, height);
      } else if (renderer && context) {
        const nextGraph = `${capped.nodes.length}:${capped.edges.length}:${capped.nodes[0]?.id ?? ""}:${capped.nodes.at(-1)?.id ?? ""}`;
        if (nextGraph !== graphKey) {
          const colors = new Map(capped.nodes.map(node => [node.id, live.positions.get(node.id)?.color ?? "#7395ad"]));
          renderer.setGraph(capped.nodes, capped.edges, colors);
          graphKey = nextGraph;
          coordinateKey = "";
          mapCoordinates = null;
        }
        ensure(capped.nodes.length);
        const generation = streamed && streamed.generation > 0 ? streamed.generation : 0;
        const nextView = `${cameraRef.current.yaw}|${cameraRef.current.pitch}|${cameraRef.current.zoom}|${width}|${height}|${generation}|${graphKey}`;
        if (generation > 0 && streamed && coordinateKey !== `s:${generation}`) {
          present.fill(0);
          const lookup = lookupStream(streamed);
          for (let index = 0; index < capped.nodes.length; index++) {
            const slot = lookup.get(capped.nodes[index]!.id);
            if (slot === undefined) continue;
            world[index * 3] = streamed.xyz[slot * 3] ?? 0;
            world[index * 3 + 1] = streamed.xyz[slot * 3 + 1] ?? 0;
            world[index * 3 + 2] = streamed.xyz[slot * 3 + 2] ?? 0;
            present[index] = 1;
          }
          cachedExtent = memoryCoordinateExtent(world.subarray(0, capped.nodes.length * 3));
          uploadGeneration += 1;
          renderer.setCoordinates({ generation: uploadGeneration, ids: capped.nodes.map(node => node.id), xyz: world.slice(0, capped.nodes.length * 3) });
          coordinateKey = `s:${generation}`;
          viewKey = "";
        } else if (generation === 0 && mapCoordinates !== live.coordinates) {
          present.fill(0);
          for (let index = 0; index < capped.nodes.length; index++) {
            const point = live.coordinates.get(capped.nodes[index]!.id);
            if (!point) continue;
            world[index * 3] = point.x;
            world[index * 3 + 1] = point.y;
            world[index * 3 + 2] = point.z;
            present[index] = 1;
          }
          cachedExtent = memoryCoordinateExtent(world.subarray(0, capped.nodes.length * 3));
          uploadGeneration += 1;
          renderer.setCoordinates({ generation: uploadGeneration, ids: capped.nodes.map(node => node.id), xyz: world.slice(0, capped.nodes.length * 3) });
          coordinateKey = "m";
          mapCoordinates = live.coordinates;
          viewKey = "";
        }
        const neighbors = focusNeighbors(focus, capped.edges);
        const nextFocus = `${focus ?? ""}\n${[...neighbors].sort().join("\n")}`;
        if (nextFocus !== focusKey) {
          renderer.setFocus(focus, neighbors);
          focusKey = nextFocus;
          viewKey = "";
        }
        if (!renderer.draw(cameraRef.current, width, height)) {
          renderer.dispose();
          renderer = null;
          applyMode("canvas2d");
          redrawRef.current();
          return;
        }
        if (nextView !== viewKey) {
          const scale = Math.min(width, height) * 0.4 / cachedExtent;
          projectMemoryCoordinates(world, present, cameraRef.current, scale, width, height, sx, sy, sz, sp);
          for (let index = 0; index < capped.nodes.length; index++) {
            const node = capped.nodes[index]!;
            const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
            const base = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
            const highlighted = node.id === focus ? 1.5 : 1;
            radii[index] = present[index] ? Math.max(1, base * (sp[index] ?? 1) * Math.sqrt(cameraRef.current.zoom)) * highlighted : 0;
          }
          pickIds = capped.nodes.map(node => node.id);
          picker.rebuild(pickIds, sx.subarray(0, capped.nodes.length), sy.subarray(0, capped.nodes.length), sz.subarray(0, capped.nodes.length), radii.subarray(0, capped.nodes.length), width, height);
          viewKey = nextView;
        }
        context.clearRect(0, 0, width, height);
        context.font = "11px system-ui, sans-serif";
        const visibleNodes = capped.nodes.filter((_, index) => present[index]);
        const labels = selectMemoryLabels3D({
          nodes: visibleNodes,
          screenX: compact(sx, present, capped.nodes.length),
          screenY: compact(sy, present, capped.nodes.length),
          screenZ: compact(sz, present, capped.nodes.length),
          focusId: focus,
          zoom: cameraRef.current.zoom,
          width,
          height,
          showTitles: live.showTitles,
          measure: text => context.measureText(text).width
        });
        for (const label of labels) {
          context.fillStyle = "#09111bea";
          context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
          context.fillStyle = label.core ? "#fff0b0" : "#c6dfed";
          context.fillText(label.text, label.x, label.y + 1);
        }
      }
      overlay.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    redrawRef.current = schedule;
    const resize = () => {
      const rect = overlay.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      overlay.width = pixelWidth;
      overlay.height = pixelHeight;
      glCanvas.width = pixelWidth;
      glCanvas.height = pixelHeight;
      context?.setTransform(dpr, 0, 0, dpr, 0, 0);
      coordinateKey = "";
      schedule();
    };
    const local = (event: PointerEvent) => {
      const rect = overlay.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const down = (event: PointerEvent) => {
      overlay.focus();
      overlay.setPointerCapture(event.pointerId);
      const point = local(event);
      pointers.set(event.pointerId, point);
      downX = point.x;
      downY = point.y;
      dragged = false;
      hover = null;
    };
    const move = (event: PointerEvent) => {
      const point = local(event);
      const previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(point.x - downX, point.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(point.x - other.x, point.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else {
          cameraRef.current.yaw += (point.x - previous.x) * 0.009;
          cameraRef.current.pitch += (point.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, point);
      } else {
        hover = picker.pick(point.x, point.y);
        overlay.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const point = local(event);
      if (!dragged && pointers.size === 1) {
        const id = picker.pick(point.x, point.y);
        if (id) current.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001)));
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        schedule();
      } else if (event.key === "Enter") {
        const node = current.current.nodes.find(item => item.id === current.current.selectedNodeId) ?? current.current.nodes.find(item => isMemoryCoreLabel(item.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(overlay);
    resize();
    overlay.addEventListener("pointerdown", down);
    overlay.addEventListener("pointermove", move);
    overlay.addEventListener("pointerup", up);
    overlay.addEventListener("pointercancel", cancel);
    overlay.addEventListener("wheel", wheel, { passive: false });
    overlay.addEventListener("keydown", key);
    return () => {
      unbind();
      renderer?.dispose();
      observer?.disconnect();
      cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      overlay.removeEventListener("pointerdown", down);
      overlay.removeEventListener("pointermove", move);
      overlay.removeEventListener("pointerup", up);
      overlay.removeEventListener("pointercancel", cancel);
      overlay.removeEventListener("wheel", wheel);
      overlay.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => { redrawRef.current(); }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);
  const fallback = rendererMode === "canvas2d" && nodes.length > 2000;
  return <div className="memory-3d-surface" data-renderer={rendererMode}>
    <canvas ref={glRef} className="memory-3d-webgl" aria-hidden="true" />
    <canvas ref={overlayRef} className="memory-3d-overlay" tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={loading} data-titles-visible={showTitles} data-layout-volume={volumeRatio.toFixed(4)} data-renderer={rendererMode} />
    {fallback ? <span className="memory-3d-fallback" role="status">Showing 2,000 nodes. WebGL is unavailable, so the rest of the graph stays hidden.</span> : null}
    <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
  </div>;
});

function compact(values: Float32Array, present: Uint8Array, count: number): Float32Array {
  let kept = 0;
  for (let index = 0; index < count; index++) if (present[index]) kept += 1;
  if (kept === count) return values.subarray(0, count);
  const out = new Float32Array(kept);
  let write = 0;
  for (let index = 0; index < count; index++) if (present[index]) out[write++] = values[index] ?? 0;
  return out;
}
