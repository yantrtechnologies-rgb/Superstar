# CadenceDesk AI

CadenceDesk is a social campaign workspace. This scaffold includes a branded web entry point, NestJS with OpenAPI, an initial PostgreSQL migration and a Temporal worker.

## Local stack

With Docker and Compose installed, run `docker compose up --build`. Compose starts PostgreSQL, Redis, Temporal and MinIO and applies the database migration before starting the API. The Compose credentials and loopback ports are for local development.

| URL | Surface |
| --- | --- |
| http://localhost:3000 | Web |
| http://localhost:3000/health | Web liveness |
| http://localhost:3001/docs | OpenAPI |
| http://localhost:3001/health | API liveness |
| http://localhost:3001/health/ready | API database readiness |
| http://localhost:3002 | Worker readiness |

Object storage and Redis are provisioned for later features. Create the configured bucket before implementing media uploads. Phase 2 introduces account access.

## Development checks

Use Node.js 22.12 or later and pnpm 10.10.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For a host-run process, export its environment variables from the settings in `.env.example`. The Compose file supplies container-specific values.

## Sign-in and team access

For real email delivery, copy `.env.example` to `.env` for Compose. Set `APP_URL` to the public application origin, `AUTH_SECRET` to a random secret, `EMAIL_FROM` to a verified Resend sender, and `RESEND_API_KEY` to a sending key. Compose sets `AUTH_URL` from `APP_URL`. For a host-run web process, export both URLs with the same value. For public deployments, use HTTPS.

Open `/login` and sign in with the link from your inbox. Create a workspace at `/app`. The workspace owner can open Team settings and invite a teammate. The recipient signs in using the invited address and accepts from the workspace directory.

To run the identity browser test, configure `DATABASE_URL` for a dedicated test database, apply migrations, build, run `pnpm exec playwright install chromium`, then run `pnpm exec playwright test`. The test server captures outbound Resend messages locally.

## Discord publishing

1. Create a Discord bot and install it in your test server. Grant View Channel and Send Messages in the test channel. Add Attach Files if you plan to publish images.
2. Add `DISCORD_BOT_TOKEN` to the server environment. In `DISCORD_WORKSPACE_CHANNELS`, map a CadenceDesk workspace slug to allowed Discord channel IDs. For example, `{"studio-ab12cd34":["123456789012345678"]}`.
3. Create the configured object storage bucket before uploading images. The local Compose endpoint is `http://localhost:9000` from the host and `http://storage:9000` from the containers.
4. Connect the channel in Channels. In Posts, create a draft with text and an optional image, select the destinations, request approval and approve the revision. Schedule in UTC or use Publish now. The agenda shows the workspace time zone.
5. Open the resulting Discord permalink from Posts. If the result is uncertain, check the destination in Discord before sending again.

To run the publishing integration test, apply migrations to a dedicated database, run `pnpm build`, then run `node --test apps/worker/test/publishing.integration.mjs` with that database URL. The test starts a local Temporal server and intercepts Discord and storage requests.

## Telegram and Slack

- Telegram uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WORKSPACE_CHATS`. Add the bot to the target channel as an administrator with posting rights, or to a supergroup where it can send messages and photos. Map the workspace slug to a list of numeric channel or supergroup IDs as strings. The composer supports text and a single image with a caption. [Telegram Bot API](https://core.telegram.org/bots/api)
- Slack uses `SLACK_BOT_TOKEN` and `SLACK_WORKSPACE_CHANNELS`. Install a bot with `chat:write` and the applicable `channels:read` or `groups:read` scope, invite it into the channel, then grant the channel ID to the workspace. The composer supports text. If Slack confirms delivery but cannot return a permalink, CadenceDesk keeps the published timestamp. [Slack publishing](https://docs.slack.dev/reference/methods/chat.postMessage/) · [Slack discovery](https://docs.slack.dev/reference/methods/conversations.info/)
- Restart the web and worker with the updated environment, then connect or refresh the destination in Channels. Grants are rechecked when a scheduled post runs.

## LinkedIn member publishing

1. Enable **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** in your LinkedIn developer app. Register the exact redirect URL `<APP_URL>/api/connect/linkedin`. [LinkedIn app permissions](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access) · [LinkedIn authorization flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
2. Configure `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` for the web and worker. Generate the encryption key with `openssl rand -base64 32` and keep it stable across restarts.
3. As a workspace owner or admin, open Channels and choose **Authorize or reconnect LinkedIn**. Connect a member profile and approve a text post for it. This adapter publishes public member posts through the self-serve Share on LinkedIn API. [Member publishing contract](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)

LinkedIn issues refresh tokens to eligible apps. CadenceDesk refreshes when a token is available and asks the workspace to reconnect when authorization has expired or been rejected. Disconnect removes the stored tokens and keeps the channel history. [Programmatic refresh eligibility](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

## Client review, groups and analytics

In **Posts**, select destinations and request approval. Create a client review link with a one-, seven- or fourteen-day expiration, then copy it from the form. The client can preview that revision, comment, approve it or request changes without signing in. Revoke the link from the post when access is no longer needed. Editing creates a new revision and closes links to the previous one.

In **Channels → Channel groups and posting slots**, create groups, assign channels and add weekly times in the workspace time zone. **Use next shared slot** searches for a time configured for every approved destination. The agenda can be filtered by client group.

In **Analytics**, refresh a Telegram channel to import its current member count. The worker records observations and keeps the previous values when a refresh fails. The date selector filters observation history. [Telegram getChatMemberCount](https://core.telegram.org/bots/api#getchatmembercount)

## AI Studio and RSS automations

Set `OPENAI_API_KEY` and the supported models for `OPENAI_TEXT_MODEL` and `OPENAI_IMAGE_MODEL`. Configure the base credit amounts separately for text and image jobs. CadenceDesk multiplies the base amount by `AI_CREDIT_MARKUP` and rounds up to the next credit. Image jobs also require the object storage settings and bucket. [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) · [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)

Set `AI_STARTER_CREDITS` before a workspace first reserves credits to grant it a one-time starter allowance. The default is zero. Each accepted job reserves its quote. A completed generation captures the reservation, and a failed or canceled queued job returns it. The Studio shows job history and credit activity.

Set `RSS_ALLOWED_FEEDS` to a comma-separated list of exact public HTTPS feed URLs. Add a rule in Automations to import a feed into drafts. Enabled rules run every 15 minutes, and owners, admins and editors can request a run manually. Imported drafts use the normal review and publishing flow.

## Outbound webhooks

Set `WEBHOOK_ALLOWED_ENDPOINTS` to a comma-separated list of exact public HTTPS receiver URLs and configure `TOKEN_ENCRYPTION_KEY`. Workspace owners and admins can manage subscriptions under **Automations → Manage outbound webhooks**. Copy the signing secret when creating or rotating it.

CadenceDesk sends a JSON `post.published` event per confirmed destination. Its event ID is the destination UUID. The payload includes the post ID, destination ID, channel ID, provider, external post ID and permalink. Its delivery ID stays the same across retries for that subscription.

| Header | Value |
| --- | --- |
| `X-CadenceDesk-Event` | `post.published` |
| `X-CadenceDesk-Delivery` | Stable delivery UUID |
| `X-CadenceDesk-Timestamp` | Unix seconds for this attempt |
| `X-CadenceDesk-Signature` | `v1=` followed by the hexadecimal HMAC-SHA256 digest |

Verify the signature over `timestamp.deliveryId.rawBody` using the subscription secret and a constant-time comparison. Allow a limited timestamp skew and deduplicate deliveries by ID before applying effects. Return a 2xx status on success or if the delivery ID was processed already. CadenceDesk retries network failures and retryable HTTP responses up to five attempts total. Pausing skips queued deliveries. Enabling resumes delivery for new publications.

## Video clips and transcripts

Upload an MP4 of up to 20 MiB in **AI Studio → Workspace video**. Select the source and enter a start time and a duration between 1 and 60 seconds to create a downloadable MP4 clip. The Studio retains both the source and the result.

Compose starts a dedicated FFmpeg media worker. For a host-run stack, install `ffmpeg` and `ffprobe`, configure the database, Temporal and object storage, and run `pnpm --filter @cadencedesk/worker start:media` alongside the main worker. Set `MEDIA_CLIPPING_ENABLED=true` for the web process. Set `FFMPEG_PATH` and `FFPROBE_PATH` when the binaries are outside your executable path. [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html)

To transcribe the audio of a workspace MP4, configure `OPENAI_TRANSCRIBE_MODEL` and `AI_TRANSCRIBE_BASE_CREDITS` alongside the OpenAI key. The Studio displays the credit quote before sending the selected file to OpenAI. Results and failed-job refunds appear in the same history as other Studio jobs. [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)

## Reviewed RSS publishing and delayed replies

When creating an RSS rule, enable **Schedule approved imports in the next shared slot** and select its destinations. A compatible imported item enters review with those destinations. Approving its current revision lets the worker schedule it in the next shared posting slot. Items that exceed destination limits open as drafts for editing. If a slot is unavailable, the rule reports the reason and retries after five minutes. Pausing a rule stops future imports and automatic scheduling. Cancel a post in Posts to remove its existing pending destinations.

In the post editor, expand **Discord follow-up** to add reply text and a delay. The reply appears in the revision preview. Each successful Discord destination schedules its own reply, and the Posts screen shows the reply's status. Grant the bot **Read Message History** along with channel access and posting permission. [Discord message replies](https://docs.discord.com/developers/resources/message#create-message)

## Workspace REST API

Workspace owners and admins can issue and revoke keys under **Team settings → Manage API keys**. Use the key in the `Authorization: Bearer` header and the matching workspace slug in `/v1/workspaces/{workspace}`. Keys stop working at expiry, revocation, or when the issuing member loses owner or admin access. Set `API_PUBLIC_URL` to the API's public base URL if the documentation is hosted separately.

| Method and path under the workspace prefix | Scope |
| --- | --- |
| `GET /channels` | `channels:read` |
| `GET /posts` and `GET /posts/{id}` | `posts:read` |
| `POST /posts` and `POST /posts/{id}/review` | `posts:write` |
| `POST /posts/{id}/schedule` and `POST /posts/{id}/cancel` | `posts:schedule` |

List endpoints accept `limit` and `offset` and return `nextOffset`. Draft creation accepts an optional UUID in `Idempotency-Key`. Reuse that UUID when retrying the same payload. A different payload with the same key returns HTTP 409. Request review in the API and approve the revision in CadenceDesk or with a client review link. Scheduling supports `now`, `next`, and `at` with an explicit future UTC timestamp.

The API uses Redis for a per-key minute limit configured with `API_REQUESTS_PER_MINUTE`. A rate-limited response includes `Retry-After`. Swagger UI is at `/docs`, and the OpenAPI document is at `/docs-json`.

Example using a locally running API

```sh
curl -H "Authorization: Bearer $CADENCEDESK_API_KEY" \
  "http://localhost:3001/v1/workspaces/$CADENCEDESK_WORKSPACE/posts?limit=25"
```

## SDK, CLI and local MCP

Build the workspace with `pnpm build`. Run the clients on Node 22 or later. Configure `CADENCEDESK_WORKSPACE` and `CADENCEDESK_API_KEY` in the process environment. Set `CADENCEDESK_API_URL` if the API runs outside `http://localhost:3001`. Use HTTPS for remote APIs. For a trusted private HTTP network, set `CADENCEDESK_ALLOW_HTTP=true`.

Workspace TypeScript packages can depend on `@cadencedesk/sdk` using `workspace:*`.

```ts
import { clientFromEnvironment } from '@cadencedesk/sdk';

const client = clientFromEnvironment();
const { items, nextOffset } = await client.listPosts({ limit: 25 });
```

Run the CLI from the repository root.

```sh
node apps/cli/dist/main.js --help
node apps/cli/dist/main.js channels
node apps/cli/dist/main.js draft --file campaign.txt
```

Configure your MCP host to launch `node` with the absolute path to `apps/mcp/dist/main.js` as its argument and pass the three environment variables through the host's environment settings. Give the key the scopes needed for the tools you intend to use. For example, an agent that reads channel and post data needs only `channels:read` and `posts:read`. Launch one MCP process per workspace. A reviewer must approve the current revision before any client can schedule it. [MCP stdio transport](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)

## Pricing and workspace usage

Open `/pricing` for the plan comparison. To display proposed limits, set `BILLING_PLAN_LIMITS` in the web process environment. Keys are `free`, `creator`, `team` and `agency`. For example, `{"free":{"limits":{"seats":3}}}` displays a proposed three-seat limit on Free. Omitted values show as TBD. These limits are informational.

Workspace owners and admins can open **Usage and billing** for counts and the latest 20 AI credit ledger entries. Entitlement enforcement and Stripe credit-pack purchases are pending.

For hosted billing tests, set `APP_MODE=hosted`, a Stripe test secret key in `STRIPE_SECRET_KEY`, a test endpoint secret in `STRIPE_WEBHOOK_SECRET`, and one or more recurring `STRIPE_PRICE_<PLAN>_<INTERVAL>` IDs from `.env.example`. Configure the Stripe Customer Portal in the same test account. Open **Usage and billing** to start Checkout. Forward Stripe snapshot events to `/api/stripe/webhook`, including `checkout.session.completed` and subscription created, updated and deleted. The webhook verifies the raw body, records event IDs, and retrieves the current subscription from Stripe. [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create) · [Stripe webhooks](https://docs.stripe.com/webhooks)
