import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THREE, authoredMode, published } from './fixtures/headless.mjs';
import { EDGE } from '../arpg-data.js';

// The low edge a wall keeps under the ARPG's camera is its collider's box, and a round pillar's collider is the box
// around it: a cylinder's edge is round, as the pillar's own footprint.
const SOURCE = readFileSync(new URL('../authored.js', import.meta.url), 'utf8');
const box = (x0, y0, z0, x1, y1, z1) => ({ min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1) });
const edges = (mode) => mode.root.children.filter((o) => o.name === 'wall-edge');

test('a round pillar\'s low edge is round: the pillar\'s footprint, not its collider\'s box', () => {
  const mode = authoredMode(published('gm_b870737b47'), { autoplay: false });
  mode.edge(box(-19, 0, -29, -17, 5, -27), {}, true); // pil_1's collider
  const [edge] = edges(mode);
  assert.ok(edge, 'no edge for the pillar');
  assert.ok(edge.geometry instanceof THREE.CylinderGeometry, 'the pillar\'s edge is a box: a square skirt round a round pillar');
  const [top, bottom, height] = edge.geometry.parameters;
  assert.ok(top === bottom && Math.abs(top - (1 + EDGE.proud)) < 1e-9, `its radius is the pillar's, a little proud of it: ${top}`);
  assert.equal(height, EDGE.height);
  assert.deepEqual([edge.position.x, edge.position.y, edge.position.z], [-18, EDGE.height / 2, -28]);
  // a wall's stays its box
  mode.edge(box(6, 0, -18.75, 20, 5, -17.25), {});
  assert.ok(edges(mode)[1].geometry instanceof THREE.BoxGeometry);
  mode.world.input.dispose();
  // buildEntity says which is which
  assert.match(SOURCE, /for \(const box of own\) this\.edge\(box, mat, e\.kind === 'cylinder'\);/);
});
