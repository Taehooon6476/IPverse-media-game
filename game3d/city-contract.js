// Browser mirror of server/city_contract.py. Asset URLs are supplied by the
// owned runtime/catalog, never by model-written city data.
const object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const number = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const keys = (v, allowed) => object(v) && Object.keys(v).every((k) => allowed.includes(k));
export function validateCity(spec, { need, point, unique }) {
  const { world } = spec, c = world.city;
  if (!object(c)) { need(false, 'world.city must be an object'); return; }
  need(keys(c, ['districts', 'streets', 'vehicles', 'pedestrians', 'trafficCount', 'seed']), 'world.city contains unsupported fields');
  const list = (key, min, max) => {
    need(Array.isArray(c[key]) && c[key].length >= min && c[key].length <= max, `world.city.${key} must have ${min}-${max} entries`);
    if (!Array.isArray(c[key])) c[key] = [];
    return c[key];
  };
  list('districts', 3, 6).forEach((d, i) => {
    const p = `world.city.districts[${i}]`;
    if (!keys(d, ['id', 'name', 'style', 'x', 'z', 'width', 'depth'])) return need(false, `${p} contains unsupported fields`);
    unique(d.id, p); point(d, p);
    need(typeof d.name === 'string' && [...d.name].length >= 1 && [...d.name].length <= 100, `${p}.name must be text`);
    need(['downtown', 'residential', 'industrial', 'waterfront'].includes(d.style), `${p}.style is unsupported`);
    need(number(d.width, 80, 600) && number(d.depth, 80, 600), `${p} dimensions must be 80-600 meters`);
    need(Math.abs(d.x) + d.width / 2 <= world.width / 2 && Math.abs(d.z) + d.depth / 2 <= world.depth / 2, `${p} must fit inside world`);
  });
  const streets = list('streets', 4, 14);
  streets.forEach((s, i) => {
    const p = `world.city.streets[${i}]`;
    if (!keys(s, ['id', 'axis', 'coordinate', 'width'])) return need(false, `${p} contains unsupported fields`);
    unique(s.id, p);
    need(['x', 'z'].includes(s.axis), `${p}.axis must be x or z`);
    const half = (s.axis === 'x' ? world.depth : world.width) / 2;
    need(number(s.width, 8, 24) && number(s.coordinate, -half + s.width / 2 + 16, half - s.width / 2 - 16), `${p} must fit inside world with width 8-24`);
  });
  for (const axis of ['x', 'z']) {
    const same = streets.filter((s) => s.axis === axis).sort((a, b) => a.coordinate - b.coordinate);
    need(same.length >= 2, `world.city needs at least two ${axis} streets`);
    for (let i = 1; i < same.length; i++)
      need(same[i].coordinate - same[i - 1].coordinate > (same[i].width + same[i - 1].width) / 2 + 8, 'parallel city streets must leave a block between them');
  }
  const nearRoad = (p, extra) => streets.some((s) =>
    Math.abs((s.axis === 'x' ? p.z : p.x) - s.coordinate) <= s.width / 2 + extra);
  need(nearRoad(world.spawn, 8), 'city spawn must be on a road or sidewalk');
  for (const p of [world.npc, ...world.propPlacements, ...world.enemySpawns].filter(Boolean))
    need(nearRoad(p, 8), 'city placements must be on a road or sidewalk');
  const missionIds = new Set(spec.mission?.stages?.flatMap((s) => s.entityIds ?? []) ?? []);
  for (const p of world.entities.filter((p) => missionIds.has(p.id)))
    need(nearRoad(p, 8), 'city mission target must be on a road or sidewalk');
  const solids = world.entities.filter((e) => (e.solid ?? !['beacon', 'hazard'].includes(e.kind)) && (e.y ?? 0) < 1.8).map((e) => {
    const c = Math.abs(Math.cos(e.rotation ?? 0)), s = Math.abs(Math.sin(e.rotation ?? 0));
    return { ...e, rx: ((e.width ?? 2) * c + (e.depth ?? 2) * s) / 2, rz: ((e.width ?? 2) * s + (e.depth ?? 2) * c) / 2 };
  });
  for (const e of solids) need(!streets.some((s) =>
    Math.abs((s.axis === 'x' ? e.z : e.x) - s.coordinate) < (s.axis === 'x' ? e.rz : e.rx) + s.width / 2 + 2), 'solid geometry must not block a city road');
  const segment = (a, b) => {
    if (Math.abs(a.x - b.x) < .001 && Math.abs(a.z - b.z) < .001) return nearRoad(a, 8);
    if (Math.abs(a.z - b.z) < .001) return streets.some((s) => s.axis === 'x' && Math.abs(a.z - s.coordinate) <= s.width / 2 + 8);
    if (Math.abs(a.x - b.x) < .001) return streets.some((s) => s.axis === 'z' && Math.abs(a.x - s.coordinate) <= s.width / 2 + 8);
    return false;
  };
  list('vehicles', 1, 8).forEach((v, i) => {
    const p = `world.city.vehicles[${i}]`;
    if (!keys(v, ['id', 'kind', 'x', 'z', 'yaw', 'color', 'modelId'])) return need(false, `${p} contains unsupported fields`);
    unique(v.id, p); point(v, p);
    need(['sedan', 'suv', 'taxi'].includes(v.kind), `${p}.kind is unsupported`);
    need(number(v.yaw, -Math.PI, Math.PI), `${p}.yaw is outside supported range`);
    need(v.color == null || /^#[a-f\d]{6}$/i.test(v.color), `${p}.color must be hex`);
    need(nearRoad(v, 2), `${p} must be on a road`);
    if (v.modelId === undefined) return; // the kit car of its kind; else the selected IP car's 3D model is its body
    const body = typeof v.modelId === 'string' ? world.entities.find((e) => object(e) && e.id === v.modelId) : null;
    need(body?.kind === 'model' && ['player', 'rival'].includes(body.car), `${p}.modelId must name a car body: a world.entities kind model with car player|rival`);
  });
  need(world.npc?.propIndex != null, 'city requires a selected NPC IP');
  list('pedestrians', 1, 8).forEach((v, i) => {
    const p = `world.city.pedestrians[${i}]`;
    if (!keys(v, ['id', 'propIndex', 'x', 'z', 'route'])) return need(false, `${p} contains unsupported fields`);
    unique(v.id, p); point(v, p);
    need(v.propIndex === world.npc?.propIndex, `${p} must use the selected NPC IP`);
    need(nearRoad(v, 8), `${p} must start on a street or sidewalk`);
    need(Array.isArray(v.route) && v.route.length >= 2 && v.route.length <= 8, `${p}.route must have 2-8 points`);
    if (!Array.isArray(v.route)) return;
    let validPoints = true;
    for (const q of v.route) {
      need(keys(q, ['x', 'z']), `${p}.route point has unsupported fields`);
      if (!object(q)) { validPoints = false; continue; }
      point(q, `${p}.route`); need(nearRoad(q, 8), `${p}.route must follow a street or sidewalk`);
    }
    if (!validPoints) return;
    if (Array.isArray(v.route) && v.route.length) {
      need(new Set(v.route.map((q) => `${q.x},${q.z}`)).size >= 2, `${p}.route needs distinct waypoints`);
      const points = [v, ...v.route, v.route[0]];
      for (let j = 1; j < points.length; j++) {
        need(segment(points[j - 1], points[j]), `${p}.route must follow connected roads or sidewalks`);
        const a = points[j - 1], b = points[j];
        for (const e of solids) {
          const overlap = Math.abs(a.z - b.z) < .001
            ? Math.abs(a.z - e.z) < e.rz + .6 && Math.max(a.x, b.x) > e.x - e.rx - .6 && Math.min(a.x, b.x) < e.x + e.rx + .6
            : Math.abs(a.x - e.x) < e.rx + .6 && Math.max(a.z, b.z) > e.z - e.rz - .6 && Math.min(a.z, b.z) < e.z + e.rz + .6;
          need(!overlap, `${p} route overlaps solid geometry`);
        }
      }
    }
  });
  c.trafficCount ??= 0; c.seed ??= 1234;
  need(Number.isInteger(c.trafficCount) && number(c.trafficCount, 0, 16), 'city trafficCount must be 0-16');
  need(Number.isInteger(c.seed) && number(c.seed, 0, 2147483647), 'city seed must be a nonnegative bounded integer');
}
