// Complete the actual generated three-stage mission using native Playwright input.
// The observer is read only. No demo autoplay, teleports or state assignment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command, evaluate, observer, liveSnapshot, frameClick, save, EVIDENCE, SESSION } from './session_e2e_20261102.mjs';

const spec = JSON.parse(await readFile(resolve(EVIDENCE, 'game-spec.json')));
assert.deepEqual(spec.design.castIpIds, ['ip_2f39ff7b40','ip_d67af2dd75']);
const report = {status:'RUNNING',startedAt:new Date().toISOString(),sessionId:SESSION,
  input:'Native agent-browser Playwright keydown/up and pointer input; read-only observer',
  checks:[],actions:[],screenshots:[],travelledMeters:0};
const held = new Set();
async function keys(wanted) {
  const next = new Set(wanted);
  for (const key of [...held]) if (!next.has(key)) {await command('keyup',{key});held.delete(key);}
  for (const key of next) if (!held.has(key)) {await command('keydown',{key});held.add(key);}
}
const wait = ms => new Promise(done=>setTimeout(done,ms));
const check = (name,passed,detail) => {
  report.checks.push({name,passed:Boolean(passed),detail});
  assert.ok(passed,name);
};
const shot = async name => {
  const path=resolve(EVIDENCE,name+'.png');
  await command('screenshot',{path});
  report.screenshots.push(path);
};
async function walk(x,z,tolerance=.65) {
  const began=Date.now();
  let previous=(await observer()).state.player;
  try {
    while(Date.now()-began<60000) {
      const s=(await observer()).state, dx=x-s.player[0],dz=z-s.player[2];
      report.travelledMeters+=Math.hypot(s.player[0]-previous[0],s.player[2]-previous[2]);
      previous=s.player;
      if (Math.hypot(dx,dz)<tolerance || s.phase==='won') return;
      assert.equal(s.phase,'playing','ROUND_MUST_REMAIN_PLAYING');
      const wanted=[];
      if(Math.abs(dz)>.16) wanted.push(dz<0?'w':'s');
      if(Math.abs(dx)>.16) wanted.push(dx>0?'d':'a');
      await keys(wanted);
      await wait(75);
    }
    throw Error('NATIVE_WALK_TIMEOUT');
  } finally {await keys([]);await wait(150);}
}

try {
  const before=await observer();
  check('exact existing user session play window',before.url.includes('#play='+SESSION),before.url);
  check('actual generated game ready',before.state?.phase==='ready',before.state?.phase);
  check('selected Luna and core bound',before.state.playerIpId===spec.design.playerIpId
    && before.state.propIpIds.includes(spec.design.propIpIds[0]),before.state);
  check('HUD capture surface available',before.surface,true);
  check('native IVS publisher on air',before.publisher?.onAir,true);
  const live=await liveSnapshot();
  check('live belongs to this session',live.active && live.mode==='player'
    && live.job?.sessionId===SESSION,live.job);
  check('advanced highlight enabled before mission',live.job.highlightGen===true,live.job.highlightGen);
  check('broadcast channel running',live.channelState==='RUNNING',live.channelState);
  report.before=before;
  report.liveBefore=live;
  await shot('10-before-native-round');
  const controls=await evaluate(`(() => [...document.querySelector('iframe').contentDocument.querySelectorAll('button')]
    .filter(b=>!b.hidden&&!b.disabled).map(b=>({id:b.id,text:b.innerText,
      selector:b.id?'#'+b.id:b.classList.contains('briefing-start')?'.briefing-start':null})))()`);
  const start=controls.find(b=>b.text==='임무 시작');
  assert.ok(start?.selector,'ACTUAL_MISSION_START_CONTROL_REQUIRED');
  report.startPointer=await frameClick(start.selector);
  await wait(400);
  check('native start reaches playing',(await observer()).state.phase==='playing');
  for(let index=0;index<spec.mission.stages.length;index++) {
    const stage=spec.mission.stages[index];
    const beforeStage=(await observer()).state;
    check('stage starts '+stage.id,beforeStage.mission.stageIndex===index,beforeStage.mission);
    const candidates=stage.type==='collect'?spec.world.propPlacements:spec.world.entities;
    const target=candidates.find(x=>stage.entityIds.includes(x.id));
    check('actual mission target exists '+stage.id,Boolean(target),target);
    await walk(target.x,target.z,stage.type==='collect'?.6:.8);
    if(stage.type==='interact') {await keys(['e']);await wait(1600);await keys([]);}
    else if(stage.type==='reach') await wait(1600);
    await wait(300);
    const after=(await observer()).state;
    check('native stage complete '+stage.id,after.mission.stageIndex>index,after.mission);
    report.actions.push({stage:stage.id,target:{id:target.id,x:target.x,z:target.z},player:after.player,mission:after.mission});
    await shot('11-native-'+stage.id);
    await save('native-gameplay.json',report);
  }
  const final=await observer();
  check('actual native mission won',final.state.phase==='won' && final.state.mission.completed,final.state);
  await wait(8000);
  const liveAfter=await liveSnapshot();
  check('actual completed round reported',liveAfter.stream?.rounds>=1,liveAfter.stream);
  check('native round recording registered',liveAfter.highlights?.length>=1,liveAfter.highlights);
  report.final=final;
  report.liveAfter=liveAfter;
  report.travelledMeters=Math.round(report.travelledMeters*100)/100;
  report.status='PASS';
  report.finishedAt=new Date().toISOString();
} catch(error) {
  report.status='FAIL';
  report.error={type:error.name,message:error.message};
  throw error;
} finally {
  await keys([]);
  await save('native-gameplay.json',report);
}
console.log(JSON.stringify({status:report.status,checks:report.checks.length,travelledMeters:report.travelledMeters,
  rounds:report.liveAfter?.stream?.rounds,highlights:report.liveAfter?.highlights?.map(h=>({id:h.id,state:h.state}))}));
