# Mini program QA

Drives WeChat DevTools with `miniprogram-automator`. DevTools only runs on macOS and Windows,
so these scripts run on a developer machine, not in CI.

Setup once: install WeChat DevTools, sign in, and turn on 设置 → 安全设置 → 服务端口.

```sh
pnpm --filter @rs/qa-miniprogram smoke
```

To use a different AppID (for example a sandbox test AppID), set `WX_APPID`; the build writes it to
the gitignored `project.private.config.json`.

Screenshots are written to `qa/miniprogram/screenshots/`. Set `WECHAT_DEVTOOLS_CLI` if DevTools
is not installed in the default location.

## Student flows

Books, pays (through the fake gateway's 模拟支付 dialog), cancels, buys a package and loses a slot
race against a second student, checking each screen and saving screenshots to
`qa/miniprogram/screenshots/flows/`. It needs a local API with demo data and no WeChat Pay
credentials:

```sh
DATABASE_PATH=data/qa.db pnpm --filter @rs/api db:seed   # once, on an empty database
DATABASE_PATH=data/qa.db pnpm --filter @rs/api dev       # leave running
pnpm --filter @rs/qa-miniprogram flows
```

The mini program calls `API_BASE_URL` (default `http://localhost:8787`), baked in by the build.

## Coach flows

Binds a coach with a code from the admin API, marks attendance, writes a note, cancels a lesson,
and sets weekly hours and a day off, saving screenshots to `qa/miniprogram/screenshots/coach/`.
It uses the same seeded API as the student flows, and `QA_DB` must point at that API's database
file, because attendance needs a lesson that has started and the script moves one into the past:

```sh
QA_DB=../../apps/api/data/qa.db pnpm --filter @rs/qa-miniprogram coach
```

It unbinds the first seeded coach before it starts and after it ends.

## Coach pages

Checks the coach list on the home page, a coach's page (category, tags, prices, rich text
profile), booking from it and the link back from the booking page, saving screenshots to
`qa/miniprogram/screenshots/coach-profile/`. It uses the same seeded API as the student flows.
Run it once with DevTools in light mode and once in dark mode:

```sh
pnpm --filter @rs/qa-miniprogram coach-profile
```
