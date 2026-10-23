# reservation-system

Booking for private table tennis lessons at one venue. Students use a WeChat mini program;
coaches and the admin use web apps. Build for this venue only: generic names (coach, student,
lesson type, resource, booking, package) but no multi-tenancy, plugins or unused abstractions.

## Layout

- `apps/api`: Hono + Drizzle + SQLite. `createApp(db)` in `src/app.ts`; routes under `/api`.
- `apps/admin`: Vite + React + TDesign React, desktop, served at `/admin/`.
- `apps/coach`: Vite + React + TDesign Mobile React, phone first, served at `/coach/`.
- `apps/miniprogram`: native mini program in TypeScript with TDesign Miniprogram.
- `packages/shared`: zod schemas, types, booking rules, venue time helpers. Used by every app.
- `packages/theme`: brand tokens. Edit `tokens.json`, then `pnpm --filter @rs/theme generate`.
- `qa/e2e`: Playwright specs for admin and coach. `qa/miniprogram`: automator scripts.

## Commands

```sh
pnpm install
pnpm dev          # api :8787, admin :5173/admin/, coach :5174/coach/
pnpm lint         # biome; `pnpm format` to fix
pnpm typecheck
pnpm test         # vitest + theme check
pnpm build
pnpm e2e          # starts servers itself
pnpm --filter @rs/api db:generate   # after schema changes
```

## Rules

- All UI copy is Simplified Chinese, short product copy, no marketing tone.
- Times are stored as UTC instants; use `venueDateKey` / `venueInstant` from `@rs/shared` for
  venue dates. Never rely on the machine's time zone.
- Booking rules live in `packages/shared` (pure functions) or the API, with Vitest coverage.
- Mini program: run `pnpm --filter @rs/miniprogram build` before opening DevTools; it copies
  TDesign into `miniprogram_npm`, bundles `@rs/shared` into `lib/`, and writes `WX_APPID` into
  the gitignored `project.private.config.json`. Do not name a class
  `.page`: TDesign's theme file sets tokens on `.page`, which would undo the brand colors.
- Follow WeChat design rules: keep the native navigation bar and capsule area, 44px minimum tap
  targets, main action in a fixed bottom bar, loading, empty and error states on every list,
  support dark mode.

## QA

A feature is done only after it has been driven for real, not just unit tested:
Vitest for rules and API, Playwright for admin and coach (also try odd inputs and check
screenshots in light and dark), and `pnpm --filter @rs/qa-miniprogram smoke` plus feature
scripts in WeChat DevTools on a Mac for the mini program.

## Git

Conventional commits in English, subject line only, no body, no em dashes.
Example: `feat(api): add booking cancellation`. One PR per feature.
