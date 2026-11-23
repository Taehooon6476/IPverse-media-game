// Deterministic city assembly. The model supplies the road graph and district bounds,
// while a licensed asset catalog supplies meshes. No executable model output is used.
const random = (seed) => {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const roadDistance = (point, street) => Math.abs((street.axis === 'x' ? point.z : point.x) - street.coordinate);
export function districtAt(city, x, z) {
  const inside = city.districts.filter((d) => Math.abs(x - d.x) <= d.width / 2 && Math.abs(z - d.z) <= d.depth / 2);
  return (inside.length ? inside : city.districts).reduce((best, d) =>
    !best || Math.hypot(x - d.x, z - d.z) < Math.hypot(x - best.x, z - best.z) ? d : best, null);
}
export function cityPlan(world) {
  const city = world.city, rnd = random(city.seed ?? 1234);
  const roadsX = city.streets.filter((s) => s.axis === 'z').sort((a, b) => a.coordinate - b.coordinate);
  const roadsZ = city.streets.filter((s) => s.axis === 'x').sort((a, b) => a.coordinate - b.coordinate);
  const intervals = (roads, extent) => {
    const cuts = [{ coordinate: -extent / 2 + 9, width: 0 }, ...roads, { coordinate: extent / 2 - 9, width: 0 }];
    return cuts.slice(1).map((r, i) => [cuts[i].coordinate + cuts[i].width / 2 + 4, r.coordinate - r.width / 2 - 4]);
  };
  const buildings = [], props = [];
  const exclusions = [world.spawn, world.npc, ...world.propPlacements, ...world.enemySpawns,
    ...world.entities.filter((e) => ['beacon', 'hazard'].includes(e.kind))].filter(Boolean);
  for (const [x0, x1] of intervals(roadsX, world.width)) for (const [z0, z1] of intervals(roadsZ, world.depth)) {
    if (x1 - x0 < 18 || z1 - z0 < 18) continue;
    const spacing = 27;
    const nx = Math.max(1, Math.floor((x1 - x0) / spacing)), nz = Math.max(1, Math.floor((z1 - z0) / spacing));
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) {
      // Keep courtyards inside blocks; street-facing buildings remain dense.
      if (ix > 0 && iz > 0 && ix < nx - 1 && iz < nz - 1 && rnd() < .65) continue;
      const x = x0 + (ix + .5) * (x1 - x0) / nx;
      const z = z0 + (iz + .5) * (z1 - z0) / nz;
      if (exclusions.some((p) => Math.abs(p.x - x) < 19 && Math.abs(p.z - z) < 19)) continue;
      const district = districtAt(city, x, z);
      const heights = { downtown: [14, 38], residential: [5, 10], industrial: [6, 13], waterfront: [8, 18] };
      const [lo, hi] = heights[district.style];
      buildings.push({ id: `building_${buildings.length}`, x, z, width: 15 + rnd() * 5, depth: 15 + rnd() * 5,
        height: lo + rnd() * (hi - lo), yaw: (ix + iz) % 2 ? Math.PI : 0,
        style: district.style, districtId: district.id, variant: Math.floor(rnd() * 10000) });
    }
  }
  for (const street of city.streets) {
    const extent = street.axis === 'x' ? world.width : world.depth;
    for (let along = -extent / 2 + 20; along < extent / 2 - 20; along += 38) for (const side of [-1, 1]) {
      const p = street.axis === 'x'
        ? { x: along, z: street.coordinate + side * (street.width / 2 + 1.8) }
        : { x: street.coordinate + side * (street.width / 2 + 1.8), z: along };
      if (city.streets.some((s) => s.axis !== street.axis && roadDistance(p, s) < s.width / 2 + 3)) continue;
      if (exclusions.some((e) => Math.hypot(e.x - p.x, e.z - p.z) < 4)) continue;
      props.push({ ...p, id: `street_prop_${props.length}`, category: 'streetlight', yaw: street.axis === 'x' ? Math.PI / 2 : 0 });
    }
  }
  return { buildings, props, roadsX, roadsZ };
}

/** A closed lane loop through `corners` with every corner rounded into a circular arc of `radius` m (`segments`
 * chords): {points, s, total}, s[i] being the arc length at points[i]. Traffic drives it by arc length, so its heading
 * turns through each corner instead of snapping at the waypoint. */
export function roundedLoop(corners, radius = 7, segments = 8) {
  const points = [], n = corners.length;
  corners.forEach((c, i) => {
    const a = corners[(i + n - 1) % n], b = corners[(i + 1) % n];
    const la = Math.hypot(a.x - c.x, a.z - c.z), lb = Math.hypot(b.x - c.x, b.z - c.z);
    const ia = { x: (a.x - c.x) / la, z: (a.z - c.z) / la }, ib = { x: (b.x - c.x) / lb, z: (b.z - c.z) / lb };
    const half = Math.acos(Math.max(-1, Math.min(1, ia.x * ib.x + ia.z * ib.z))) / 2; // half the corner's angle
    if (half > Math.PI / 2 - 1e-6) { points.push({ x: c.x, z: c.z }); return; } // straight on: no corner to round
    const tangent = Math.min(radius / Math.tan(half), la / 2, lb / 2), r = tangent * Math.tan(half);
    const bx = ia.x + ib.x, bz = ia.z + ib.z, bl = Math.hypot(bx, bz), toCentre = r / Math.sin(half);
    const centre = { x: c.x + bx / bl * toCentre, z: c.z + bz / bl * toCentre };
    const from = Math.atan2(c.z + ia.z * tangent - centre.z, c.x + ia.x * tangent - centre.x);
    const sweep = Math.atan2(Math.sin(Math.atan2(c.z + ib.z * tangent - centre.z, c.x + ib.x * tangent - centre.x) - from),
      Math.cos(Math.atan2(c.z + ib.z * tangent - centre.z, c.x + ib.x * tangent - centre.x) - from));
    for (let k = 0; k <= segments; k++) {
      const angle = from + sweep * k / segments;
      points.push({ x: centre.x + Math.cos(angle) * r, z: centre.z + Math.sin(angle) * r });
    }
  });
  const s = [0];
  for (let i = 1; i <= points.length; i++) {
    const p = points[i - 1], q = points[i % points.length];
    s.push(s[i - 1] + Math.hypot(q.x - p.x, q.z - p.z));
  }
  return { points, s, total: s.at(-1) };
}

function loopPoint(loop, s) {
  const { points, s: at, total } = loop;
  s = ((s % total) + total) % total;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at[mid] <= s) lo = mid; else hi = mid - 1; }
  const p = points[lo], q = points[(lo + 1) % points.length], t = (s - at[lo]) / Math.max(1e-9, at[lo + 1] - at[lo]);
  return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
}

/** Position and heading (yaw: 0 faces -Z, like every car) at arc length s along a rounded loop; s wraps. The heading
 * is the direction of a 2 m chord centred on s, so it turns continuously through the arcs. */
export function loopPose(loop, s) {
  const p = loopPoint(loop, s), a = loopPoint(loop, s - 1), b = loopPoint(loop, s + 1);
  return { x: p.x, z: p.z, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)) };
}

/** A street patrol through a spawn point: the two ends `reach` m either way along the street it stands on, kept
 * 20 m inside the city's edge. */
export function patrolRoute(spawn, streets, world, reach = 24) {
  const street = streets.reduce((best, s) => !best || roadDistance(spawn, s) < roadDistance(spawn, best) ? s : best, null);
  const along = street?.axis === 'z' ? 'z' : 'x'; // an x street runs along x at a fixed z
  const limit = (along === 'x' ? world.width : world.depth) / 2 - 20;
  const end = (sign) => ({ ...{ x: spawn.x, z: spawn.z }, [along]: Math.max(-limit, Math.min(limit, spawn[along] + sign * reach)) });
  return [end(-1), end(1)];
}

// All world geometry has a light CPU collision record even when its rendering
// chunk is unloaded. Fast vehicles cannot enter buildings in an unloaded chunk.
export class SpatialGrid {
  constructor(cellSize = 32) { this.cellSize = cellSize; this.cells = new Map(); }
  key(x, z) { return `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`; }
  insert(box) {
    for (let x = Math.floor(box.minX / this.cellSize); x <= Math.floor(box.maxX / this.cellSize); x++)
      for (let z = Math.floor(box.minZ / this.cellSize); z <= Math.floor(box.maxZ / this.cellSize); z++) {
        const key = `${x},${z}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(box);
      }
  }
  nearby(x, z, radius = 1) {
    const result = new Set();
    for (let cx = Math.floor((x - radius) / this.cellSize); cx <= Math.floor((x + radius) / this.cellSize); cx++)
      for (let cz = Math.floor((z - radius) / this.cellSize); cz <= Math.floor((z + radius) / this.cellSize); cz++)
        for (const box of this.cells.get(`${cx},${cz}`) ?? []) result.add(box);
    return [...result];
  }
  blocked(x, z, radius = 1) {
    return this.nearby(x, z, radius).some((b) =>
      Math.hypot(x - Math.max(b.minX, Math.min(b.maxX, x)), z - Math.max(b.minZ, Math.min(b.maxZ, z))) < radius);
  }
  resolve(p, radius) {
    for (const b of this.nearby(p.x, p.z, radius)) {
      const x = Math.max(b.minX, Math.min(b.maxX, p.x)), z = Math.max(b.minZ, Math.min(b.maxZ, p.z));
      const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
      if (d >= radius) continue;
      if (d > .0001) { p.x = x + dx / d * radius; p.z = z + dz / d * radius; }
      else {
        const offsets = [[b.minX - radius - p.x, 0], [b.maxX + radius - p.x, 0],
          [0, b.minZ - radius - p.z], [0, b.maxZ + radius - p.z]];
        const nearest = offsets.reduce((a, v) => Math.hypot(...a) < Math.hypot(...v) ? a : v);
        p.x += nearest[0]; p.z += nearest[1];
      }
    }
    return p;
  }
}
