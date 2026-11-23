import { describe, expect, it } from 'vitest';
import type { Connections, ImageModel, VideoModel } from './api';
import { withModels } from './components/ChatDock';
import { imageModels, shotModels } from './videoModels';

const model = (id: string, kinds: string[], status = 'ready', label = ''): VideoModel => ({ id, label, kinds, status, promoted: false });
const conns = (models?: VideoModel[], images?: ImageModel[]): Connections => ({ servers: [], platform: [
  { id: 'imagegen', name: '이미지', status: 'connected', models: images },
  { id: 'videogen', name: '영상 생성 MCP', status: 'connected', models }] });

describe('the image model dropdown follows the image MCP', () => {
  it('lists the image MCP models in its order, then Stable Image Ultra on Bedrock', () => {
    const list = imageModels(conns([], [{ id: 'klein9', label: 'FLUX.2 klein 9B' }, { id: 'krea', label: 'Krea 2 Turbo' },
      { id: 'flux2-dev', label: '' }]));
    expect(list).toEqual([{ id: 'klein9', label: 'FLUX.2 klein 9B' }, { id: 'krea', label: 'Krea 2 Turbo' },
      { id: 'flux2-dev', label: 'flux2-dev' }, { id: 'stability-ultra', label: 'Stable Image Ultra' }]);
  });

  it('falls back to Krea and klein until the list loads', () => {
    expect(imageModels(null).map((m) => m.id)).toEqual(['krea', 'klein9', 'stability-ultra']);
    expect(imageModels(conns()).map((m) => m.id)).toEqual(['krea', 'klein9', 'stability-ultra']);
  });

  it('tags the image model id for the agent, like the video one', () => {
    expect(withModels('캐릭터 만들어줘', 'flux2-dev', 'auto', undefined, 'FLUX.2 dev')).toBe('[이미지 모델: FLUX.2 dev (flux2-dev)] 캐릭터 만들어줘');
  });
});

describe('the video model dropdown follows the MCP', () => {
  it('lists the models a shot can run, in the MCP order', () => {
    const list = shotModels(conns([model('ltx', ['i2v', 't2v', 'v2v'], 'ready', 'LTX-2.5'), model('wan-animate', ['animate', 'restyle']),
      model('minimax-h3', ['i2v'], 'stopped', 'MiniMax H3'), model('hunyuan-video', ['t2v'], 'loading', 'HunyuanVideo'),
      model('broken', ['i2v'], 'load_failed'), model('off', ['i2v'], 'disabled'), model('none', ['i2v'], 'not_provisioned')]));
    expect(list).toEqual([{ id: 'ltx', label: 'LTX-2.5' }, { id: 'minimax-h3', label: 'MiniMax H3' }, { id: 'hunyuan-video', label: 'HunyuanVideo' }]);
  });

  it('falls back to the built-in three until the list loads or when it is empty', () => {
    const ids = ['ltx', 'minimax-h3', 'kandinsky-6-0-video-pro'];
    expect(shotModels(null).map((m) => m.id)).toEqual(ids);
    expect(shotModels(conns()).map((m) => m.id)).toEqual(ids);
    expect(shotModels(conns([model('wan-animate', ['animate'])])).map((m) => m.id)).toEqual(ids);
  });

  it('names a model the app has no label for by its id, and tags the id for the agent', () => {
    expect(shotModels(conns([model('new-model', ['t2v'])]))).toEqual([{ id: 'new-model', label: 'new-model' }]);
    expect(withModels('영상 만들어줘', 'auto', 'hunyuan-video', 'HunyuanVideo')).toBe('[영상 모델: HunyuanVideo (hunyuan-video)] 영상 만들어줘');
  });
});
