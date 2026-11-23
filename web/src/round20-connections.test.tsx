import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, removeConnection, type Connection, type Connections } from './api';
import { ConnectionsDrawer } from './components/ConnectionsDrawer';

// 연결 설정 shows names and states only, whatever the API still sends (no addresses, ids, hosts or model ids), and a
// delete asks first, is sent at once and offers no way back it does not have.
vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), removeConnection: vi.fn(), updateConnection: vi.fn(), addConnection: vi.fn() }));

// as the server sends them, with stand-in addresses
const platform: Connection[] = [
  { id: 'imagegen', kind: 'mcp', name: '이미지 생성 MCP', endpoint: 'https://abc123.execute-api.us-east-1.amazonaws.com/mcp', detail: 'Krea 2 Turbo · FLUX.2 klein (GPU 서버)',
    status: 'connected', toolCount: 4, tools: ['list_models', 'start_image', 'get_image_status', 'get_image_results'] },
  { id: 'bedrock-agent', kind: 'aws', name: 'Amazon Bedrock · 에이전트', endpoint: 'bedrock-runtime (us-east-1)', detail: 'global.anthropic.claude-sonnet-5-5', status: 'connected' },
  { id: 'bedrock-pegasus', kind: 'aws', name: 'Amazon Bedrock · Pegasus 1.5', endpoint: 'bedrock-runtime (us-east-1)', detail: 'us.twelvelabs.pegasus-1-5-v1:0 · 라이브 하이라이트', status: 'connected' },
  { id: 'deadline', kind: 'aws', name: 'AWS Deadline Cloud', endpoint: 'farm-0123456789abcdef0123456789abcdef', detail: '3D 턴테이블 · Griptape 워크플로', status: 'connected' },
  { id: 'live', kind: 'aws', name: 'Amazon IVS 라이브 · 광고', endpoint: 'a1b2c3d4e5f6.global-contribute.live-video.net',
    detail: 'IVS 저지연 송출 · IVS 광고 삽입 + MediaTailor · 플레이어블 GameLift Streams', status: 'error', error: 'ResourceNotFoundException: channel arn:aws:ivs:us-east-1:000000000000:channel/abcd' },
  { id: 'storyboard', kind: 'mcp', name: '스토리보드', endpoint: 'https://ghi789.execute-api.us-east-1.amazonaws.com/mcp', status: 'unknown' }, // a row this client has no name for
];
const mine: Connection = { id: 'mcp_notes', name: '내 노트 MCP', url: 'https://notes.example.com/mcp', status: 'connected', enabled: true, toolCount: 3,
  tools: ['search_notes', 'read_note', 'add_note'] };
const broken: Connection = { id: 'mcp_wiki', name: '위키', url: 'https://wiki.example.com/mcp', status: 'error', enabled: true,
  error: '인증이 필요하거나 거부됐어요 (HTTP 401). 인증 헤더와 값을 확인해 주세요.' };
const SECRETS = /https?:|execute-api|amazonaws|live-video|farm-|us-east|claude|pegasus-1-5|arn:|list_models|start_image|search_notes|read_note|Krea|klein|Griptape|example\.com/;

let container: HTMLDivElement;
let root: Root;
let list: Connections;
let onChange: ReturnType<typeof vi.fn>;
let onNotify: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  list = { platform, servers: [mine, broken] };
  onChange = vi.fn((next: Connections) => { list = next; });
  onNotify = vi.fn();
  onError = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const show = () => act(async () => root.render(<ConnectionsDrawer connections={list} onChange={onChange as never} onRefresh={async () => undefined}
  onClose={vi.fn()} onError={onError as never} onNotify={onNotify as never} />));
const rows = (section: string) => [...document.querySelectorAll(`[aria-labelledby="${section}"] .conn-row`)];
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

describe('R20-45 연결 설정 shows names and states, no address', () => {
  it('names the studio\'s own services in plain words with their state, and nothing the API sent beside them', async () => {
    await show();
    expect(rows('conn-platform').map((r) => [r.querySelector('strong')!.textContent, r.querySelector('.conn-status')!.textContent])).toEqual([
      ['이미지 생성', '연결됨'], ['채팅 AI', '연결됨'], ['라이브 하이라이트', '연결됨'], ['3D 렌더', '연결됨'], ['라이브 방송 · 광고', '연결 실패'], ['스토리보드', '확인 중']]);
    const drawer = document.querySelector('[role="dialog"]')!;
    // the two lists (the add form below them has its own example address as a placeholder)
    const lists = [...drawer.querySelectorAll('.conn-list')];
    expect(lists).toHaveLength(2);
    for (const ul of lists) {
      expect(ul.textContent).not.toMatch(SECRETS);
      expect(ul.outerHTML).not.toMatch(SECRETS); // not in a tooltip or an attribute either
    }
    expect(drawer.querySelector('.conn-endpoint, .conn-kind, .conn-detail, .conn-tools')).toBeNull();
    // the service's own name is the tooltip at most
    expect(rows('conn-platform').map((r) => r.querySelector('strong')!.getAttribute('title'))).toEqual([
      '이미지 생성 MCP', 'Amazon Bedrock · 에이전트', 'Amazon Bedrock · Pegasus 1.5', 'AWS Deadline Cloud', 'Amazon IVS 라이브 · 광고', null]);
  });

  // One thing, one name: the API names the rows itself (server/connections.py), but the services the studio knows
  // keep the studio's names, here and in the sidebar's fold.
  it('keeps the studio\'s own names for its services when the API names them itself', async () => {
    const named = (id: string, name: string): Connection => ({ id, name, status: 'connected' });
    list = { platform: [named('imagegen', '이미지 생성'), named('videogen', '영상 생성'), named('bedrock-agent', '채팅 에이전트'),
      named('bedrock-image', '배경 제거 · Stable Image 생성'), named('bedrock-pegasus', '라이브 하이라이트'), named('deadline', '3D 렌더'), named('live', '라이브 방송'),
      named('storyboard', '스토리보드')], servers: [] };
    await show();
    expect(rows('conn-platform').map((r) => [r.querySelector('strong')!.textContent, r.querySelector('strong')!.getAttribute('title')])).toEqual([
      ['이미지 생성', null], ['영상 생성', null], ['채팅 AI', null], ['이미지 보정 · 배경 제거', null], ['라이브 하이라이트', null], ['3D 렌더', null],
      ['라이브 방송 · 광고', null], ['스토리보드', null]]); // a plain name of the API's is no tooltip; a row the studio does not know keeps it
  });

  it('says a failed service plainly, without the raw error', async () => {
    await show();
    expect(rows('conn-platform')[4].querySelector('.conn-error')!.textContent).toBe('지금 연결할 수 없어요. 잠시 뒤 ‘상태 새로고침’을 눌러 보세요.');
  });

  it('shows my own servers by name, state and how many tools they have; a failure in the server\'s Korean words', async () => {
    await show();
    expect(rows('conn-mine').map((r) => [r.querySelector('strong')!.textContent, r.querySelector('.conn-status')!.textContent,
      r.querySelector('.conn-count')?.textContent ?? null, r.querySelector('.conn-error')?.textContent ?? null])).toEqual([
      ['내 노트 MCP', '연결됨', '도구 3개', null], ['위키', '연결 실패', null, '인증이 필요하거나 거부됐어요 (HTTP 401). 인증 헤더와 값을 확인해 주세요.']]);
  });

  it('says in its lead what the list is for', async () => {
    await show();
    expect(document.querySelector('#conn-intro')!.textContent).toBe('스튜디오가 쓰는 서비스의 연결 상태예요. 모두 ‘연결됨’이면 할 일이 없어요. 아래에서 채팅 AI가 쓸 MCP 서버를 직접 추가할 수도 있어요.');
  });
});

describe('R20-45 deleting a connection asks first and offers no way back it does not have', () => {
  it('asks, deletes on the server at once, then takes the row away and says so, with no 되돌리기', async () => {
    vi.mocked(removeConnection).mockResolvedValue({ deleted: 'mcp_notes' });
    await show();
    await act(async () => button('삭제', rows('conn-mine')[0]).click());
    expect(confirm()!.querySelector('h2')!.textContent).toBe('내 노트 MCP 연결을 삭제할까요?');
    expect(confirm()!.querySelector('.dialog-lead')!.textContent)
      .toBe('삭제하면 채팅 AI가 이 서버의 도구를 쓸 수 없어요. 되돌릴 수 없고, 다시 쓰려면 주소와 인증 값을 새로 넣어 추가해야 해요.');
    expect([removeConnection, onChange].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0]);
    await act(async () => button('삭제', confirm()!).click());
    expect(removeConnection).toHaveBeenCalledWith('mcp_notes'); // now, not six seconds later
    expect(list.servers.map((s) => s.id)).toEqual(['mcp_wiki']);
    expect(onNotify.mock.calls).toEqual([['내 노트 MCP 연결을 삭제했어요.']]); // a plain notice: no action on it
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(removeConnection).toHaveBeenCalledTimes(1);
  });

  it('keeps the row when the confirm is cancelled or the server refuses', async () => {
    await show();
    await act(async () => button('삭제', rows('conn-mine')[0]).click());
    await act(async () => button('취소', confirm()!).click());
    expect([confirm(), vi.mocked(removeConnection).mock.calls.length]).toEqual([null, 0]);
    const refused = new ApiError(500, '요청에 실패했습니다 (500).');
    vi.mocked(removeConnection).mockRejectedValue(refused);
    await act(async () => button('삭제', rows('conn-mine')[0]).click());
    await act(async () => button('삭제', confirm()!).click());
    expect(onError).toHaveBeenCalledWith(refused);
    expect([onChange.mock.calls.length, onNotify.mock.calls.length, rows('conn-mine').length]).toEqual([0, 0, 2]);
  });
});
