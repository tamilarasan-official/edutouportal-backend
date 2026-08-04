# Edutou API

Express + TypeScript API backing the Edutou portal. PostgreSQL for data,
WebSockets for live quiz events, disk-backed file storage.

Deployed as its own container, separate from the frontend and the database.

---

## Quick start

```bash
cp .env.example .env
# set DATABASE_URL and JWT_SECRET
npm install
npm run migrate
npm run dev            # :4000
```

Or with Docker (brings its own Postgres):

```bash
POSTGRES_PASSWORD=devpw JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))") \
  docker compose up -d --build
```

First admin — signup always yields a student, and only an admin can change
roles, so the first one must be made from the shell:

```bash
npm run create-admin -- you@example.com 'a-strong-password' 'Your Name'
# in Docker:
docker compose exec backend node dist/scripts/create-admin.js you@example.com 'pw' 'Name'
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch mode on :4000 |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run migrate` | Apply pending migrations |
| `npm run typecheck` | `tsc --noEmit`, strict, zero errors expected |
| `npm test` | Integration suite (needs a Postgres — see below) |
| `npm run create-admin` | Create or promote an admin account |

---

## Tests

105 integration tests. Nothing is mocked: they boot the real app against a real
Postgres, so a green run means the deployed thing works.

```bash
docker run -d --name edutou-test-db \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_USER=edutou -e POSTGRES_DB=edutou_test \
  -p 55432:5432 postgres:16-alpine

npm test
```

`.env.test` is committed and points at that container.

**Always run via `npm test`.** It passes `--test-concurrency=1`. node:test runs
each file in its own process in parallel by default, and every file truncates
the shared database between tests — so a parallel run has one file deleting
another's fixtures mid-test, producing foreign-key violations and TRUNCATE
deadlocks. Serial: 105 pass in ~85s. Parallel: 10 spurious failures in ~640s.

Coverage:

| Suite | Tests | Area |
| --- | --- | --- |
| `auth.test.ts` | 16 | signup, login, refresh rotation, logout, password change |
| `security.test.ts` | 24 | privilege escalation, point minting, cross-user reads, SQL injection |
| `quiz.test.ts` | 31 | sessions, joining, host controls, answer scoring, leaderboard |
| `portal.test.ts` | 34 | admin / mentor / student / coursemaster CRUD, points ledger |

---

## Architecture

```
src/
├── app.ts            Express app (no listen -- tests mount this directly)
├── index.ts          boot: migrate, storage dirs, WebSocket, listen
├── config.ts         env validation; refuses to start on a bad config
├── db/               pool + migration runner
├── auth/             JWT sessions, Argon2id, Google OAuth
├── query/            generic data endpoint
│   ├── schema.ts       table/column allowlist  <- read this first
│   ├── policies.ts     per-table authorization <- and this
│   └── builder.ts      parameterised SQL construction
├── quiz/             live session control
├── rpc/              stored-procedure endpoints + admin role changes
├── storage/          uploads
└── realtime/         WebSocket hub
migrations/           schema, forward-only, committed
```

### Authorization

`schema.ts` decides what exists; `policies.ts` decides who may touch it.
A table absent from the registry is unreachable. A column absent from
`insertable`/`updatable` cannot be written — which is why `profiles.role` and
`profiles.leaderboard_points` are missing from those lists: role changes go
through `PATCH /api/admin/role`, points go through the ledger.

Policies return a row filter that is ANDed into every query, so it constrains
reads *and* bounds what an UPDATE or DELETE can reach.

### Migrations

Forward-only, applied automatically at boot, each inside a transaction and
recorded in `schema_migrations` with a checksum. Editing an already-applied
migration is a hard error — add a new numbered file instead.

`migrations/` is the schema's source of truth and must stay in version control.

---

## API surface

| Route | Purpose |
| --- | --- |
| `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout` | Sessions |
| `GET /auth/user`, `PATCH /auth/user` | Current user |
| `GET /auth/oauth/google` | Google sign-in |
| `POST /api/db` | Generic query endpoint (allowlisted + policy-checked) |
| `POST /api/rpc/:name` | `award_points`, `adjust_points_manual`, … |
| `PATCH /api/admin/role` | Role changes (admin only) |
| `/api/quiz/*` | Live session control, joining, answers, leaderboard |
| `/api/storage/:bucket` | Uploads / downloads |
| `GET /health`, `/health/ready` | Liveness / readiness |
| `WS /realtime` | Live events |

---

## Deployment

Three separate Dokploy services: this API, the frontend, and a Postgres
database. See `DEPLOYMENT.md` in the frontend repository for the full topology,
domains, and backup procedure.

Two things to get right:

- **`STORAGE_DIR` must be a mounted volume.** Without it every uploaded file is
  lost on redeploy.
- **One replica only.** The WebSocket hub keeps subscriber state in process
  memory, so an event published by one replica never reaches clients connected
  to another. Scaling out needs a Redis pub/sub adapter in `src/realtime/hub.ts`.
