# reservation-system

Booking system for private table tennis lessons at one venue.

- `apps/miniprogram`: WeChat mini program for students
- `apps/coach`: web app for coaches (phone first)
- `apps/admin`: web app for the venue admin
- `apps/api`: HTTP API and database
- `packages/shared`: schemas and booking rules shared by all apps
- `packages/theme`: brand tokens for TDesign
- `qa/`: Playwright and mini program automation

## Development

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm dev
```

See `CLAUDE.md` for commands and conventions.
