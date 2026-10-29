import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const chrome = process.env.CHROME_PATH ?? "google-chrome";
const source = await readFile(new URL("../src/features/memory-workspace/memory-graph-webgl.ts", import.meta.url), "utf8");
const shader = (name) => {
  const marker = `export const ${name} = \``;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing shader ${name}`);
  const end = source.indexOf("`;", start + marker.length);
  return source.slice(start + marker.length, end);
};

const html = `<!doctype html>
<meta charset="utf-8">
<canvas id="c" width="1280" height="720"></canvas>
<pre id="out"></pre>
<script>
const NODE_VS = ${JSON.stringify(shader("MEMORY_GRAPH_NODE_VERTEX_SOURCE"))};
const NODE_FS = ${JSON.stringify(shader("MEMORY_GRAPH_NODE_FRAGMENT_SOURCE"))};
const EDGE_VS = ${JSON.stringify(shader("MEMORY_GRAPH_EDGE_VERTEX_SOURCE"))};
const EDGE_FS = ${JSON.stringify(shader("MEMORY_GRAPH_EDGE_FRAGMENT_SOURCE"))};
const sizes = [{ nodes: 2000, edges: 6000, budget: 16.7 }, { nodes: 50000, edges: 150000, budget: 33 }];
const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2", { antialias: false, depth: true, alpha: false });
const renderer = gl ? gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info")?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) : null;
function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader");
  return shader;
}
function program(vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link");
  return program;
}
function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
function bench(spec) {
  const nodeProgram = program(NODE_VS, NODE_FS);
  const edgeProgram = program(EDGE_VS, EDGE_FS);
  const centers = new Float32Array(spec.nodes * 3);
  const colors = new Float32Array(spec.nodes * 3);
  const radii = new Float32Array(spec.nodes);
  const states = new Float32Array(spec.nodes);
  const glow = new Float32Array(spec.nodes);
  for (let i = 0; i < spec.nodes; i++) {
    const angle = i * 0.173;
    centers[i * 3] = Math.cos(angle) * (40 + (i % 50));
    centers[i * 3 + 1] = ((i * 17) % 200) - 100;
    centers[i * 3 + 2] = Math.sin(angle) * (40 + (i % 50));
    colors[i * 3] = 0.4; colors[i * 3 + 1] = 0.7; colors[i * 3 + 2] = 0.9;
    radii[i] = i % 40 === 0 ? 4.6 : 2.1;
  }
  const edgePositions = new Float32Array(spec.edges * 6);
  const edgeColors = new Float32Array(spec.edges * 8);
  for (let i = 0; i < spec.edges; i++) {
    const a = i % spec.nodes;
    const b = (i * 7 + 1) % spec.nodes;
    edgePositions.set(centers.subarray(a * 3, a * 3 + 3), i * 6);
    edgePositions.set(centers.subarray(b * 3, b * 3 + 3), i * 6 + 3);
    edgeColors[i * 8 + 3] = 1; edgeColors[i * 8 + 7] = 1;
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const buffers = [centers, colors, radii, states, glow].map(data => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buffer;
  });
  const edgePositionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, edgePositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, edgePositions, gl.STATIC_DRAW);
  const edgeColorBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, edgeColors, gl.STATIC_DRAW);
  const frames = [];
  const yawStep = 0.03;
  let yaw = 0.3;
  const draw = (zoom) => {
    const started = performance.now();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(edgeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgePositionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeColorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(edgeProgram, "u_resolution"), canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(edgeProgram, "u_yaw"), yaw);
    gl.uniform1f(gl.getUniformLocation(edgeProgram, "u_pitch"), -0.15);
    gl.uniform1f(gl.getUniformLocation(edgeProgram, "u_zoom"), zoom);
    gl.uniform1f(gl.getUniformLocation(edgeProgram, "u_scale"), 2);
    gl.drawArrays(gl.LINES, 0, spec.edges * 2);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(nodeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    buffers.forEach((buffer, location) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location + 1);
      gl.vertexAttribPointer(location + 1, location === 0 || location === 1 ? 3 : 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location + 1, 1);
    });
    gl.uniform2f(gl.getUniformLocation(nodeProgram, "u_resolution"), canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_yaw"), yaw);
    gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_pitch"), -0.15);
    gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_zoom"), zoom);
    gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_scale"), 2);
    gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_depthScale"), 0.002);
    gl.uniform1f(gl.getUniformLocation(nodeProgram, "u_focusActive"), 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, spec.nodes);
    gl.finish();
    frames.push(performance.now() - started);
    yaw += yawStep;
  };
  const deadline = performance.now() + 12000;
  for (let i = 0; i < 2 && performance.now() < deadline; i++) draw(1);
  frames.length = 0;
  for (let i = 0; i < 8 && performance.now() < deadline; i++) draw(i % 2 === 0 ? 1 : 1.4);
  if (!frames.length) return { nodes: spec.nodes, edges: spec.edges, budgetMs: spec.budget, samples: 0, error: "no frames before the time budget" };
  return { nodes: spec.nodes, edges: spec.edges, budgetMs: spec.budget, samples: frames.length, p50: quantile(frames, 0.5), p95: quantile(frames, 0.95), max: Math.max(...frames) };
}
let results;
try {
  results = { renderer, frames: gl ? sizes.map(bench) : [], error: gl ? null : "webgl2 unavailable" };
} catch (error) {
  results = { renderer, frames: [], error: String(error && error.stack || error) };
}
document.getElementById("out").textContent = JSON.stringify(results);
</script>`;

const directory = await mkdtemp(join(tmpdir(), "memory-3d-bench-"));
const file = join(directory, "bench.html");
await writeFile(file, html);
const args = ["--headless=new", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${directory}/chrome`, "--dump-dom", pathToFileURL(file).href];
const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });
const code = await new Promise(resolve => child.on("close", resolve));
const match = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const parsed = match ? JSON.parse(match[1].replaceAll("&quot;", "\"").replaceAll("&amp;", "&")) : null;
const report = { chromeExit: code, parsed, stderr: stderr.slice(-2000) };
console.log(JSON.stringify(report, null, 2));
await rm(directory, { recursive: true, force: true });
if (!parsed) process.exitCode = 1;
