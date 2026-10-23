# reservation-system

Booking for private table tennis lessons at one venue. Students and coaches use one WeChat mini
program (coaches in a coach mode); the admin uses a web app. Build for this venue only: generic
names (coach, student, lesson type, resource, booking, package) but no multi-tenancy, plugins or
unused abstractions.

## Layout

- `apps/api`: Hono + Drizzle + SQLite. `createApp(db)` in `src/app.ts`; routes under `/api`.
- `apps/admin`: Vite + React + TDesign React, desktop, served at `/admin/`.
- `apps/miniprogram`: native mini program in TypeScript with TDesign Miniprogram. Coach pages
  live in the `coach/` subpackage and use their own coach session.
- `packages/shared`: zod schemas, types, booking rules, venue time helpers. Used by every app.
- `packages/theme`: brand tokens. Edit `tokens.json`, then `pnpm --filter @rs/theme generate`.
- `qa/e2e`: Playwright specs for admin. `qa/miniprogram`: automator scripts.
- `deploy/`: Docker image, compose, Caddy, backups to COS and the runbook (`deploy/README.md`).
  New env vars go in `deploy/README.md` and `deploy/env/*.example`.

## Commands

```sh
pnpm install
pnpm dev          # api :8787, admin :5173/admin/
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
  TDesign into `miniprogram_npm`, bundles `@rs/shared` into `lib/`, and writes an optional
  `WX_APPID` override into the gitignored `project.private.config.json`. Tab bar icons are
  PNGs in `miniprogram/assets/tab` (TDesign icons, light and dark), wired through `theme.json`. Do not name a class
  `.page`: TDesign's theme file sets tokens on `.page`, which would undo the brand colors.
- Follow WeChat design rules: keep the native navigation bar and capsule area, 44px minimum tap
  targets, main action in a fixed bottom bar, loading, empty and error states on every list,
  support dark mode.

## QA

A feature is done only after it has been driven for real, not just unit tested:
Vitest for rules and API, Playwright for admin (also try odd inputs and check
screenshots in light and dark), and `pnpm --filter @rs/qa-miniprogram smoke` plus feature
scripts in WeChat DevTools on a Mac for the mini program.

## Git

Conventional commits in English, subject line only, no body, no em dashes.
Example: `feat(api): add booking cancellation`. One PR per feature.
