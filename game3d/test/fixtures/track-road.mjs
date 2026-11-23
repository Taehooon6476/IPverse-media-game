// The open track's road as track.js lays it, for Node tests without three.js: a closed centripetal Catmull-Rom curve
// through the checkpoints (THREE.CatmullRomCurve3), cut into points ~2 m apart the way three's getSpacedPoints does
// (arc length from 200 chords). Matches three.js 0.170 to well under a millimetre.
const DIVISIONS = 200; // three's Curve.arcLengthDivisions

function curvePoint(cps, t) {
  const l = cps.length, p = l * t;
  let i = Math.floor(p);
  const w = p - i;
  i += i > 0 ? 0 : (Math.floor(Math.abs(i) / l) + 1) * l;
  const [p0, p1, p2, p3] = [cps[(i - 1) % l], cps[i % l], cps[(i + 1) % l], cps[(i + 2) % l]];
  const pow = (a, b) => ((a.x - b.x) ** 2 + (a.z - b.z) ** 2) ** .25;
  let dt0 = pow(p0, p1), dt1 = pow(p1, p2), dt2 = pow(p2, p3);
  if (dt1 < 1e-4) dt1 = 1;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;
  const axis = (k) => {
    const [x0, x1, x2, x3] = [p0[k], p1[k], p2[k], p3[k]];
    const t1 = ((x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1) * dt1;
    const t2 = ((x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2) * dt1;
    const c2 = -3 * x1 + 3 * x2 - 2 * t1 - t2, c3 = 2 * x1 - 2 * x2 + t1 + t2;
    return x1 + t1 * w + c2 * w * w + c3 * w * w * w;
  };
  return { x: axis('x'), z: axis('z') };
}

/** [[x, z], ...] checkpoints → the road's centre line, [{x, z}] (n + 1 points, the last one on the first). */
export function roadPoints(checkpoints) {
  const cps = checkpoints.map(([x, z]) => ({ x, z }));
  const lengths = [0];
  let last = curvePoint(cps, 0);
  for (let i = 1; i <= DIVISIONS; i++) {
    const p = curvePoint(cps, i / DIVISIONS);
    lengths.push(lengths[i - 1] + Math.hypot(p.x - last.x, p.z - last.z));
    last = p;
  }
  const total = lengths[DIVISIONS], n = Math.max(120, Math.round(total / 2));
  const at = (u) => { // three's getUtoTmapping: the chord the arc length falls in, then linear inside it
    const target = u * total;
    let low = 0, high = DIVISIONS;
    while (low <= high) {
      const i = Math.floor(low + (high - low) / 2), c = lengths[i] - target;
      if (c < 0) low = i + 1; else if (c > 0) high = i - 1; else { high = i; break; }
    }
    if (lengths[high] === target) return high / DIVISIONS;
    return (high + (target - lengths[high]) / (lengths[high + 1] - lengths[high])) / DIVISIONS;
  };
  return Array.from({ length: n + 1 }, (_, d) => curvePoint(cps, at(d / n)));
}
