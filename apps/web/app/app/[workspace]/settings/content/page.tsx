import { canWritePosts, listContentSettings } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../../lib/require-user';
import { deleteSetAction, deleteSignatureAction, deleteTagAction, saveSignatureAction, saveTagAction } from '../../media/actions';

const messages: Record<string, string> = {
  saved: 'Saved.', deleted: 'Deleted.', invalid: 'Check the name and text and try again.',
  unavailable: 'You do not have access to change content settings, or the name is already used.',
};

function Hidden({ workspace, id }: { workspace: string; id?: string }) {
  return <><input type="hidden" name="workspace" value={workspace} />{id && <input type="hidden" name="id" value={id} />}</>;
}

export default async function ContentSettings({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership) notFound();
  const { tags, signatures, postSets } = await listContentSettings(user.id, workspace);
  const canEdit = canWritePosts(membership.role);
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Content settings</h1>
          <p>Tags, signatures and saved sets used by the composer.</p>
        </div>
        <Link className="btn" href={`/app/${workspace}/settings`}>Team settings</Link>
      </header>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}

      <section className="panel" aria-labelledby="tags-heading">
        <h2 id="tags-heading">Tags</h2>
        <p className="muted-line">Colour-code posts by campaign, client or topic. The first tag colours the post on the calendar.</p>
        <ul className="settings-list">
          {tags.map((tag) => (
            <li key={tag.id}>
              <span className="chip static" style={{ ['--tag' as string]: tag.color }}>{tag.name}</span>
              {canEdit && <>
                <form action={saveTagAction} className="calendar-filter">
                  <Hidden workspace={workspace} id={tag.id} />
                  <label className="sr-only" htmlFor={`tag-name-${tag.id}`}>Name</label>
                  <input id={`tag-name-${tag.id}`} name="name" defaultValue={tag.name} maxLength={40} required />
                  <label className="sr-only" htmlFor={`tag-color-${tag.id}`}>Colour</label>
                  <input id={`tag-color-${tag.id}`} name="color" type="color" defaultValue={tag.color} />
                  <button type="submit">Save</button>
                </form>
                <form action={deleteTagAction}><Hidden workspace={workspace} id={tag.id} /><button type="submit" className="btn">Delete</button></form>
              </>}
            </li>
          ))}
        </ul>
        {canEdit && (
          <form action={saveTagAction} className="calendar-filter">
            <Hidden workspace={workspace} />
            <label className="sr-only" htmlFor="new-tag">New tag name</label>
            <input id="new-tag" name="name" placeholder="New tag name" maxLength={40} required />
            <input name="color" type="color" defaultValue="#7b4dff" aria-label="Tag colour" />
            <button type="submit" className="primary">Add tag</button>
          </form>
        )}
      </section>

      <section className="panel" aria-labelledby="signatures-heading">
        <h2 id="signatures-heading">Signatures</h2>
        <p className="muted-line">Reusable endings such as links or hashtags. The default signature is added to every new post.</p>
        <ul className="settings-list stacked">
          {signatures.map((signature) => (
            <li key={signature.id}>
              {canEdit ? (
                <form action={saveSignatureAction} className="identity-form">
                  <Hidden workspace={workspace} id={signature.id} />
                  <label htmlFor={`sig-name-${signature.id}`}>Name</label>
                  <input id={`sig-name-${signature.id}`} name="name" defaultValue={signature.name} maxLength={60} required />
                  <label htmlFor={`sig-content-${signature.id}`}>Text</label>
                  <textarea id={`sig-content-${signature.id}`} name="content" rows={3} defaultValue={signature.content} maxLength={2000} required />
                  <label className="channel-choice"><input type="checkbox" name="isDefault" defaultChecked={signature.isDefault} /> Add to new posts automatically</label>
                  <div className="post-actions">
                    <button type="submit" className="btn">Save</button>
                    <button type="submit" className="btn" formAction={deleteSignatureAction}>Delete</button>
                  </div>
                </form>
              ) : <p className="post-content"><strong>{signature.name}</strong>{signature.isDefault ? ' (default)' : ''}<br />{signature.content}</p>}
            </li>
          ))}
        </ul>
        {canEdit && (
          <details>
            <summary>Add a signature</summary>
            <form action={saveSignatureAction} className="identity-form">
              <Hidden workspace={workspace} />
              <label htmlFor="sig-name">Name</label>
              <input id="sig-name" name="name" maxLength={60} required />
              <label htmlFor="sig-content">Text</label>
              <textarea id="sig-content" name="content" rows={3} maxLength={2000} required />
              <label className="channel-choice"><input type="checkbox" name="isDefault" /> Add to new posts automatically</label>
              <button type="submit" className="primary">Add signature</button>
            </form>
          </details>
        )}
      </section>

      <section className="panel" aria-labelledby="sets-heading">
        <h2 id="sets-heading">Saved sets</h2>
        <p className="muted-line">Presets of channels, text, thread, tags and repeat. Save one from the composer with “Save as set”, then start new posts from it.</p>
        {postSets.length ? (
          <ul className="settings-list">
            {postSets.map((set) => (
              <li key={set.id}>
                <span>{set.name}</span>
                {canEdit && <form action={deleteSetAction}><Hidden workspace={workspace} id={set.id} /><button type="submit" className="btn">Delete</button></form>}
              </li>
            ))}
          </ul>
        ) : <p className="muted-line">No sets yet.</p>}
      </section>
    </>
  );
}
