'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { saveComposerAction, saveSetAction, uploadMediaAction } from './composer-actions';

export type ProviderInfo = {
  name: string; textLimit: number; imageCaptionLimit: number | null; maxImages: number; thread: boolean; splitsLongText?: boolean;
  requiresImage: boolean; requiresVideo: boolean; acceptsVideo: boolean;
};
export type ComposerChannel = { id: string; name: string; provider: string; groupId: string | null };
export type ComposerMedia = { id: string; type: string; label: string | null; alt: string | null };
type ThreadItem = { content: string; delayMinutes: number };
type SetData = { channelIds: string[]; content: string; overrides: Record<string, string>; thread: ThreadItem[]; tagIds: string[]; repeatEveryDays: number | null };
export type ComposerInitial = SetData & { id?: string; revision?: number; mediaIds: string[]; scheduledAt?: string | null };

const repeatOptions = [[null, 'Does not repeat'], [1, 'Every day'], [2, 'Every 2 days'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every 30 days']] as const;
const marks: Record<string, string> = { facebook: 'f', instagram: 'ig', linkedin: 'in', youtube: '▶', x: 'X', telegram: 'tg', discord: 'dc' };

function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Composer({ workspace, channels, groups, providers, media: initialMedia, tags, signatures, sets, initial, canApprove, timeZone }: {
  workspace: string; channels: ComposerChannel[]; groups: { id: string; name: string }[]; providers: Record<string, ProviderInfo>;
  media: ComposerMedia[]; tags: { id: string; name: string; color: string }[]; signatures: { id: string; name: string; content: string; isDefault: boolean }[];
  sets: { id: string; name: string; data: SetData }[]; initial: ComposerInitial; canApprove: boolean; timeZone: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<string[]>(initial.channelIds);
  const [group, setGroup] = useState('');
  const [content, setContent] = useState(initial.content);
  const [overrides, setOverrides] = useState<Record<string, string>>(initial.overrides);
  const [tab, setTab] = useState<string>('global');
  const [thread, setThread] = useState<ThreadItem[]>(initial.thread);
  const [mediaIds, setMediaIds] = useState<string[]>(initial.mediaIds);
  const [library, setLibrary] = useState<ComposerMedia[]>(initialMedia);
  const [picking, setPicking] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>(initial.tagIds);
  const [repeat, setRepeat] = useState<number | null>(initial.repeatEveryDays);
  const [when, setWhen] = useState(initial.scheduledAt ? toLocalInput(new Date(initial.scheduledAt)) : toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const chosen = channels.filter(({ id }) => selected.includes(id));
  const visibleChannels = group ? channels.filter(({ groupId }) => groupId === group) : channels;
  const mediaTypes = mediaIds.map((id) => library.find((item) => item.id === id)?.type ?? '');
  const firstType = mediaTypes[0] ?? '';

  const checks = useMemo(() => chosen.map((channel) => {
    const info = providers[channel.provider];
    const text = (overrides[channel.id] ?? content).trim();
    const hasImage = firstType.startsWith('image/');
    const hasVideo = firstType.startsWith('video/');
    const limit = info ? (hasImage || hasVideo ? info.imageCaptionLimit : info.textLimit) : null;
    const issues: string[] = [];
    if (!info) issues.push('connector unavailable');
    else {
      if (info.requiresImage && !hasImage) issues.push('needs an image');
      if (info.requiresVideo && !hasVideo) issues.push('needs an MP4 video');
      if (hasVideo && !info.acceptsVideo) issues.push('no video support');
      if (limit === null) issues.push('text-only in this connector');
      if (!text) issues.push('empty text');
    }
    const notes: string[] = [];
    if (info && mediaIds.length > info.maxImages) notes.push(`publishes the first ${info.maxImages === 1 ? 'file' : `${info.maxImages} files`}`);
    if (info && thread.length && !info.thread) notes.push('thread items are skipped');
    const long = limit !== null && text.length > limit;
    if (long && info?.splitsLongText) notes.push(`over ${limit}: posts in full if the account has X Premium, otherwise as a numbered thread`);
    return { channel, info, text, limit, over: long && !info?.splitsLongText, issues, notes };
  }), [chosen, providers, overrides, content, firstType, mediaIds.length, thread.length]);
  const blocking = checks.some(({ issues, over }) => issues.length || over);

  function toggle(id: string) {
    setSelected((list) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
    // Deselecting the channel whose tab is open returns to the shared text instead of a hidden tab.
    if (tab === id && selected.includes(id)) setTab('global');
  }
  function insertSignature(id: string) {
    const signature = signatures.find((item) => item.id === id);
    if (!signature) return;
    if (tab !== 'global' && overrides[tab] !== undefined) {
      setOverrides((all) => ({ ...all, [tab]: `${(all[tab] ?? content).trimEnd()}\n\n${signature.content}` }));
    } else setContent((text) => `${text.trimEnd()}\n\n${signature.content}`);
  }
  function applySet(id: string) {
    const preset = sets.find((item) => item.id === id);
    if (!preset) return;
    setSelected(preset.data.channelIds.filter((cid) => channels.some(({ id: known }) => known === cid)));
    setContent(preset.data.content); setOverrides(preset.data.overrides ?? {}); setThread(preset.data.thread ?? []);
    setTagIds(preset.data.tagIds ?? []); setRepeat(preset.data.repeatEveryDays ?? null);
    setNotice(`Loaded set “${preset.name}”.`);
  }
  async function upload(file: File) {
    setError(null);
    const form = new FormData();
    form.set('file', file);
    const result = await uploadMediaAction(workspace, form);
    if (!result.ok) { setError(result.error); return; }
    setLibrary((list) => [{ ...result.value, alt: null }, ...list]);
    setMediaIds((ids) => [...ids, result.value.id].slice(0, 10));
  }
  function submit(intent: 'draft' | 'review' | 'schedule' | 'next' | 'now') {
    setError(null); setNotice(null);
    start(async () => {
      const result = await saveComposerAction(workspace, {
        postId: initial.id, revision: initial.revision, channelIds: selected, content, overrides, thread, mediaIds, tagIds,
        repeatEveryDays: repeat, intent, scheduledAt: intent === 'schedule' ? new Date(when).toISOString() : undefined,
      });
      if (!result.ok) { setError(result.error); return; }
      router.push(`/app/${workspace}/${intent === 'draft' || intent === 'review' ? 'posts' : 'calendar'}?status=${result.value.state.toLowerCase()}`);
      router.refresh();
    });
  }
  function saveAsSet() {
    const name = window.prompt('Name this set (channels, text, thread, tags and repeat are saved):');
    if (!name) return;
    start(async () => {
      const result = await saveSetAction(workspace, name, { channelIds: selected, content, overrides, thread, tagIds, repeatEveryDays: repeat });
      if (result.ok) setNotice(`Saved set “${name}”.`); else setError(result.error);
    });
  }

  // A channel tab only exists while that channel is selected; otherwise fall back to the shared text.
  const activeChannel = chosen.find(({ id }) => id === tab);
  const customizing = !!activeChannel && overrides[activeChannel.id] !== undefined;
  const editorValue = customizing ? overrides[activeChannel!.id]! : content;
  const previewChannels = tab === 'global' ? chosen : chosen.filter(({ id }) => id === tab);

  return (
    <div className="composer">
      <div className="composer-main">
        {sets.length > 0 && !initial.id && (
          <div className="composer-row">
            <label className="field-label" htmlFor="set-picker">Start from a set</label>
            <select id="set-picker" defaultValue="" onChange={(event) => applySet(event.target.value)}>
              <option value="">Choose a saved set…</option>
              {sets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        )}

        <section className="composer-card" aria-labelledby="channels-heading">
          <div className="composer-card-head">
            <h2 id="channels-heading">Channels</h2>
            <div className="composer-inline">
              {groups.length > 0 && (
                <select aria-label="Filter by client group" value={group} onChange={(event) => setGroup(event.target.value)}>
                  <option value="">All client groups</option>
                  {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              )}
              <button type="button" className="btn" onClick={() => setSelected(visibleChannels.map(({ id }) => id))}>Select all</button>
              {selected.length > 0 && <button type="button" className="btn" onClick={() => setSelected([])}>Clear</button>}
            </div>
          </div>
          {channels.length ? (
            <div className="channel-picker" role="group" aria-label="Channels to publish to">
              {visibleChannels.map((channel) => (
                <button key={channel.id} type="button" className="channel-pick" aria-pressed={selected.includes(channel.id)} onClick={() => toggle(channel.id)} title={channel.name}>
                  <span className="channel-avatar" data-provider={channel.provider} aria-hidden="true">{channel.name.slice(0, 1)}<small>{marks[channel.provider] ?? ''}</small></span>
                  <span>{channel.name}</span>
                </button>
              ))}
            </div>
          ) : <p className="muted-line">Connect a channel first under Channels.</p>}
        </section>

        <section className="composer-card" aria-labelledby="content-heading">
          <div className="composer-card-head">
            <h2 id="content-heading">Content</h2>
            <div className="composer-inline">
              {signatures.length > 0 && (
                <select aria-label="Insert signature" value="" onChange={(event) => insertSignature(event.target.value)}>
                  <option value="">Insert signature…</option>
                  {signatures.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? ' (default)' : ''}</option>)}
                </select>
              )}
            </div>
          </div>
          <div className="composer-tabs" role="tablist" aria-label="Edit text for">
            <button type="button" role="tab" aria-selected={tab === 'global'} onClick={() => setTab('global')}>All channels</button>
            {chosen.map((channel) => (
              <button key={channel.id} type="button" role="tab" aria-selected={tab === channel.id} onClick={() => setTab(channel.id)}>
                {channel.name}{overrides[channel.id] !== undefined ? ' •' : ''}
              </button>
            ))}
          </div>
          {activeChannel && (
            <p className="composer-hint">
              {overrides[activeChannel.id] === undefined
                ? <>Uses the shared text, so edits here change it for all channels. <button type="button" className="link-button" onClick={() => setOverrides((all) => ({ ...all, [activeChannel.id]: content }))}>Customize for {activeChannel.name}</button></>
                : <>Custom text for {activeChannel.name}. <button type="button" className="link-button" onClick={() => {
                    if (window.confirm('Discard the custom text and use the shared text again?')) {
                      setOverrides((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== activeChannel.id)));
                    }
                  }}>Back to shared text</button></>}
            </p>
          )}
          <label className="sr-only" htmlFor="composer-text">Post text</label>
          <textarea
            id="composer-text" rows={9} value={editorValue} maxLength={10_000}
            onChange={(event) => {
              const value = event.target.value;
              if (customizing) setOverrides((all) => ({ ...all, [activeChannel!.id]: value }));
              else setContent(value);
            }}
            placeholder="What do you want to share?"
          />
          <ul className="counter-list" aria-label="Character counts">
            {checks.map(({ channel, text, limit, over, issues, notes }) => (
              <li key={channel.id} className={over || issues.length ? 'bad' : ''}>
                <strong>{channel.name}</strong> {limit !== null ? `${text.length}/${limit}` : ''}
                {issues.length > 0 && ` · ${issues.join(', ')}`}{notes.length > 0 && ` · ${notes.join(', ')}`}
                {over && ` · too long by ${text.length - limit!}: open the ${channel.name} tab above the text box to write a shorter version just for it`}
              </li>
            ))}
          </ul>
        </section>

        <section className="composer-card" aria-labelledby="media-heading">
          <div className="composer-card-head">
            <h2 id="media-heading">Media</h2>
            <div className="composer-inline">
              <button type="button" className="btn" onClick={() => setPicking((open) => !open)}>{picking ? 'Close library' : 'Add from library'}</button>
              <label className="btn">
                Upload
                <input type="file" accept="image/png,image/jpeg,video/mp4" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) start(() => upload(file)); event.target.value = ''; }} />
              </label>
            </div>
          </div>
          {mediaIds.length > 0 ? (
            <ol className="media-strip">
              {mediaIds.map((id, index) => {
                const item = library.find((entry) => entry.id === id);
                return (
                  <li key={id}>
                    {item?.type.startsWith('video/') ? <video src={`/app/${workspace}/media/${id}`} muted /> : <img src={`/app/${workspace}/media/${id}`} alt={item?.alt ?? ''} />}
                    <div>
                      {index > 0 && <button type="button" aria-label="Move earlier" onClick={() => setMediaIds((ids) => { const next = [...ids]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}>←</button>}
                      <button type="button" aria-label="Remove" onClick={() => setMediaIds((ids) => ids.filter((value) => value !== id))}>✕</button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="muted-line">No media attached. PNG or JPEG up to 2 MiB, MP4 up to 20 MiB.</p>}
          {picking && (
            <div className="media-grid compact">
              {library.length ? library.map((item) => (
                <button key={item.id} type="button" className="media-tile" aria-pressed={mediaIds.includes(item.id)}
                  onClick={() => setMediaIds((ids) => ids.includes(item.id) ? ids.filter((value) => value !== item.id) : [...ids, item.id].slice(0, 10))}>
                  {item.type.startsWith('video/') ? <video src={`/app/${workspace}/media/${item.id}`} muted /> : <img src={`/app/${workspace}/media/${item.id}`} alt={item.alt ?? ''} />}
                  <span>{item.label ?? item.type}</span>
                </button>
              )) : <p className="muted-line">The library is empty. Upload a file above.</p>}
            </div>
          )}
        </section>

        <section className="composer-card" aria-labelledby="thread-heading">
          <div className="composer-card-head">
            <h2 id="thread-heading">Thread and follow-up comments</h2>
            <button type="button" className="btn" onClick={() => setThread((items) => [...items, { content: '', delayMinutes: 5 }])} disabled={thread.length >= 25}>+ Add thread item</button>
          </div>
          <p className="muted-line">Published as replies under the main post on channels that support it (Facebook comments, X threads, Telegram and Discord replies).</p>
          {thread.map((item, index) => (
            <div key={index} className="thread-item">
              <label className="field-label" htmlFor={`thread-${index}`}>Item {index + 1}</label>
              <textarea id={`thread-${index}`} rows={3} value={item.content} maxLength={4096}
                onChange={(event) => setThread((items) => items.map((entry, i) => i === index ? { ...entry, content: event.target.value } : entry))} />
              <div className="composer-inline">
                <label className="field-label" htmlFor={`delay-${index}`}>Wait</label>
                <input id={`delay-${index}`} type="number" min={0} max={10080} value={item.delayMinutes} style={{ width: '6rem' }}
                  onChange={(event) => setThread((items) => items.map((entry, i) => i === index ? { ...entry, delayMinutes: Math.max(0, Math.min(10080, Number(event.target.value) || 0)) } : entry))} />
                <span className="muted-line">minutes after the previous item</span>
                <button type="button" className="btn" onClick={() => setThread((items) => items.filter((_, i) => i !== index))}>Remove</button>
              </div>
            </div>
          ))}
        </section>

        <section className="composer-card" aria-labelledby="options-heading">
          <h2 id="options-heading">Options</h2>
          <div className="composer-options">
            <div>
              <span className="field-label">Tags</span>
              <div className="tag-picker">
                {tags.length ? tags.map((tag) => (
                  <button key={tag.id} type="button" className="chip" aria-pressed={tagIds.includes(tag.id)} style={{ ['--tag' as string]: tag.color }}
                    onClick={() => setTagIds((ids) => ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id])}>{tag.name}</button>
                )) : <span className="muted-line">Create tags in Settings → Content.</span>}
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="repeat">Repeat</label>
              <select id="repeat" value={repeat ?? ''} onChange={(event) => setRepeat(event.target.value ? Number(event.target.value) : null)}>
                {repeatOptions.map(([value, label]) => <option key={label} value={value ?? ''}>{label}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="when">Date and time</label>
              <input id="when" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
              <span className="muted-line">Your browser&apos;s time; the calendar shows {timeZone}.</span>
            </div>
          </div>
        </section>

        {error && <p role="alert" className="composer-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="composer-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => submit('draft')}>Save draft</button>
          <button type="button" className="btn" disabled={pending} onClick={saveAsSet}>Save as set</button>
          <span className="spacer" />
          {canApprove ? <>
            <button type="button" className="btn" disabled={pending || blocking || !selected.length} onClick={() => submit('next')}>Next free slot</button>
            <button type="button" className="btn" disabled={pending || blocking || !selected.length} onClick={() => submit('now')}>Post now</button>
            <button type="button" className="btn btn-primary" disabled={pending || blocking || !selected.length} onClick={() => submit('schedule')}>
              {pending ? 'Saving…' : 'Schedule'}
            </button>
          </> : (
            <button type="button" className="btn btn-primary" disabled={pending || blocking || !selected.length} onClick={() => submit('review')}>
              {pending ? 'Saving…' : 'Submit for approval'}
            </button>
          )}
        </div>
        {canApprove && <p className="muted-line">Schedule, Next free slot and Post now approve this version for you. Editors without approval rights submit for review instead.</p>}
      </div>

      <aside className="composer-preview" aria-label="Preview">
        <h2>Preview</h2>
        {previewChannels.length ? previewChannels.map((channel) => {
          const text = overrides[channel.id] ?? content;
          const info = providers[channel.provider];
          const shown = mediaIds.slice(0, info?.maxImages ?? 1);
          return (
            <article key={channel.id} className="preview-card" data-provider={channel.provider}>
              <header>
                <span className="channel-avatar" data-provider={channel.provider} aria-hidden="true">{channel.name.slice(0, 1)}</span>
                <div><strong>{channel.name}</strong><span>{info?.name ?? channel.provider} · now</span></div>
              </header>
              <p className="post-content">{text || <span className="muted-line">Nothing written yet.</span>}</p>
              {shown.length > 0 && (
                <div className={`preview-media n${Math.min(shown.length, 4)}`}>
                  {shown.slice(0, 4).map((id) => {
                    const item = library.find((entry) => entry.id === id);
                    return item?.type.startsWith('video/') ? <video key={id} src={`/app/${workspace}/media/${id}`} muted /> : <img key={id} src={`/app/${workspace}/media/${id}`} alt={item?.alt ?? ''} />;
                  })}
                </div>
              )}
              {info?.thread && thread.filter(({ content: c }) => c.trim()).map((item, index) => (
                <div key={index} className="preview-reply">
                  <span className="muted-line">↳ after {item.delayMinutes} min</span>
                  <p className="post-content">{item.content}</p>
                </div>
              ))}
            </article>
          );
        }) : <p className="muted-line">Choose channels to see how the post will look.</p>}
      </aside>
    </div>
  );
}
