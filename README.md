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
