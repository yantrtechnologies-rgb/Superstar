import { canManageTeam, listWebhooks, webhookConfigured } from '@cadencedesk/data';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMembership, requireUser } from '../../../../../lib/require-user';
import { toggleWebhookAction } from './actions';
import { WebhookSecretForm } from './secret-form';

const messages: Record<string, string> = {
  enabled: 'Webhook enabled for new publications.',
  paused: 'Webhook paused. Queued deliveries were skipped.',
  invalid: 'This subscription is unavailable.',
};

export default async function Webhooks({ params, searchParams }: {
  params: Promise<{ workspace: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const [{ workspace }, { status }] = await Promise.all([params, searchParams]);
  const membership = await getMembership(user.id, workspace);
  if (!membership || !canManageTeam(membership.role)) notFound();
  const subscriptions = await listWebhooks(user.id, workspace);
  const configured = webhookConfigured();
  const format = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: membership.workspace.timeZone });
  return (
    <>
      <Link href={`/app/${workspace}/automations`}>Back to automations</Link>
      <h1>Outbound webhooks</h1>
      <p>Send a signed <code>post.published</code> event when a destination confirms publication.</p>
      {status && Object.hasOwn(messages, status) && <p role="status">{messages[status]}</p>}
      {configured ? <WebhookSecretForm workspace={workspace} /> : <p>Ask your operator to configure approved endpoints and signing.</p>}
      {subscriptions.some(({ deliveries }) => deliveries.some(({ state }) => state === 'QUEUED' || state === 'SENDING')) &&
        <Link href={`/app/${workspace}/automations/webhooks?status=refresh`}>Check delivery status</Link>}
      {subscriptions.length ? <ul className="post-list">{subscriptions.map((subscription) => (
        <li key={subscription.id}>
          <article>
            <h2>{subscription.name}</h2>
            <p>{subscription.endpoint}</p>
            <p>{subscription.enabled ? 'Enabled' : 'Paused'}</p>
            {configured && <WebhookSecretForm workspace={workspace} id={subscription.id} />}
            <form action={toggleWebhookAction}>
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="id" value={subscription.id} />
              <input type="hidden" name="enabled" value={subscription.enabled ? 'no' : 'yes'} />
              <button type="submit">{subscription.enabled ? 'Pause webhook' : 'Enable webhook'}</button>
            </form>
            {subscription.deliveries.length > 0 && <ul className="workspaces-list" aria-label="Recent deliveries">
              {subscription.deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <time dateTime={delivery.createdAt.toISOString()}>{format.format(delivery.createdAt)}</time>
                  <span>{delivery.state.toLowerCase()} · {delivery.attemptsCount} attempts</span>
                  {delivery.statusCode && <span>HTTP {delivery.statusCode}</span>}
                  {delivery.state === 'QUEUED' && delivery.attemptsCount > 0 &&
                    <span>Next attempt {format.format(delivery.nextAttemptAt)}</span>}
                  {delivery.error && <p>{delivery.error}</p>}
                </li>
              ))}
            </ul>}
          </article>
        </li>
      ))}</ul> : <p>No webhook subscriptions yet.</p>}
    </>
  );
}
