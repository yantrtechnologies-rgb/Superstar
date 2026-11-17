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
