import { connectLinkMetaChoices, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { saveConnectLinkSelectionAction } from '../actions';

export const metadata = { title: 'Choose accounts · Superstar', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ConnectLinkSelection({ searchParams }: { searchParams: Promise<{ selection?: string; status?: string }> }) {
  const { selection = '', status } = await searchParams;
  let choices;
  try {
    choices = await connectLinkMetaChoices(selection);
  } catch (error) {
    if (!(error instanceof WorkspaceAccessError)) throw error;
    redirect('/connect/done?status=invalid');
  }
  const facebook = choices.provider === 'facebook';
  return (
    <main className="identity-shell">
      <p className="wordmark">Superstar</p>
      <h1>Choose your {facebook ? 'Facebook Pages' : 'Instagram accounts'}</h1>
      <p>Tick every {facebook ? 'Page' : 'account'} you want to connect. Only the ones you tick are shared.</p>
      {status === 'none' && <p role="status">Tick at least one {facebook ? 'Page' : 'account'}.</p>}
      <form action={saveConnectLinkSelectionAction} className="identity-form">
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
        <button type="submit" className="primary">Connect selected accounts</button>
      </form>
      <p className="muted-line">Missing a {facebook ? 'Page' : 'account'}? Open the link you were sent again, and on Facebook choose &quot;Edit access&quot; and tick it.</p>
    </main>
  );
}
