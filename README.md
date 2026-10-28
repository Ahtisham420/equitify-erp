# EquitiFy CRE operating system

A single Next.js app (`frontend/`): the React UI plus the whole REST API (`/api/v1/*`) as route handlers,
using Drizzle ORM on Postgres + PostGIS. The former FastAPI backend has been removed.

## Setup
```
cd frontend
cp .env.example .env        # set DATABASE_URL, JWT_SECRET, ...
npm install
npm run db:push             # creates the tables (Postgres needs postgis + pg_trgm available)
npm run dev                 # http://localhost:3000
```
On first start the server seeds the default roles and the admin user (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`)
and starts the scheduled automations (`SCHEDULER_ENABLED=false` disables them).

## Layout
- `frontend/src/app`: UI pages and `app/api/v1/[[...path]]/route.ts` (single API entry point)
- `frontend/src/server`: the API. `core/` (router, auth deps, events, scheduler), `db/`, `common/`, and
  `modules/<name>/` (`schema.ts` tables, `schemas.ts` validation, `service.ts`, `router.ts`, `handlers.ts`)
- `npm run gen:registry` regenerates `server/registry.generated.ts` after adding a module (`dev` and `build` do it automatically)
