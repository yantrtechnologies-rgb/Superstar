# Decisions

## 2026-11-17

- Use CadenceDesk AI and `cadencedesk`, as specified by the explicit brand configuration. Domain, verified sender, support address, pricing and legal copy remain owner settings.
- Use [Postiz commit 36d5fc7](https://github.com/gitroomhq/postiz-app/commit/36d5fc7b3ac3f17178b1589cf7a7337523017a41) as the initial source baseline. This is an observed main-line commit from September 3, 2026. Current hosted documentation may describe later behavior. GitHub was reachable through web research, but the local Git clone could not connect over HTTPS.
- Implement independently using product behavior and official provider contracts. The [Postiz license](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/LICENSE) is AGPL-3.0. Section 13 addresses network users' access to corresponding source for modified versions. No upstream implementation or product assets were copied.
- Treat [hosted pricing](https://postiz.com/pricing) as public plan evidence. It advertises MCP, CLI and API across paid plans and lists plan-specific capacity. Account-level enforcement and actual provider approval remain unverified.

## Scaffold

- Compose uses one development application image for the web, API, worker and migration command. Migration completion gates API startup, and Temporal health gates worker startup.
- The first migration establishes workspace identity and slugs. Memberships, sessions and invitations are scheduled for Phase 2.
- The web uses a branded landing page and health route. Redis and S3-compatible storage are provisioned for later integration. The worker polls the CadenceDesk task queue for an internal probe activity.

## Workspace identity

- Auth.js uses database-backed sessions and one-use, 15-minute magic links. Phase 2 uses the Prisma adapter and Resend delivery with branded React Email templates.
- Workspace selection uses the route slug. The server derives the actor from the session and scopes each lookup to its membership. New workspaces receive an owner and an audit event in the create transaction.
- Invitations are tied to a verified email and expire after seven days. Accepting an invitation creates membership and records the audit event in a transaction. Failed email delivery leaves the invitation available to the intended recipient and the sender can retry.
- Owners can invite admins, editors, reviewers and viewers. Admins can invite editors, reviewers and viewers. All workspace members can view the team roster and their own workspace overview. Feature commands will add their capability checks as their surfaces ship.

## Publishing core

- Discord uses an operator-installed bot with workspace-specific destination grants. The channel and worker commands check the grant before calling Discord. The first adapter supports server text channels and uses a stable nonce. The [Discord Create Message reference](https://docs.discord.com/developers/resources/message#create-message) defines the request contract.
- Approval binds the text, attachment and destination set to one revision. Editing creates a draft revision that requires fresh approval. Workspace owners and admins may approve their own posts in this phase.
- PostgreSQL commits destinations and outbox rows atomically. Temporal uses one stable workflow ID per destination. It backs off confirmed rate limits. A crash or ambiguous external result moves the destination to uncertain, where the operator can check Discord before sending again.
- The draft form relays one PNG or JPEG to a signed PUT URL. It stores the original under the workspace key and checks size, signature and checksum before publication. Automatic cleanup for unreferenced objects and media renditions are pending.
- The first calendar surface is an agenda. The schedule input is UTC. The agenda renders in the workspace time zone. Month and week views, rescheduling and manual destination retries remain open.

## Connector parity checkpoint

- Discord, Telegram and Slack use a typed provider contract for discovery, validation and publication with operator-managed bot credentials. Reconnecting refreshes destination metadata. Workspace grants are checked both on connection and before publishing.
- The first Telegram path handles channel and supergroup text plus a single image. The first Slack path handles text with previews disabled. Telegram and Slack ambiguous writes are marked uncertain. Slack permalink lookup is a separate read after a confirmed write.
- Account OAuth, token refresh, revocation, provider analytics, per-channel overrides and the other 32 connector variants remain open.

## LinkedIn OAuth checkpoint

- OAuth state expires after ten minutes, is stored as a hash, and is bound to the initiating CadenceDesk user and workspace. The callback consumes state before exchanging the code and rechecks workspace management permissions before storage.
- Access and refresh tokens use AES-256-GCM with a random IV and workspace, channel and token-type bindings. A row lock serializes refreshes for each channel. On HTTP 401 the adapter attempts a refresh once if it has a usable refresh credential. Disconnect removes the local credential while preserving the channel and its publishing history.
- The first LinkedIn connector supports public text posts for a member profile. It uses the self-serve Share on LinkedIn contract. Pages, document uploads, analytics and live app verification remain open.

## Collaboration and insights checkpoint

- Review links are scoped by a hashed bearer token to one post revision. They expire, can be revoked, and reveal only the selected revision and its destination labels, attachment and feedback for that link. A change request returns the post to draft and closes links for the revision. Internal approvals and client decisions share the same approval gate.
- Channel groups organize the agenda. Workspace membership governs channel access. The external client link limits the review surface.
- Shared posting slots use the workspace IANA time zone and skip occupied minutes. The search skips nonexistent spring-forward times and uses the earlier occurrence in a repeated fall-back hour.
- A Telegram refresh creates a durable job per channel per five-minute window. Zero is a recorded measurement. Unsupported providers and unsuccessful refreshes display unavailable states. Scheduled imports, post-level analytics, exports, editorial assignments and group membership permissions remain pending.

## AI and automation checkpoint

- The Studio uses OpenAI for social text and single-image generation. The operator configures model IDs and base credit amounts. The server reconfirms the quote before reserving credits. Job request IDs make repeated submissions idempotent within a workspace.
- A conditional balance decrement and its ledger entry commit together. The worker claims a job once. The finalizer captures the reservation on success or refunds it on failure, queued cancellation or interrupted execution. Failed ambiguous provider calls are refunded without automatically retrying the generation. Phase 8 adds subscription and purchased-credit grants.
- Generated images are stored under workspace-owned keys. This checkpoint makes the result downloadable from the Studio. Text and attachment transfers into the composer are manual.
- RSS imports are limited to exact operator-configured public HTTPS feed URLs. DNS results are checked and the connection is pinned to a verified public IPv4 address. Redirects, compressed bodies, oversized documents, DTDs and entity declarations are rejected. A source item key is unique per rule, and each imported item becomes an unapproved draft.
- AI video, engagement-triggered plugs, unattended RSS publishing and live AI verification remain pending.

## Outbound webhook delivery

- Confirmed destination publication creates at most one delivery per enabled subscription in the same transaction as the publishing result. Each delivery retains its body and ID across attempts. The worker signs each attempt with its timestamp and the current encrypted subscription secret.
- Receivers use exact operator-approved public HTTPS URLs. Webhooks share RSS's public IPv4 DNS pinning. The worker rejects redirects and discards response bodies.
- Network errors and HTTP 408, 425, 429 and 5xx responses are retryable. Attempts and status codes are persisted. A delivery reclaimed after an interrupted attempt keeps its delivery ID so the receiver can deduplicate it.

## Video Studio checkpoint

- Studio sources and clips are workspace-owned MP4 assets. Uploads use a signed PUT, and reads verify the stored size and SHA-256 checksum. Clip jobs validate their time range against the source with FFprobe and produce a bounded H.264/AAC MP4 for download.
- The media worker polls a separate Temporal task queue. Compose gives it a read-only container, bounded scratch space, resource limits, and an internal network shared with the database, Temporal and object storage. FFmpeg receives local file paths and a minimal process environment.
- Video transcription sends the selected MP4 to the configured OpenAI project. Transcription shares quoted credit reservation, capture and refund behavior with text and image generation. Manual clips use local compute and consume zero AI credits.
- Live OpenAI verification, generated video, automated clip suggestions, captions and publishing plugs remain pending. The current composer accepts images and text. Studio clips are available for download.

## Reviewed publishing automations

- An RSS rule may schedule imports after a human approval. The authorizing owner or admin, enabled rule, channel set and current approval are rechecked when reserving a shared slot. Existing draft-only imports retain their mode. Slots that become available are picked up on the next scheduling pass.
- A Discord follow-up is part of the approved revision. A confirmed parent publication creates its delayed destination and outbox event atomically. The reply uses that parent's message ID, the worker's normal destination retry guards and suppressed mentions. The post publication webhook represents the parent publication.
- Engagement-triggered plugs, unattended RSS publishing, live Discord replies, and video attachments in the composer remain open.

## Workspace API checkpoint

- Owners and admins issue expiring keys with explicit endpoint scopes. The database stores a digest and prefix. The key resolves only for its bound workspace and while the issuer remains an owner or admin.
- The NestJS API shares Zod contracts with the web app and uses the existing publishing commands. Draft creation can bind a request ID to the original draft. The review and scheduling endpoints preserve revision approval and the same transactional outbox.
- Rate limiting uses an atomic Redis counter for each key and minute. API readiness requires PostgreSQL and Redis. A request receives 503 when the rate-limit cache is unavailable.
- The workspace TypeScript SDK validates shared REST contracts. The CLI emits JSON, and the local stdio MCP server binds to one workspace and one scoped key. Both use the same SDK and server approval checks.
- Hosted MCP, public SDK distribution, embedded onboarding and the partnership workflow remain pending.
