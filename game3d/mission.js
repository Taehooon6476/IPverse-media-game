// Data-only ordered missions. Events come from actual movement, interaction and combat.
// No DOM/three.js dependency: the exact progression code is tested in Node.
export class MissionDirector {
  // startAt: a checkpoint (the stage a previous run reached); the stages before it count as done
  constructor(mission, { startAt = 0 } = {}) {
    this.mission = mission;
    this.index = Number.isInteger(startAt) ? Math.max(0, Math.min(mission.stages.length - 1, startAt)) : 0;
    this.progress = 0;
    this.elapsed = 0;
    this.hold = new Map();
    this.seen = new Set();
    this.history = [];
    this.completed = false;
    this.driveDistance = 0;
    this.raceNext = 0; // race: index of the next checkpoint in stage.entityIds
  }
  get stage() { return this.completed ? null : this.mission.stages[this.index]; }
  matches(event) {
    const s = this.stage;
    if (!s || s.type !== event.type) return false;
    if (s.entityIds?.length && !s.entityIds.includes(event.entityId)) return false;
    if (s.propIndex != null && s.propIndex !== event.propIndex) return false;
    if (s.enemyIndex != null && s.enemyIndex !== event.enemyIndex) return false;
    return true;
  }
  record(event) {
    if (!this.matches(event)) return false;
    if (event.type === 'drive') {
      if (!Number.isFinite(event.distanceMeters) || event.distanceMeters <= 0) return false;
      this.driveDistance += event.distanceMeters;
      this.progress = Math.min(1, this.driveDistance / this.stage.distanceMeters);
      return true;
    }
    const key = event.entityId ?? event.id;
    if (key != null && this.seen.has(key)) return false;
    if (key != null) this.seen.add(key);
    this.progress += 1;
    return true;
  }
  update(dt, { position, targets = [], interacting = false, driving = true } = {}) {
    const s = this.stage;
    if (!s) return null;
    this.elapsed += dt;
    if (s.type === 'survive') this.progress = this.elapsed;
    else if (s.type === 'race' && position && driving) {
      // ordered checkpoints; a lap counts once every checkpoint was passed in order
      const t = targets.find((x) => x.id === s.entityIds[this.raceNext]);
      if (t && Math.hypot(position.x - t.x, position.z - t.z) <= Math.max(t.radius ?? 0, 7)) {
        this.raceNext += 1;
        if (this.raceNext === s.entityIds.length) { this.raceNext = 0; this.progress += 1; }
      }
    }
    else if (['reach', 'interact', 'talk'].includes(s.type) && position) {
      for (const t of targets) {
        if (s.entityIds?.length && !s.entityIds.includes(t.id)) continue;
        // a pickup (coin) counts once the mode has taken it (it checks height too)
        const near = Math.hypot(position.x - t.x, position.z - t.z) <= (t.radius ?? 2.2)
          // a raised goal (a flag on the top platform) is reached on its level, not from the ground under it
          && !(t.y > .5 && position.y != null && Math.abs(position.y - t.y) > .6); // a jump from below (~1.18 m) is not on it
        const inside = t.pickup ? !!t.taken : near;
        // vehicle: "arrive by car" goals count only while driving
        const engaged = inside && (!s.vehicle || driving) && (s.type === 'reach' || interacting);
        const value = engaged ? (this.hold.get(t.id) ?? 0) + dt : 0;
        this.hold.set(t.id, value);
        // pickup entities (coins) count on touch
        if (engaged && value >= (t.pickup ? 0 : s.holdSec ?? (s.type === 'reach' ? 1 : 0))) {
          this.record({ type: s.type, entityId: t.id,
            propIndex: t.propIndex, enemyIndex: t.enemyIndex });
        }
      }
    }
    if (this.progress + 1e-8 < s.target) return null;
    const result = { id: s.id, type: s.type, progress: this.progress, seconds: this.elapsed,
      ...(s.type === 'drive' ? { distanceMeters: +this.driveDistance.toFixed(2) } : {}) };
    this.history.push(result);
    this.index += 1;
    this.completed = this.index === this.mission.stages.length;
    this.progress = 0;
    this.elapsed = 0;
    this.driveDistance = 0;
    this.raceNext = 0;
    this.hold.clear();
    this.seen.clear();
    return result;
  }
  snapshot() {
    return { stageIndex: this.index, stageId: this.stage?.id ?? null,
      type: this.stage?.type ?? null, label: this.stage?.label ?? this.mission.successText ?? '임무 완료',
      progress: +this.progress.toFixed(2), target: this.stage?.target ?? 0,
      completed: this.completed, history: this.history.map((s) => ({ ...s })),
      ...(this.stage?.type === 'drive' ? { distanceMeters: +this.driveDistance.toFixed(2), distanceTargetMeters: this.stage.distanceMeters } : {}),
      ...(this.stage?.type === 'race' ? { checkpoint: this.raceNext, checkpoints: this.stage.entityIds.length } : {}) };
  }
}
