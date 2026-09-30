// Ground height field sampled from the loaded stage, in WORLD (design-frame)
// coordinates, so the design can drape onto the real terrain instead of the
// flat y=0 plane. A low per-cell percentile approximates bare ground under
// canopy and structures; empty cells fill from their nearest neighbors so
// heightAt is total over the sampled area.
export function buildHeightField(points, cell = 0.75) {
  const n = points.length / 3;
  if (!n) return null;
  // Bound the grid by a percentile envelope, not raw min/max: outdoor splats
  // carry sky/background floaters hundreds of meters out, and one of them
  // would otherwise blow the extents past the cell cap and kill the field.
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const xsAll = new Float32Array(n), zsAll = new Float32Array(n);
  for (let i = 0; i < n; i++) { xsAll[i] = points[i * 3]; zsAll[i] = points[i * 3 + 2]; }
  xsAll.sort(); zsAll.sort();
  const minX = pct(xsAll, 0.005), maxX = pct(xsAll, 0.995);
  const minZ = pct(zsAll, 0.005), maxZ = pct(zsAll, 0.995);
  const w = Math.max(1, Math.ceil((maxX - minX) / cell));
  const h = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  if (w * h > 1_000_000) return null;
  const cells = new Array(w * h);
  for (let i = 0; i < n; i++) {
    // DROP points outside the envelope — folding them into border cells would
    // re-inject the very floaters the envelope exists to exclude, and a few
    // hundred of them poison the corner cells that BFS then spreads inward
    const cx = Math.floor((points[i * 3] - minX) / cell);
    if (cx < 0 || cx >= w) continue;
    const cz = Math.floor((points[i * 3 + 2] - minZ) / cell);
    if (cz < 0 || cz >= h) continue;
    (cells[cz * w + cx] ??= []).push(points[i * 3 + 1]);
  }
  const grid = new Float32Array(w * h).fill(NaN);
  for (let i = 0; i < w * h; i++) {
    const ys = cells[i];
    if (!ys || ys.length < 3) continue;
    ys.sort((a, b) => a - b);
    grid[i] = ys[Math.floor(ys.length * 0.15)];   // low percentile ~ bare ground
  }
  // BFS dilation: fill empty cells from filled neighbors
  const queue = [];
  for (let i = 0; i < w * h; i++) if (!Number.isNaN(grid[i])) queue.push(i);
  if (!queue.length) return null;
  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    const cx = i % w, cz = (i / w) | 0;
    if (cx + 1 < w && Number.isNaN(grid[i + 1])) { grid[i + 1] = grid[i]; queue.push(i + 1); }
    if (cx > 0 && Number.isNaN(grid[i - 1])) { grid[i - 1] = grid[i]; queue.push(i - 1); }
    if (cz + 1 < h && Number.isNaN(grid[i + w])) { grid[i + w] = grid[i]; queue.push(i + w); }
    if (cz > 0 && Number.isNaN(grid[i - w])) { grid[i - w] = grid[i]; queue.push(i - w); }
  }
  const maxXg = minX + w * cell, maxZg = minZ + h * cell;
  return {
    // true only inside the area actually sampled (plus a cell of slack).
    // Outside it heightAt is a flat extrusion of the border, not measured
    // ground, so picks that land there must be treated as misses.
    contains(x, z) {
      return x >= minX - cell && x <= maxXg + cell && z >= minZ - cell && z <= maxZg + cell;
    },
    // bilinear over cell centers; clamped at the borders
    heightAt(x, z) {
      const u = Math.max(0, Math.min(w - 1, (x - minX) / cell - 0.5));
      const v = Math.max(0, Math.min(h - 1, (z - minZ) / cell - 0.5));
      const x0 = Math.floor(u), z0 = Math.floor(v);
      const x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(h - 1, z0 + 1);
      const fx = u - x0, fz = v - z0;
      const a = grid[z0 * w + x0] * (1 - fx) + grid[z0 * w + x1] * fx;
      const b = grid[z1 * w + x0] * (1 - fx) + grid[z1 * w + x1] * fx;
      return a * (1 - fz) + b * fz;
    },
  };
}
