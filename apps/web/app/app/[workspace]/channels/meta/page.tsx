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
  return (
    <>
      <h1>Choose your {choices.provider === 'facebook' ? 'Facebook Pages' : 'Instagram accounts'}</h1>
      <p>Select the accounts you want to connect to this workspace.</p>
      <form action={metaConnectionAction} className="identity-form">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="workspace" value={workspace} />
        <input type="hidden" name="selection" value={selection} />
        {choices.accounts.map((account) => (
          <label key={account.id} className="channel-choice">
            <input type="checkbox" name="account" value={account.id} /> {account.name}
          </label>
        ))}
        <button type="submit">Connect selected accounts</button>
      </form>
      <Link href={'/app/' + workspace + '/channels'}>Cancel</Link>
    </>
  );
}
