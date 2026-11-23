// Observe the user's already-authenticated browser without exporting its auth state.
// Native held keys use agent-browser's installed Playwright-backed IPC commands.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { getSocketPath } from '/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/dist/daemon.js';

export const SESSION = 'ses_e1ca8fe3a9';
export const STUDIO = 'https://d12ka835iwfpnx.cloudfront.net';
export const EVIDENCE = resolve('evidence/session-e2e-20261102');
let sequence = 0;

export function command(action, fields = {}) {
  assert.ok(['evaluate', 'keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup',
    'click', 'screenshot', 'snapshot', 'tab_list', 'tab_switch'].includes(action));
  return new Promise((resolveResult, reject) => {
    const socket = net.createConnection(getSocketPath('live'));
    const decoder = new StringDecoder('utf8');
    let response = '';
    socket.setTimeout(55000, () => socket.destroy(new Error('BROWSER_COMMAND_TIMEOUT')));
    socket.on('connect', () => socket.write(JSON.stringify({ id: `e2e-${++sequence}`, action, ...fields }) + '\n'));
    socket.on('data', chunk => {
      response += decoder.write(chunk);
      const end = response.indexOf('\n');
      if (end < 0) return;
      socket.end();
      try {
        const data = JSON.parse(response.slice(0, end));
        if (!data.success) throw new Error(data.error || 'BROWSER_COMMAND_FAILED');
        resolveResult(data.data);
      } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

export async function evaluate(script) {
  return (await command('evaluate', { script })).result;
}

export async function sessionSnapshot() {
  return evaluate(`(async () => {
    if (location.origin !== ${JSON.stringify(STUDIO)}) throw Error('EXPECTED_STUDIO_ORIGIN');
    const tokens = JSON.parse(sessionStorage.getItem('ipverse.tokens') || 'null');
    if (!tokens?.access) return { status: 'AUTH_REQUIRED' };
    const r = await fetch('/api/sessions/${SESSION}', { headers: { 'X-Auth-Token': tokens.access } });
    const d = await r.json();
    if (r.status !== 200 || d.session?.sessionId !== '${SESSION}') return { status: r.status };
    const safe = value => {
      if (Array.isArray(value)) return value.map(safe);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/token|password|auth|secret|streamKey|uploadUrl|ingest/i.test(key))
        .map(([key, item]) => [key, safe(item)]));
      if (typeof value === 'string') return value.replace(/(https?:\\/\\/[^\\s"'?]+)\\?[^\\s"']+/g, '$1?[redacted]');
      return value;
    };
    return { status:r.status, observedAt:new Date().toISOString(),
      session:safe({sessionId:d.session.sessionId,title:d.session.title,genre:d.session.genre,
        createdAt:d.session.createdAt,concept:d.session.concept}),
      ips:safe(d.ips), assets:safe(d.assets), jobs:safe(d.jobs), games:safe(d.games), messages:safe(d.messages) };
  })()`);
}

export async function save(name, data) {
  assert.match(name, /^[a-zA-Z0-9._-]+$/);
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(resolve(EVIDENCE, name), JSON.stringify(data, null, 2) + '\n');
}

export async function observer() {
  return evaluate(`(() => {
    const frame = document.querySelector('iframe');
    return {url:location.href,frameUrl:frame?.src,
      state:frame?.contentWindow?.__ipverseGameState?.(),
      surface:!!frame?.contentWindow?.ipverseCapture,
      publisher:window.__ipverse?.state?.(),
      videos:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc,currentTime:v.currentTime,
        duration:Number.isFinite(v.duration)?v.duration:null,readyState:v.readyState,
        paused:v.paused,width:v.videoWidth,height:v.videoHeight}))};
  })()`);
}

export async function liveSnapshot() {
  return evaluate(`(async () => {
    if (location.origin !== ${JSON.stringify(STUDIO)}) throw Error('EXPECTED_STUDIO_ORIGIN');
    const tokens=JSON.parse(sessionStorage.getItem('ipverse.tokens')||'null');
    if (!tokens?.access) return {status:'AUTH_REQUIRED'};
    const r=await fetch('/api/sessions/${SESSION}/live',{headers:{'X-Auth-Token':tokens.access}});
    const d=await r.json();
    const job=d.job;
    return {status:r.status,observedAt:new Date().toISOString(),active:d.active,mode:d.mode,
      channelState:d.channelState,broadcaster:d.broadcaster,playbackUrl:d.playbackUrl,
      job:job?Object.fromEntries(['jobId','sessionId','gameId','everyRounds','adSeconds','adAssetId',
        'startedAt','highlightAuto','highlightGen','switched','stop'].map(k=>[k,job[k]])):null,
      stream:d.stream,highlights:d.highlights};
  })()`);
}

export async function held(keys, milliseconds) {
  assert.ok(milliseconds >= 1 && milliseconds <= 10000);
  assert.ok(keys.every(key => ['w','a','s','d','e','Shift','Space'].includes(key)));
  const url = await evaluate('location.href');
  assert.ok(url.startsWith(STUDIO + '/#play=' + SESSION), 'EXACT_USER_SESSION_PLAY_WINDOW_REQUIRED');
  try {
    for (const key of keys) await command('keydown', { key });
    await new Promise(done => setTimeout(done, milliseconds));
  } finally {
    for (const key of [...keys].reverse()) await command('keyup', { key });
  }
}

export async function frameClick(selector) {
  const point = await evaluate(`(() => {
    const frame = document.querySelector('iframe');
    const el = frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
    if (!el || el.hidden || el.disabled) throw Error('VISIBLE_ENABLED_FRAME_CONTROL_REQUIRED');
    const r = el.getBoundingClientRect(), f = frame.getBoundingClientRect();
    const x = f.x + r.x + r.width / 2, y = f.y + r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
      throw Error('FRAME_CONTROL_OUTSIDE_VISIBLE_VIEWPORT');
    return {x,y,text:el.innerText};
  })()`);
  await command('mousemove', {x:point.x,y:point.y});
  await command('mousedown', {button:'left'});
  await command('mouseup', {button:'left'});
  return point;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [mode, name, ms] = process.argv.slice(2);
  if (mode === 'snapshot') {
    const data = await sessionSnapshot();
    await save(name || 'snapshot.json', data);
    console.log(JSON.stringify({status:data.status,sessionId:data.session?.sessionId,
      ips:data.ips?.map(ip=>({ipId:ip.ipId,name:ip.name,kind:ip.kind,glbAssetId:ip.glbAssetId,riggedGlbAssetId:ip.riggedGlbAssetId})),
      assets:data.assets?.map(a=>({assetId:a.assetId,kind:a.kind,model:a.meta?.model})),
      jobs:data.jobs?.map(j=>({jobId:j.jobId,kind:j.kind,status:j.status,progress:j.progress,error:j.error})),
      games:data.games,messages:data.messages?.slice(-2).map(m=>({role:m.role,status:m.status,
        text:m.text?.slice(0,350),toolEvents:m.toolEvents}))}));
  } else if (mode === 'observe') {
    const data = await observer();
    if (name) await save(name, data);
    console.log(JSON.stringify(data));
  } else if (mode === 'live') {
    const data = await liveSnapshot();
    if (name) await save(name, data);
    console.log(JSON.stringify(data));
  } else if (mode === 'held') {
    await held(name.split(','), Number(ms));
    console.log(JSON.stringify(await observer()));
  } else throw new Error('EXPECTED_snapshot_observe_OR_held');
}
