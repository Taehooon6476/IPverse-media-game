import { useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { JOB_TYPICAL, SHOT_TYPICAL, modelLabel, type Asset, type Ip } from '../types';
import { shotModels, type ShotModel } from '../videoModels';
import { useDialog } from './useDialog';

/** What the drawer edits. Each kind becomes one tagged chat message the agent knows (server/prompts.py). */
export type EditTarget =
  | { kind: 'ip'; ip: Ip; imageUrl?: string }
  | { kind: 'shot'; asset: Asset; name?: string; prompt?: string; model?: string; seconds?: number }
  | { kind: 'trailer'; asset?: Asset };

interface Props {
  target: EditTarget;
  onClose: () => void;
  /** Sends the chat message; resolves when it is queued. */
  onSend: (text: string) => Promise<void>;
  /** The video models the attached MCP lists (shotModels), the built-in three until they load. */
  videoModels?: ShotModel[];
}

const TRAILER_SECONDS = [10, 15, 20, 30];

const EXAMPLES: Record<Exclude<EditTarget['kind'], 'ip'>, string[]> = {
  shot: [t('카메라를 더 낮게, 천천히 따라가게'), t('밤 장면으로, 네온 불빛 반사'), t('마지막에 뒤를 돌아보게')],
  trailer: [
    t('도시 항공 샷으로 시작해 주인공이 달려 나오고, 적 무리와 정면 대치, 사격 클로즈업으로 끝. 청록·주황 색감'),
    t('조용한 새벽에서 시작해 점점 빨라지는 편집, 마지막 3초는 제목 카드'),
  ],
};

/** An IP's examples follow what it is (a prop is not offered a scarf). A chip is sent to the agent as the user's
 * request, so the English page's chips are English requests. */
const IP_EXAMPLES = {
  character: [t('목에 빨간 스카프를 둘러줘'), t('머리를 은발로 바꿔줘'), t('표정을 더 단호하게')],
  enemy: [t('눈을 붉게 빛나게 해줘'), t('몸집을 더 크고 위협적으로'), t('등에 뾰족한 가시를 달아줘')],
  prop: [t('색을 짙은 파랑으로 바꿔줘'), t('표면에 금빛 무늬를 넣어줘'), t('더 낡고 닳은 느낌으로')],
  weapon: [t('날을 더 길고 날카롭게'), t('손잡이에 붉은 끈을 감아줘'), t('푸른 빛이 감돌게 해줘')],
  background: [t('해 질 녘 하늘로 바꿔줘'), t('멀리 산을 더 그려줘'), t('안개를 옅게 깔아줘')],
};
export const examplesFor = (target: EditTarget): string[] =>
  target.kind === 'ip' ? IP_EXAMPLES[target.ip.usage === 'background' ? 'background' : target.ip.kind] ?? IP_EXAMPLES.prop : EXAMPLES[target.kind];

/** The hint under the text box: an edit asks only for the change, a trailer's direction for its story. */
export const TEXT_HINT: Record<EditTarget['kind'] | 'new', string> = {
  ip: t('지금 결과에서 바꾸고 싶은 내용만 적어 주세요. 원래 버전은 그대로 남아요.'),
  shot: t('지금 결과에서 바꾸고 싶은 내용만 적어 주세요. 원래 버전은 그대로 남아요.'),
  trailer: t('새 연출로 트레일러를 다시 만들어요. 장면 순서, 분위기, 색감, 마지막 장면을 적어 주세요. 지금 트레일러는 그대로 남아요.'),
  new: t('어떤 장면으로 시작해 어떻게 끝날지, 분위기와 색감을 적어 주세요. 필요한 샷을 만든 뒤 하나로 이어 붙여요.'),
};

// The [tag] and fixed instruction a request starts with are for the agent and the chat bubble (ChatDock userText):
// the same in either language. What the user wrote after it is in the page's language.
export function messageFor(target: EditTarget, text: string, opts: { seconds: number; model: string }): string {
  if (target.kind === 'ip') return `[에셋 수정 ipId=${target.ip.ipId}] ${target.ip.name}: ${text}`;
  if (target.kind === 'shot') return `[영상 수정 jobId=${target.asset.jobId}] ${text}`;
  const base = target.asset ? ` 기존 트레일러(${target.asset.assetId})를 이 연출로 다시 만든다.` : '';
  return `[트레일러 연출] 전체 길이 약 ${opts.seconds}초, 영상 모델 ${modelLabel(opts.model)}.${base} 연출: ${text}`;
}

/** Right-side drawer: the current asset stays visible while the user writes what to change in plain words. */
export function EditDrawer({ target, onClose, onSend, videoModels = shotModels(null) }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, 'textarea');
  const [text, setText] = useState('');
  const [seconds, setSeconds] = useState(20);
  const [model, setModel] = useState('ltx');
  const [busy, setBusy] = useState(false);
  const examples = examplesFor(target);

  const title =
    target.kind === 'ip' ? t('{name} 수정하기', { name: target.ip.name }) : target.kind === 'shot' ? t('영상 샷 수정하기') : target.asset ? t('트레일러 다시 연출하기') : t('트레일러 연출하기');
  const lead =
    target.kind === 'ip'
      ? target.ip.usage === 'background'
        ? t('지금 전체 장면을 보면서 바꿀 부분을 적어 주세요. 배경은 그대로 둔 새 버전으로 저장돼요.')
        : t('지금 그림을 보면서 바꿀 부분을 적어 주세요. 수정한 그림은 새 버전으로 저장돼요.')
      : target.kind === 'shot'
        ? t('같은 캐릭터·모델·길이로, 적은 내용을 반영한 새 샷을 만들어요. 원래 샷은 그대로 남아요.')
        : t('원하는 장면 흐름을 문장으로 적어 주세요. 장면별 샷을 만들고 색을 맞춘 트레일러와 쇼츠로 묶어요. LTX는 장면 하나를 최대 20초까지 한 번에 만들어요.');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const asked = text.trim();
    if (!asked) return;
    setBusy(true);
    try {
      await onSend(messageFor(target, asked, { seconds, model }));
      onClose();
    } catch {
      setBusy(false); // the caller shows the error toast; keep the text
    }
  }

  const preview = () => {
    if (target.kind === 'ip')
      return target.imageUrl ? <img src={target.imageUrl} alt={t('{name} 현재 이미지', { name: target.ip.name })} /> : null;
    if (target.asset) return <video src={target.asset.url} controls tabIndex={0} muted playsInline preload="metadata" aria-label={t('현재 영상')} />;
    return null;
  };
  // What sending starts and how long it usually takes, in the job cards' own times. A shot's time is its model's.
  const shotUsual = (id?: string) => (id && Object.hasOwn(SHOT_TYPICAL, id) ? SHOT_TYPICAL[id] : JOB_TYPICAL.shot);
  const starts =
    target.kind === 'ip' ? t('새 버전을 그려요 ({usual})', { usual: JOB_TYPICAL.image })
      : target.kind === 'shot' ? t('새 샷을 만들어요 ({usual})', { usual: shotUsual(target.model ?? 'ltx') })
        : t('장면마다 샷을 만든 뒤 하나로 이어 붙여요 (샷 하나에 {shot}, 이어 붙이는 데 {cut})', { shot: shotUsual(model), cut: JOB_TYPICAL.trailer });
  const meta =
    target.kind === 'ip'
      ? t('현재 v{n} · 수정하면 v{next}', { n: target.ip.version, next: target.ip.version + 1 })
      : target.kind === 'shot'
        ? [target.name, modelLabel(target.model), target.seconds && t('{n}초', { n: target.seconds })].filter(Boolean).join(' · ')
        : '';

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-labelledby="edit-title" aria-describedby="edit-intro">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">{target.kind === 'trailer' ? 'DIRECT' : 'EDIT'}</p>
            <h2 id="edit-title">{title}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <form id="asset-edit-form" className="dialog-body" onSubmit={submit} aria-busy={busy}>
          {preview() && (
            <figure className="edit-preview">
              <div className={target.kind === 'ip' ? 'media media-16x9 media--image' : 'media media-16x9'}>{preview()}</div>
              {meta && <figcaption>{meta}</figcaption>}
              {target.kind === 'shot' && target.prompt && <p className="edit-prompt" title={t('원래 샷 프롬프트')}>{target.prompt}</p>}
            </figure>
          )}
          <p id="edit-intro" className="muted dialog-lead">{lead}</p>
          <label className="field">
            <span>{target.kind === 'trailer' ? t('연출') : t('바꿀 점')}</span>
            <textarea
              rows={target.kind === 'trailer' ? 6 : 4}
              value={text}
              maxLength={1500}
              aria-describedby="edit-text-hint"
              placeholder={t('예: {example}', { example: examples[0] })}
              onChange={(e) => setText(e.target.value)}
            />
            <small id="edit-text-hint" className="field-hint">{TEXT_HINT[target.kind === 'trailer' && !target.asset ? 'new' : target.kind]}</small>
          </label>
          <div className="chips" aria-label={t('예시')}>
            {examples.map((ex) => (
              // an example goes after what is typed, never over it, as in the game edit drawer
              <button key={ex} type="button" className="chip-btn" onClick={() => setText((was) => (was.trim() ? `${was.trim()}\n${ex}` : ex))} title={ex}>{ex}</button>
            ))}
          </div>
          {target.kind === 'trailer' && (
            <div className="row row--fields">
              <label className="field">
                <span>{t('전체 길이')}</span>
                <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                  {TRAILER_SECONDS.map((s) => <option key={s} value={s}>{t('{n}초', { n: s })}</option>)}
                </select>
              </label>
              <label className="field">
                <span>{t('영상 모델')}</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {videoModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
            </div>
          )}
        </form>
        <div className="dialog-footer">
          <p id="edit-submit-hint" className="field-hint dialog-submit-hint" role="status">{busy ? t('요청을 채팅으로 보내고 있어요.') : text.trim() ? t('요청을 보내면 {starts}. 진행 상황은 채팅과 작업 현황에 보여요.', { starts }) : t('수정할 내용이나 원하는 연출을 입력해 주세요.')}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>{t('취소')}</button>
            <button form="asset-edit-form" type="submit" className="btn btn-primary" aria-describedby="edit-submit-hint" disabled={busy || !text.trim()}>
              {busy ? t('보내는 중…') : target.kind === 'trailer' ? t('이 연출로 만들기') : t('수정 요청')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
