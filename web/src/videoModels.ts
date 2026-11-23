import type { Connections, VideoModel } from './api';
import { MODEL_LABEL } from './types';

/** promoted: added by an approved Agent proposal (the dropdowns badge it 신규). */
export interface ShotModel { id: string; label: string; promoted?: boolean }

const BUILT_IN = ['ltx', 'minimax-h3', 'kandinsky-6-0-video-pro'];
const IMAGE_BUILT_IN = ['krea', 'klein9'];
const CANNOT_RUN = new Set(['disabled', 'not_provisioned', 'load_failed']);

/** Video models a shot can use, as the attached video MCP lists them (GET /connections → videogen.models): image→video
 * or text→video, and able to run. The built-in three while that list is not loaded, or when the MCP lists none. */
export function shotModels(connections: Connections | null): ShotModel[] {
  const listed = (connections?.platform.find((c) => c.id === 'videogen')?.models as VideoModel[] | undefined)
    ?.filter((m) => !CANNOT_RUN.has(m.status) && m.kinds.some((k) => k === 'i2v' || k === 't2v'));
  return listed?.length
    ? listed.map((m) => ({ id: m.id, label: m.label || MODEL_LABEL[m.id] || m.id, ...(m.promoted ? { promoted: true } : {}) }))
    : BUILT_IN.map((id) => ({ id, label: MODEL_LABEL[id] }));
}

/** Image models a picture can use: the image MCP's, in its order (GET /connections → imagegen.models; Krea and klein
 * until that list loads), then Stable Image Ultra on Bedrock. */
export function imageModels(connections: Connections | null): ShotModel[] {
  const listed = connections?.platform.find((c) => c.id === 'imagegen')?.models;
  const mcp = listed?.length
    ? listed.map((m) => ({ id: m.id, label: m.label || MODEL_LABEL[m.id] || m.id, ...(m.promoted ? { promoted: true } : {}) }))
    : IMAGE_BUILT_IN.map((id) => ({ id, label: MODEL_LABEL[id] }));
  return [...mcp, { id: 'stability-ultra', label: MODEL_LABEL['stability-ultra'] }];
}
