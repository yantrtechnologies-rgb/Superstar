import { metaAccountChoices, WorkspaceAccessError } from '@cadencedesk/data';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '../../../../../lib/require-user';
import { metaConnectionAction } from './actions';

export default async function MetaAccountSelection({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ selection?: string }>;
}) {
  const user = await requireUser();
  const { workspace } = await params;
  const { selection = '' } = await searchParams;
  let choices;
  try {
    choices = await metaAccountChoices(user.id, workspace, selection);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    redirect('/app/' + workspace + '/channels?status=meta-unavailable');
  }
  const facebook = choices.provider === 'facebook';
  const noun = facebook ? 'Page' : 'Instagram account';
  return (
    <>
      <h1>Choose your {facebook ? 'Facebook Pages' : 'Instagram accounts'}</h1>
      <p>
        Superstar found {choices.accounts.length} {noun}{choices.accounts.length === 1 ? '' : 's'} you can publish to,
        including Pages in your Meta Business portfolios. Tick every one you want in this workspace.
      </p>
      <form action={metaConnectionAction} className="identity-form">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="selection" value={selection} />
        {choices.accounts.map((account) => (
          <label key={account.id} className="channel-choice">
            <input type="checkbox" name="account" value={account.id} /> {account.name}
          </label>
        ))}
        {choices.unavailable.map((account) => (
          <label key={account.id} className="channel-choice" title={account.reason}>
            <input type="checkbox" disabled /> <span>{account.name} <small>— can&apos;t connect: {account.reason}</small></span>
          </label>
        ))}
        <button type="submit">Connect selected accounts</button>
      </form>
      <Link href={'/app/' + workspace + '/channels'}>Cancel</Link>

      <section className="identity-form" aria-labelledby="missing-heading">
        <h2 id="missing-heading">Missing a {facebook ? 'Page' : 'account'}?</h2>
        <p>
          Facebook only shares the Pages you ticked the first time you allowed Superstar, and quietly reuses that choice afterwards.
          To add another Page:
        </p>
        <ol>
          <li>Choose <strong>Reconnect and choose Pages</strong> below.</li>
          <li>In the Facebook window, choose <strong>Edit access</strong> (or <strong>Edit previous settings</strong>) instead of continuing straight away.</li>
          <li>Tick every Page you want{facebook ? '' : ' (and its linked Instagram account)'}, or <strong>Opt in to all current and future Pages</strong>, then continue.</li>
        </ol>
        <p>
          If Facebook never offers that choice, remove Superstar under Facebook{' '}
          <a href="https://www.facebook.com/settings/?tab=business_tools" target="_blank" rel="noreferrer">Settings → Business integrations</a>,
          then reconnect. Facebook will then ask for the Pages from scratch.
        </p>
        <form action={metaConnectionAction}>
          <input type="hidden" name="intent" value="connect" />
          <input type="hidden" name="workspace" value={workspace} />
          <input type="hidden" name="provider" value={choices.provider} />
          <button type="submit">Reconnect and choose Pages</button>
        </form>
        {facebook && (
          <p>
            <small>
              Personal Facebook profiles can&apos;t be connected: since 2018 Facebook lets apps publish only to Pages, not to personal timelines.
            </small>
          </p>
        )}
      </section>
    </>
  );
}
