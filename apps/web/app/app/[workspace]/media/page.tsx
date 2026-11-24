import { canWritePosts, listMedia } from '@cadencedesk/data';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../lib/require-user';
import { SubmitButton } from '../../../login/submit-button';
import { archiveMediaFormAction, updateMediaFormAction, uploadMediaFormAction } from './actions';

const messages: Record<string, string> = {
  uploaded: 'Upload complete.', saved: 'Media details saved.',
  archived: 'Removed from the library. Posts that already use these files are not affected.',
  upload: 'Upload failed. Use PNG or JPEG up to 2 MiB, or MP4 up to 20 MiB.', invalid: 'Choose at least one file.',
  unavailable: 'You do not have access to change the media library.',
};

function size(bytes: number) {
  return bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export default async function MediaLibrary({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status, q }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const search = q?.trim().slice(0, 80) || undefined;
  const media = await listMedia(user.id, workspace, search);
  const canEdit = canWritePosts(membership.role);
  const base = `/app/${workspace}`;
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Media library</h1>
          <p>Images and videos for your posts. Add alt text so screen-reader users know what an image shows.</p>
        </div>
      </header>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      <div className="media-toolbar">
        <form method="get" className="calendar-filter">
          <label htmlFor="q" className="sr-only">Search media</label>
          <input id="q" name="q" type="search" placeholder="Search by name or alt text" defaultValue={search} />
          <button type="submit">Search</button>
        </form>
        {canEdit && (
          <form action={uploadMediaFormAction} className="calendar-filter">
            <input type="hidden" name="workspace" value={workspace} />
            <label htmlFor="files" className="sr-only">Files to upload</label>
            <input id="files" name="files" type="file" multiple accept="image/png,image/jpeg,video/mp4" required />
            <SubmitButton className="primary" pending="Uploading…">Upload</SubmitButton>
          </form>
        )}
      </div>
      {media.length ? (
        <form action={archiveMediaFormAction} id="archive-form">
          <input type="hidden" name="workspace" value={workspace} />
          <ul className="media-grid">
            {media.map((item) => (
              <li key={item.id} className="media-card">
                <label className="media-select">
                  {canEdit && <input type="checkbox" name="id" value={item.id} form="archive-form" aria-label={`Select ${item.label ?? 'media'}`} />}
                  {item.type.startsWith('video/')
                    ? <video src={`${base}/media/${item.id}`} muted controls preload="metadata" />
                    : <img src={`${base}/media/${item.id}`} alt={item.alt ?? ''} loading="lazy" />}
                </label>
                <p className="muted-line">{item.label ?? 'Untitled'} · {item.type.split('/')[1]?.toUpperCase()} · {size(item.size)}</p>
                {canEdit ? (
                  <details>
                    <summary>{item.alt ? 'Edit details' : 'Add alt text'}</summary>
                    <div className="identity-form">
                      <label htmlFor={`label-${item.id}`}>Name</label>
                      <input id={`label-${item.id}`} name="label" maxLength={120} defaultValue={item.label ?? ''} form={`edit-${item.id}`} />
                      <label htmlFor={`alt-${item.id}`}>Alt text</label>
                      <textarea id={`alt-${item.id}`} name="alt" rows={3} maxLength={1000} defaultValue={item.alt ?? ''} form={`edit-${item.id}`} />
                      <button type="submit" className="btn" form={`edit-${item.id}`}>Save</button>
                    </div>
                  </details>
                ) : item.alt && <p className="muted-line">Alt: {item.alt}</p>}
              </li>
            ))}
          </ul>
          {canEdit && <button type="submit" className="btn">Remove selected from library</button>}
        </form>
      ) : <section className="panel"><p>{search ? 'No media matches that search.' : 'No media yet. Upload images or videos to reuse them in posts.'}</p></section>}
      {canEdit && media.map((item) => (
        <form key={item.id} id={`edit-${item.id}`} action={updateMediaFormAction} hidden>
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="id" value={item.id} />
        </form>
      ))}
    </>
  );
}
