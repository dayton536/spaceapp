import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

/** Screen-space cell size for hover and click. Large enough that a node only occupies a few cells. */
export const MEMORY_PICK_CELL_SIZE = 24;

export interface MemorySpatialPicker3D {
  /** Replaces the index. `xs`, `ys`, `zs` and `radii` are parallel to `ids`. */
  rebuild(ids: readonly string[], xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, radii: ArrayLike<number>, width: number, height: number): void;
  /** Closest node under the pointer, or null. Does not scan the full graph. */
  pick(x: number, y: number): string | null;
}

/**
 * Uniform screen grid. Rebuild is two linear passes over the projected nodes;
 * a pointer query only reads the cells that can contain the hit radius.
 */
export function createMemorySpatialPicker3D(): MemorySpatialPicker3D {
  let ids: readonly string[] = [];
  let xs: ArrayLike<number> = new Float32Array();
  let ys: ArrayLike<number> = new Float32Array();
  let zs: ArrayLike<number> = new Float32Array();
  let radii: ArrayLike<number> = new Float32Array();
  let columns = 1;
  let rows = 1;
  let offsets = new Int32Array(2);
  let indices = new Int32Array(0);
  let counts = new Int32Array(1);
  let cursor = new Int32Array(2);
  return {
    rebuild(nextIds, nextX, nextY, nextZ, nextRadii, width, height) {
      ids = nextIds;
      xs = nextX;
      ys = nextY;
      zs = nextZ;
      radii = nextRadii;
      const count = nextIds.length;
      columns = Math.max(1, Math.ceil(Math.max(1, width) / MEMORY_PICK_CELL_SIZE));
      rows = Math.max(1, Math.ceil(Math.max(1, height) / MEMORY_PICK_CELL_SIZE));
      const cells = columns * rows;
      if (counts.length < cells) counts = new Int32Array(cells);
      else counts.fill(0, 0, cells);
      if (indices.length < count) indices = new Int32Array(count);
      if (offsets.length < cells + 1) offsets = new Int32Array(cells + 1);
      if (cursor.length < cells) cursor = new Int32Array(cells);
      for (let i = 0; i < count; i++) {
        const column = (nextX[i] ?? 0) / MEMORY_PICK_CELL_SIZE;
        const row = (nextY[i] ?? 0) / MEMORY_PICK_CELL_SIZE;
        const col = column < 0 ? 0 : column >= columns ? columns - 1 : column | 0;
        const gridRow = row < 0 ? 0 : row >= rows ? rows - 1 : row | 0;
        counts[gridRow * columns + col] = (counts[gridRow * columns + col] ?? 0) + 1;
      }
      offsets[0] = 0;
      for (let cell = 0; cell < cells; cell++) offsets[cell + 1] = (offsets[cell] ?? 0) + (counts[cell] ?? 0);
      for (let cell = 0; cell < cells; cell++) cursor[cell] = offsets[cell] ?? 0;
      for (let i = 0; i < count; i++) {
        const column = (nextX[i] ?? 0) / MEMORY_PICK_CELL_SIZE;
        const row = (nextY[i] ?? 0) / MEMORY_PICK_CELL_SIZE;
        const col = column < 0 ? 0 : column >= columns ? columns - 1 : column | 0;
        const gridRow = row < 0 ? 0 : row >= rows ? rows - 1 : row | 0;
        const cell = gridRow * columns + col;
        const slot = cursor[cell] ?? 0;
        indices[slot] = i;
        cursor[cell] = slot + 1;
      }
    },
    pick(x, y) {
      if (!ids.length) return null;
      const cx = Math.floor(x / MEMORY_PICK_CELL_SIZE);
      const cy = Math.floor(y / MEMORY_PICK_CELL_SIZE);
      let best = -1;
      let bestZ = Infinity;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const col = cx + ox, row = cy + oy;
        if (col < 0 || row < 0 || col >= columns || row >= rows) continue;
        const cell = row * columns + col;
        const start = offsets[cell] ?? 0;
        const end = offsets[cell + 1] ?? start;
        for (let slot = start; slot < end; slot++) {
          const index = indices[slot] ?? 0;
          const dx = (xs[index] ?? 0) - x;
          const dy = (ys[index] ?? 0) - y;
          const radius = Math.max(7, (radii[index] ?? 0) + 3);
          if (dx * dx + dy * dy > radius * radius) continue;
          const depth = zs[index] ?? 0;
          if (depth < bestZ || (depth === bestZ && index > best)) {
            best = index;
            bestZ = depth;
          }
        }
      }
      return best >= 0 ? ids[best] ?? null : null;
    }
  };
}

/**
 * Projects packed world coordinates with the same math as `projectMemoryPoint`.
 * Missing nodes (`present[i] === 0`) are left untouched.
 */
export function projectMemoryCoordinates(
  xyz: ArrayLike<number>,
  present: ArrayLike<number>,
  camera: MemoryCamera3D,
  scale: number,
  width: number,
  height: number,
  outX: Float32Array,
  outY: Float32Array,
  outZ: Float32Array,
  outPerspective: Float32Array
): void {
  const yawCos = Math.cos(camera.yaw), yawSin = Math.sin(camera.yaw);
  const pitchCos = Math.cos(camera.pitch), pitchSin = Math.sin(camera.pitch);
  const count = Math.min(outX.length, Math.floor(xyz.length / 3));
  for (let i = 0; i < count; i++) {
    if (!present[i]) continue;
    const point: MemoryPoint3D = { x: Number(xyz[i * 3]), y: Number(xyz[i * 3 + 1]), z: Number(xyz[i * 3 + 2]) };
    const x = point.x * yawCos + point.z * yawSin;
    const depth = -point.x * yawSin + point.z * yawCos;
    const y = point.y * pitchCos - depth * pitchSin;
    const z = point.y * pitchSin + depth * pitchCos;
    const perspective = 650 / Math.max(120, 650 + z * scale);
    outX[i] = width / 2 + x * scale * camera.zoom * perspective;
    outY[i] = height / 2 - y * scale * camera.zoom * perspective;
    outZ[i] = z;
    outPerspective[i] = perspective;
  }
}
