import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, PackedMemoryCoordinates3D } from "./memory-3d.js";
import { memoryCoordinateExtent } from "./memory-3d.js";

/** Instanced node vertex shader. Screen position matches `projectMemoryPoint`. */
export const MEMORY_GRAPH_NODE_VERTEX_SOURCE = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_center;
layout(location=2) in vec3 a_color;
layout(location=3) in float a_radius;
layout(location=4) in float a_state;
layout(location=5) in float a_glow;
uniform vec2 u_resolution;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
uniform float u_depthScale;
uniform float u_focusActive;
out vec3 v_color;
out float v_alpha;
out vec2 v_uv;
out float v_glow;
void main() {
  float cy = cos(u_yaw), sy = sin(u_yaw);
  float cp = cos(u_pitch), sp = sin(u_pitch);
  float x1 = a_center.x * cy + a_center.z * sy;
  float depth = -a_center.x * sy + a_center.z * cy;
  float y1 = a_center.y * cp - depth * sp;
  float z1 = a_center.y * sp + depth * cp;
  float perspective = 650.0 / max(120.0, 650.0 + z1 * u_scale);
  vec2 center = vec2(
    u_resolution.x * 0.5 + x1 * u_scale * u_zoom * perspective,
    u_resolution.y * 0.5 - y1 * u_scale * u_zoom * perspective
  );
  float highlighted = a_state >= 1.5 ? 1.0 : 0.0;
  float radius = max(1.0, a_radius * perspective * sqrt(max(u_zoom, 0.0001))) * (highlighted > 0.5 ? 1.5 : 1.0);
  vec2 pixel = center + a_corner * radius;
  vec2 ndc = vec2(pixel.x / u_resolution.x * 2.0 - 1.0, 1.0 - pixel.y / u_resolution.y * 2.0);
  float far = clamp(0.5 + z1 * u_depthScale, 0.0, 1.0);
  gl_Position = vec4(ndc, far * 2.0 - 1.0, 1.0);
  v_uv = a_corner;
  v_color = highlighted > 0.5 ? vec3(1.0) : a_color;
  float dimmed = u_focusActive > 0.5 && a_state < 0.5 ? 1.0 : 0.0;
  float perspAlpha = clamp(perspective, 0.4, 1.0);
  v_alpha = dimmed > 0.5 ? 0.2 : perspAlpha;
  v_glow = highlighted > 0.5 || a_glow > 0.5 ? 1.0 : 0.0;
}
`;

/** Disc fragment shader with a soft halo for the core node and the focused node. */
export const MEMORY_GRAPH_NODE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
in vec2 v_uv;
in float v_glow;
out vec4 fragColor;
void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;
  float edge = smoothstep(1.0, 0.78, d);
  float halo = v_glow * smoothstep(1.0, 0.15, d) * 0.45;
  float alpha = v_alpha * max(edge, halo);
  fragColor = vec4(v_color, alpha);
}
`;

/** Batched edge vertex shader. The same camera uniforms as the nodes. */
export const MEMORY_GRAPH_EDGE_VERTEX_SOURCE = `#version 300 es
layout(location=0) in vec3 a_position;
layout(location=1) in vec4 a_color;
uniform vec2 u_resolution;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
uniform float u_scale;
out vec4 v_color;
void main() {
  float cy = cos(u_yaw), sy = sin(u_yaw);
  float cp = cos(u_pitch), sp = sin(u_pitch);
  float x1 = a_position.x * cy + a_position.z * sy;
  float depth = -a_position.x * sy + a_position.z * cy;
  float y1 = a_position.y * cp - depth * sp;
  float z1 = a_position.y * sp + depth * cp;
  float perspective = 650.0 / max(120.0, 650.0 + z1 * u_scale);
  vec2 pixel = vec2(
    u_resolution.x * 0.5 + x1 * u_scale * u_zoom * perspective,
    u_resolution.y * 0.5 - y1 * u_scale * u_zoom * perspective
  );
  vec2 ndc = vec2(pixel.x / u_resolution.x * 2.0 - 1.0, 1.0 - pixel.y / u_resolution.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_color = a_color;
}
`;

/** Edge fragment shader. Color is stored per vertex. */
export const MEMORY_GRAPH_EDGE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }
`;

export interface MemoryGraphWebGLRenderer {
  /** Rebuilds static colors and radii when the visible graph changes. */
  setGraph(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[], colors: ReadonlyMap<string, string>): void;
  /** Uploads world positions. Pass the same generation to skip redundant uploads. */
  setCoordinates(packed: PackedMemoryCoordinates3D): void;
  /** Updates focus highlighting without touching positions. */
  setFocus(focusId: string | null, neighborIds: ReadonlySet<string>): void;
  /** Draws one frame. Returns false when the context is gone. */
  draw(camera: MemoryCamera3D, width: number, height: number): boolean;
  /** Releases GPU resources. */
  dispose(): void;
  readonly lastCpuMs: number;
}

/** Creates a renderer or throws when the context cannot compile the programs. */
export function createMemoryGraphWebGLRenderer(gl: WebGL2RenderingContext): MemoryGraphWebGLRenderer {
  const nodeProgram = linkProgram(gl, MEMORY_GRAPH_NODE_VERTEX_SOURCE, MEMORY_GRAPH_NODE_FRAGMENT_SOURCE);
  const edgeProgram = linkProgram(gl, MEMORY_GRAPH_EDGE_VERTEX_SOURCE, MEMORY_GRAPH_EDGE_FRAGMENT_SOURCE);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const centerBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();
  const radiusBuffer = gl.createBuffer();
  const stateBuffer = gl.createBuffer();
  const glowBuffer = gl.createBuffer();
  const edgePositionBuffer = gl.createBuffer();
  const edgeColorBuffer = gl.createBuffer();
  if (!quad || !centerBuffer || !colorBuffer || !radiusBuffer || !stateBuffer || !glowBuffer || !edgePositionBuffer || !edgeColorBuffer) {
    throw new Error("WebGL buffer allocation failed");
  }
  let nodes: readonly MemoryGraphNode[] = [];
  let includedEdges: MemoryGraphEdge[] = [];
  let indexById = new Map<string, number>();
  let edgePairs = new Int32Array();
  let focusId: string | null = null;
  let neighbors: ReadonlySet<string> = new Set();
  let uploadedGeneration = -1;
  let focusUploaded = "";
  let graphUploaded = false;
  let extent = 60;
  let lastCpuMs = 0;
  const api: MemoryGraphWebGLRenderer = {
    get lastCpuMs() { return lastCpuMs; },
    setGraph(nextNodes, nextEdges, colors) {
      nodes = nextNodes;
      indexById = new Map(nextNodes.map((node, index) => [node.id, index]));
      const colorsPacked = new Float32Array(nextNodes.length * 3);
      const radii = new Float32Array(nextNodes.length);
      const glow = new Float32Array(nextNodes.length);
      for (let i = 0; i < nextNodes.length; i++) {
        const node = nextNodes[i]!;
        const rgb = parseCssColor(colors.get(node.id) ?? "#7395ad");
        colorsPacked[i * 3] = rgb[0];
        colorsPacked[i * 3 + 1] = rgb[1];
        colorsPacked[i * 3 + 2] = rgb[2];
        const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        radii[i] = root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
        glow[i] = root ? 1 : 0;
      }
      upload(gl, colorBuffer, colorsPacked, gl.STATIC_DRAW);
      upload(gl, radiusBuffer, radii, gl.STATIC_DRAW);
      upload(gl, glowBuffer, glow, gl.STATIC_DRAW);
      const pairs: number[] = [];
      includedEdges = [];
      for (const edge of nextEdges) {
        const a = indexById.get(edge.source);
        const b = indexById.get(edge.target);
        if (a === undefined || b === undefined) continue;
        pairs.push(a, b);
        includedEdges.push(edge);
      }
      edgePairs = Int32Array.from(pairs);
      upload(gl, stateBuffer, new Float32Array(nextNodes.length), gl.DYNAMIC_DRAW);
      graphUploaded = true;
      uploadedGeneration = -1;
      focusUploaded = "";
      writeEdgeColors();
    },
    setCoordinates(packed) {
      if (packed.generation === uploadedGeneration && graphUploaded) return;
      const centers = new Float32Array(nodes.length * 3);
      const lookup = new Map(packed.ids.map((id, index) => [id, index]));
      for (let i = 0; i < nodes.length; i++) {
        const slot = lookup.get(nodes[i]!.id);
        if (slot === undefined) continue;
        centers[i * 3] = packed.xyz[slot * 3] ?? 0;
        centers[i * 3 + 1] = packed.xyz[slot * 3 + 1] ?? 0;
        centers[i * 3 + 2] = packed.xyz[slot * 3 + 2] ?? 0;
      }
      upload(gl, centerBuffer, centers, gl.DYNAMIC_DRAW);
      extent = memoryCoordinateExtent(centers);
      const edgePositions = new Float32Array(edgePairs.length * 3);
      for (let i = 0; i < edgePairs.length; i++) {
        const nodeIndex = edgePairs[i] ?? 0;
        edgePositions[i * 3] = centers[nodeIndex * 3] ?? 0;
        edgePositions[i * 3 + 1] = centers[nodeIndex * 3 + 1] ?? 0;
        edgePositions[i * 3 + 2] = centers[nodeIndex * 3 + 2] ?? 0;
      }
      upload(gl, edgePositionBuffer, edgePositions, gl.DYNAMIC_DRAW);
      uploadedGeneration = packed.generation;
    },
    setFocus(nextFocus, nextNeighbors) {
      focusId = nextFocus;
      neighbors = nextNeighbors;
      const key = `${nextFocus ?? ""}\n${[...nextNeighbors].sort().join("\n")}`;
      if (key === focusUploaded && graphUploaded) return;
      const states = new Float32Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const id = nodes[i]!.id;
        states[i] = id === focusId ? 2 : neighbors.has(id) ? 1 : 0;
      }
      upload(gl, stateBuffer, states, gl.DYNAMIC_DRAW);
      writeEdgeColors();
      focusUploaded = key;
    },
    draw(camera, width, height) {
      const started = performance.now();
      if (gl.isContextLost()) return false;
      const scale = Math.min(width, height) * 0.4 / extent;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      drawEdges(gl, edgeProgram, edgePositionBuffer, edgeColorBuffer, edgePairs.length, camera, width, height, scale, extent);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      drawNodes(gl, nodeProgram, quad, centerBuffer, colorBuffer, radiusBuffer, stateBuffer, glowBuffer, nodes.length, camera, width, height, scale, extent, focusId ? 1 : 0);
      lastCpuMs = performance.now() - started;
      return !gl.isContextLost();
    },
    dispose() {
      gl.deleteProgram(nodeProgram);
      gl.deleteProgram(edgeProgram);
      for (const buffer of [quad, centerBuffer, colorBuffer, radiusBuffer, stateBuffer, glowBuffer, edgePositionBuffer, edgeColorBuffer]) gl.deleteBuffer(buffer);
    }
  };
  function writeEdgeColors() {
    const edgeColors = new Float32Array(edgePairs.length * 4);
    for (let edgeIndex = 0; edgeIndex < includedEdges.length; edgeIndex++) {
      const edge = includedEdges[edgeIndex];
      const a = nodes[edgePairs[edgeIndex * 2] ?? 0]?.id;
      const b = nodes[edgePairs[edgeIndex * 2 + 1] ?? 0]?.id;
      const incident = Boolean(focusId) && (a === focusId || b === focusId);
      const rgb = incident ? [0x98 / 255, 0xda / 255, 0xfa / 255] : focusId ? [0x14 / 255, 0x20 / 255, 0x2b / 255] : edge?.type === "DERIVED_FROM" ? [0x38 / 255, 0x50 / 255, 0x68 / 255] : [0x20 / 255, 0x33 / 255, 0x43 / 255];
      for (let end = 0; end < 2; end++) {
        const offset = (edgeIndex * 2 + end) * 4;
        edgeColors[offset] = rgb[0]!;
        edgeColors[offset + 1] = rgb[1]!;
        edgeColors[offset + 2] = rgb[2]!;
        edgeColors[offset + 3] = 1;
      }
    }
    upload(gl, edgeColorBuffer, edgeColors, gl.DYNAMIC_DRAW);
  }
  return api;
}

/** Probes WebGL2 on a throwaway canvas so a failed probe cannot lose the visible context. */
export function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function upload(gl: WebGL2RenderingContext, buffer: WebGLBuffer, data: BufferSource, usage: number) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage);
}

function drawNodes(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  quad: WebGLBuffer,
  centers: WebGLBuffer,
  colors: WebGLBuffer,
  radii: WebGLBuffer,
  states: WebGLBuffer,
  glow: WebGLBuffer,
  count: number,
  camera: MemoryCamera3D,
  width: number,
  height: number,
  scale: number,
  extent: number,
  focusActive: number
) {
  if (!count) return;
  gl.useProgram(program);
  bindAttrib(gl, quad, 0, 2, 0, 0);
  gl.vertexAttribDivisor(0, 0);
  bindAttrib(gl, centers, 1, 3, 0, 1);
  bindAttrib(gl, colors, 2, 3, 0, 1);
  bindAttrib(gl, radii, 3, 1, 0, 1);
  bindAttrib(gl, states, 4, 1, 0, 1);
  bindAttrib(gl, glow, 5, 1, 0, 1);
  setCameraUniforms(gl, program, camera, width, height, scale, extent, focusActive);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  for (let location = 0; location <= 5; location++) gl.vertexAttribDivisor(location, 0);
}

function drawEdges(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  positions: WebGLBuffer,
  colors: WebGLBuffer,
  vertexCount: number,
  camera: MemoryCamera3D,
  width: number,
  height: number,
  scale: number,
  extent: number
) {
  if (!vertexCount) return;
  gl.useProgram(program);
  bindAttrib(gl, positions, 0, 3, 0, 0);
  bindAttrib(gl, colors, 1, 4, 0, 0);
  setCameraUniforms(gl, program, camera, width, height, scale, extent, 0);
  gl.drawArrays(gl.LINES, 0, vertexCount);
}

function bindAttrib(gl: WebGL2RenderingContext, buffer: WebGLBuffer, location: number, size: number, stride: number, divisor: number) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(location, divisor);
}

function setCameraUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, camera: MemoryCamera3D, width: number, height: number, scale: number, extent: number, focusActive: number) {
  const resolution = gl.getUniformLocation(program, "u_resolution");
  const yaw = gl.getUniformLocation(program, "u_yaw");
  const pitch = gl.getUniformLocation(program, "u_pitch");
  const zoom = gl.getUniformLocation(program, "u_zoom");
  const scaleLocation = gl.getUniformLocation(program, "u_scale");
  const depth = gl.getUniformLocation(program, "u_depthScale");
  const focus = gl.getUniformLocation(program, "u_focusActive");
  gl.uniform2f(resolution, Math.max(1, width), Math.max(1, height));
  gl.uniform1f(yaw, camera.yaw);
  gl.uniform1f(pitch, camera.pitch);
  gl.uniform1f(zoom, camera.zoom);
  gl.uniform1f(scaleLocation, scale);
  gl.uniform1f(depth, 1 / Math.max(1, extent * 4));
  if (focus) gl.uniform1f(focus, focusActive);
}

function linkProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL program allocation failed");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "link failed";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "compile failed";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

/** Parses `#rrggbb` into 0..1 channels. Anything else uses the atlas slate. */
export function parseCssColor(color: string): [number, number, number] {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255];
  }
  return [0x73 / 255, 0x95 / 255, 0xad / 255];
}
