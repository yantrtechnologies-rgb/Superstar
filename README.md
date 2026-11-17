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
