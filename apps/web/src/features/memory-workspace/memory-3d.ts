import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/** Node count at which the worker switches to the bounded, deterministic repulsion grid. */
export const MEMORY_3D_EXACT_LAYOUT_LIMIT = 4_096;
const EXACT_LAYOUT_STEPS = 180;
const BOUNDED_LAYOUT_STEPS = 36;

export interface MemoryNetwork3DSession {
  readonly ids: readonly string[];
  step: number;
  readonly totalSteps: number;
  done: boolean;
  /** Runs up to `steps` simulation iterations. The final positions stay deterministic. */
  advance(steps?: number): void;
  /** Copies the current coordinates into a transferable buffer. */
  snapshot(): Float32Array;
  /** Full-precision coordinates keyed by node id. */
  toMap(): Map<string, MemoryPoint3D>;
}

/**
 * Builds a resumable 3D layout. `exact` matches `layoutMemoryNetwork3D`.
 * `bounded` keeps the same seeding and springs but caps repulsion work so
 * large graphs can stream from the worker.
 */
export function createMemoryNetwork3DSession(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  options?: { mode?: "exact" | "bounded" }
): MemoryNetwork3DSession {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const mode = options?.mode ?? (count > MEMORY_3D_EXACT_LAYOUT_LIMIT ? "bounded" : "exact");
  const totalSteps = count === 0 ? 0 : mode === "exact" ? EXACT_LAYOUT_STEPS : BOUNDED_LAYOUT_STEPS;
  const points = ordered.map(node => ({
    x: (unit(`${node.id}:x`) - 0.5) * 260,
    y: (unit(`${node.id}:y`) - 0.5) * 260,
    z: (unit(`${node.id}:z`) - 0.5) * 260
  }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const linkEdges = mode === "exact" ? [...edges].sort((a, b) => a.id.localeCompare(b.id)) : [...edges].sort((a, b) => a.id.localeCompare(b.id));
  const links = linkEdges.flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  const seedEdges = mode === "exact" ? edges : [...edges].sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of seedEdges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
      y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
  }
  const source = ordered.map(node => node.type === "SOURCE");
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const session: MemoryNetwork3DSession = {
    ids: ordered.map(node => node.id),
    step: 0,
    totalSteps,
    done: totalSteps === 0,
    advance(steps = 1) {
      const budget = Math.max(0, Math.floor(steps));
      for (let n = 0; n < budget && session.step < totalSteps; n++) {
        if (mode === "exact") stepExact(points, links, source, fx, fy, fz, root, session.step);
        else stepBounded(points, links, source, fx, fy, fz, root, session.step, totalSteps);
        session.step += 1;
      }
      session.done = session.step >= totalSteps;
    },
    snapshot() {
      const out = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const point = points[i]!;
        out[i * 3] = point.x;
        out[i * 3 + 1] = point.y;
        out[i * 3 + 2] = point.z;
      }
      return out;
    },
    toMap() {
      return new Map(ordered.map((node, i) => [node.id, { ...points[i]! }]));
    }
  };
  return session;
}

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const session = createMemoryNetwork3DSession(nodes, edges, { mode: "exact" });
  session.advance(session.totalSteps);
  return session.toMap();
}

function stepExact(
  points: Array<{ x: number; y: number; z: number }>,
  links: Array<{ a: number; b: number; length: number; strength: number }>,
  source: boolean[],
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
  root: number,
  step: number
) {
  const count = points.length;
  fx.fill(0); fy.fill(0); fz.fill(0);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }
  for (let i = 0; i < count; i++) {
    const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
      for (const j of grid.get(`${x},${y},${z}`) ?? []) {
        if (j <= i) continue;
        const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
        const strength = (source[i] || source[j] ? 28 : 12) / distanceSquared;
        fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
        fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
      }
    }
  }
  applySpringsAndIntegrate(points, links, fx, fy, fz, root, 1 - step / 230);
}

function stepBounded(
  points: Array<{ x: number; y: number; z: number }>,
  links: Array<{ a: number; b: number; length: number; strength: number }>,
  source: boolean[],
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
  root: number,
  step: number,
  totalSteps: number
) {
  const count = points.length;
  const cell = 48;
  const cap = 8;
  fx.fill(0); fy.fill(0); fz.fill(0);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const p = points[i]!;
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    if (bucket.length < cap) bucket.push(i);
  }
  for (let i = 0; i < count; i++) {
    const p = points[i]!, gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell), gz = Math.floor(p.z / cell);
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
      for (const j of grid.get(`${x},${y},${z}`) ?? []) {
        if (j <= i) continue;
        const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
        const strength = (source[i] || source[j] ? 28 : 12) / distanceSquared;
        fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
        fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
      }
    }
  }
  applySpringsAndIntegrate(points, links, fx, fy, fz, root, 1 - step / (totalSteps + 50));
}

function applySpringsAndIntegrate(
  points: Array<{ x: number; y: number; z: number }>,
  links: Array<{ a: number; b: number; length: number; strength: number }>,
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
  root: number,
  cooling: number
) {
  for (const link of links) {
    const a = points[link.a]!, b = points[link.b]!;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
    const spring = (distance - link.length) * link.strength / distance;
    fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
    fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
  }
  for (let i = 0; i < points.length; i++) {
    if (i === root) continue;
    const p = points[i]!;
    const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
    const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
    p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
  }
}

/** Projects one world point with the same yaw, pitch, zoom and perspective the shaders use. */
export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Float32 coordinates streamed from the layout worker. `generation` bumps on every snapshot. */
export interface PackedMemoryCoordinates3D {
  generation: number;
  ids: readonly string[];
  xyz: Float32Array;
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

/** Volume ratio for a packed `[x, y, z, ...]` buffer, without allocating a point per node. */
export function memory3DVolumeRatioFromXYZ(xyz: ArrayLike<number>): number {
  const count = Math.floor(xyz.length / 3);
  if (count < 4) return 0;
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < count; i++) {
    sx += Number(xyz[i * 3]);
    sy += Number(xyz[i * 3 + 1]);
    sz += Number(xyz[i * 3 + 2]);
  }
  const cx = sx / count, cy = sy / count, cz = sz / count;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < count; i++) {
    const x = Number(xyz[i * 3]) - cx, y = Number(xyz[i * 3 + 1]) - cy, z = Number(xyz[i * 3 + 2]) - cz;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}

/** Largest distance from the origin, floored at 60 so an empty cloud still frames. */
export function memoryCoordinateExtent(xyz: ArrayLike<number>): number {
  let extent = 60;
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    const distance = Math.hypot(Number(xyz[i]), Number(xyz[i + 1]), Number(xyz[i + 2]));
    if (distance > extent) extent = distance;
  }
  return extent;
}
