import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// authored.js loads three.js through the page's import map; here it resolves to a stub with real vector math. The HUD
// goal arrow (pointToGoal) is a DOM node: a stub element keeps its hidden flag and its label's text and screen offset.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { AuthoredMode } = await import('../authored.js');
const { MissionDirector } = await import('../mission.js');
const { roadPoints } = await import('./fixtures/track-road.mjs');
Object.assign(globalThis, { innerWidth: 1600, innerHeight: 1000, document: {
  getElementById: () => ({ append() {} }),
  createElement: () => {
    const node = { style: {}, hidden: false, setAttribute() {}, remove() {} };
    Object.defineProperty(node, 'innerHTML', { set() { node.firstChild = { style: {}, textContent: '' }; } });
    return node;
  } } });

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// published races' checkpoints in race order, the last one the finish (their spec.json)
const RACES = {
  gm_0894b6b98a: [[-170, -230], [-60, -180], [60, -250], [190, -200], [255, -90], [140, -40], [250, 60], [170, 180], [50, 250],
    [-70, 160], [-200, 240], [-250, 0]],
  gm_4d0beb5607: [[-60, -220], [120, -200], [230, -90], [150, 20], [240, 130], [110, 230], [-60, 170], [-130, 60], [-240, -20],
    [-200, -140]],
  gm_d1af23e9b2: [[-120, -240], [40, -240], [180, -240], [245, -218], [270, -150], [215, -105], [70, -100], [-80, -40], [-30, 120],
    [-170, 225], [-265, 40], [-235, -232]],
};

/** An authored mode in play with these stages and targets (records as authored.js keeps them), the hero or car at `at`. */
function mode(stages, targets, at = { x: 0, z: 0 }) {
  return Object.assign(Object.create(AuthoredMode.prototype), { phase: 'playing', director: new MissionDirector({ stages }),
    targets, player: { pos: { ...at } }, world: { rig: { yaw: 0 } } });
}
/** The arrow this frame (AuthoredMode.updateTargets → pointToGoal): null when hidden, else the metres on its label and
 * its bearing on screen (0: up, the way the camera looks; positive: to the right). */
function arrow(m) {
  m.pointToGoal(m.director.stage);
  const a = m.goalArrow, label = a.firstChild;
  return a.hidden ? null : { metres: Number(/^➤ (\d+)m$/.exec(label.textContent)[1]),
    bearing: Math.atan2(parseFloat(label.style.left), -parseFloat(label.style.top)) };
}
/** Whether the arrow shown names target t: its distance on the label and its bearing from the camera. */
function names(m, shown, t) {
  const p = m.player.pos;
  return shown.metres === Math.round(Math.hypot(t.x - p.x, t.z - p.z))
    && Math.abs(wrap(shown.bearing - Math.atan2(t.x - p.x, -(t.z - p.z)) - m.world.rig.yaw)) < 1e-6;
}

test('in a race the arrow names the next gate in race order (the finish after the last gate), never the gate just passed', () => {
  for (const [id, cps] of Object.entries(RACES)) {
    const ids = cps.map((_, i) => `cp${i + 1}`), laps = 2;
    // beacons as authored.js keeps them (radius: half their 10-12 m width); none is ever taken in a race
    const m = mode([{ id: 'race', type: 'race', label: '레이스', target: laps, entityIds: ids }],
      cps.map(([x, z], i) => ({ id: ids[i], x, z, y: 0, radius: 5 })));
    // the car drives the road (track.js lays it through the checkpoints in order, points ~2 m apart) from the grid 30 m
    // before gate 1, one road point a frame, the chase camera looking along the road. Each frame as AuthoredMode.update
    // runs it: the arrow first, then the director (which passes a gate within 7 m). The arrow must name the gate the
    // director waits for next, before and after it runs, or be hidden on the very frame that passes a gate
    const line = roadPoints(cps), n = line.length - 1;
    let frames = 0, wrong = 0, behind = 0, hid = 0, passing = 0, finish = 0, first = null;
    for (let k = n - 15; k < (laps + 1) * n && !m.director.completed; k++) {
      const p = line[k % n], q = line[(k + 1) % n], next = m.director.raceNext;
      Object.assign(m.player.pos, { x: p.x, z: p.z });
      m.world.rig.yaw = Math.atan2(-(q.x - p.x), -(q.z - p.z));
      const gate = m.targets[next], d = Math.hypot(gate.x - p.x, gate.z - p.z), seen = arrow(m);
      const where = `lap ${Math.floor(m.director.progress) + 1}, next gate ${next + 1} ${d.toFixed(0)} m away`;
      assert.equal(m.director.stage.id, 'race');
      m.director.update(1 / 30, { position: m.player.pos, targets: m.targets, driving: true });
      const passed = m.director.completed || m.director.raceNext !== next;
      frames += 1;
      if (seen && (passed || !names(m, seen, gate))) {
        if (passed) passing += 1; else { wrong += 1; behind += Math.abs(seen.bearing) > Math.PI / 2; }
        const named = m.targets.findIndex((t) => names(m, seen, t));
        first ??= `${where}${passed ? ' (passed this frame)' : ''}, the arrow read '➤ ${seen.metres}m' `
          + `${named >= 0 ? `at gate ${named + 1}` : 'at no gate'}${Math.abs(seen.bearing) > Math.PI / 2 ? ', behind the car' : ''}`;
      } else if (seen && next === ids.length - 1) finish += 1;
      else if (!seen && !passed) { hid += 1; first ??= `${where}, the arrow hid`; }
    }
    assert.ok(m.director.completed, `${id}: the car finished ${laps} laps`);
    assert.equal(wrong + passing + hid, 0, `${id}: of ${frames} frames the arrow named another gate in ${wrong} `
      + `(${(100 * wrong / frames).toFixed(0)} %, ${behind} of them behind the car), the gate being passed in ${passing} and hid `
      + `in ${hid} away from the next gate; first: ${first}`);
    assert.ok(finish > 20, `${id}: on the last stretch of each lap it named the finish (${finish} frames)`);
    // the round is over: the runtime stops calling update (AuthoredMode.idle), so the finish frame's arrow is what stays
    assert.equal(m.goalArrow.hidden, true, `${id}: no arrow is left on the end screen`);
    assert.equal(arrow(m), null, `${id}: once the race is over there is no arrow`);
  }
});

test('outside races the arrow still points at the nearest goal the stage has left', () => {
  const targets = [{ id: 'far', x: 0, z: -40 }, { id: 'near', x: 12, z: 0 }, { id: 'other', x: 0, z: 8 },
    { id: 'coin', x: -7, z: 0, pickup: true, taken: true }];
  for (const type of ['reach', 'interact', 'talk']) {
    const m = mode([{ id: 's', type, label: '목표', target: 1, entityIds: ['far', 'near', 'coin'] }], targets);
    const seen = arrow(m);
    assert.ok(seen && names(m, seen, targets[1]), `${type}: the nearest of its own goals not yet taken: ${JSON.stringify(seen)}`);
  }
  const any = mode([{ id: 's', type: 'reach', label: '목표', target: 1 }], targets); // no entityIds: any target
  assert.ok(names(any, arrow(any), targets[2]));
  any.player.pos.z = 3; // within 6 m of it: hidden
  assert.equal(arrow(any), null);
  for (const type of ['collect', 'kills', 'survive', 'boss']) {
    assert.equal(arrow(mode([{ id: 's', type, label: '목표', target: 1 }], targets)), null, `${type}: no place to point at`); // collect: none of its pickups here (round9.test.mjs)
  }
  const ready = mode([{ id: 's', type: 'reach', label: '목표', target: 1 }], targets);
  ready.phase = 'ready'; // the briefing is still up
  assert.equal(arrow(ready), null);
});
