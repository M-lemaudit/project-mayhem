# Repository Guidelines

## Project Structure & Module Organization
Core bot code lives in `src/`:
- `src/core/` contains runtime logic (auth loop, sniper loop, filtering).
- `src/services/` contains integrations and state-sync services.
- `src/config/`, `src/types/`, and `src/utils/` hold shared config, typings, and helpers.
- `src/scripts/` contains manual/integration test runners compiled to `dist/scripts/`.

Build output goes to `dist/`. Database migrations are in `supabase/migrations/` and follow timestamped names like `20260310100000_create_accepted_offers.sql`.  
The admin UI is a separate Next.js app in `admin/` (`app/`, `components/`, `lib/`).

## Build, Test, and Development Commands
Run from repository root unless noted:
- `npm run build`: compile backend TypeScript to `dist/`.
- `npm run typecheck`: strict TS check with no emit.
- `npm run lint` / `npm run lint:fix`: lint `src/**/*.ts` with ESLint.
- `npm run format` / `npm run format:check`: apply/check Prettier on backend TS files.
- `npm run start`: run compiled backend (`dist/index.js`).
- `npm run test:offers` (or `test:auth`, `test:sniper`, etc.): build then run script-based checks.
- `npm run admin:dev`: start admin app on `http://localhost:3001`.
- In `admin/`: `npm run dev | build | start | lint`.

## Coding Style & Naming Conventions
TypeScript is strict (`strict: true`, `noImplicitAny: true`). Prefer explicit types at module boundaries and avoid `any` (enforced).  
Formatting: 2-space indentation, single quotes, semicolons, trailing commas (`es5`), max line width 100.  
Use descriptive, feature-based filenames in kebab-case (e.g., `ride-sync.ts`, `test-fetch-offers.ts`).

## Testing Guidelines
This repository currently uses script-driven tests rather than a unit test framework.  
Add test scripts under `src/scripts/` with `test-*.ts` naming, then expose a matching `npm run test:*` command when useful.  
Before opening a PR, run at minimum: `npm run typecheck`, `npm run lint`, and the relevant `npm run test:*` scripts.

## Commit & Pull Request Guidelines
Current history favors short, scope-focused commit subjects (often backend behavior oriented). Keep subjects imperative and specific (e.g., `fix proxy rotation on TLS errors`).  
PRs should include:
- concise problem/solution description,
- linked issue or task,
- validation steps with exact commands run,
- screenshots for `admin/` UI changes,
- notes for any `.env`, Supabase migration, or deployment impact.

## Security & Configuration Tips
Do not commit real secrets; use `.env.example` as the template.  
If config changes affect both apps, mirror required variables in root `.env` and `admin/.env.local`.
