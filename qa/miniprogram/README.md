# Mini program QA

Drives WeChat DevTools with `miniprogram-automator`. DevTools only runs on macOS and Windows,
so these scripts run on a developer machine, not in CI.

Setup once: install WeChat DevTools, sign in, and turn on 设置 → 安全设置 → 服务端口.

```sh
pnpm --filter @rs/qa-miniprogram smoke
```

To use a different AppID (for example a sandbox test AppID), set `WX_APPID`; the build writes it to
the gitignored `project.private.config.json`.

Screenshots are written to `qa/miniprogram/screenshots/`; the smoke run opens each tab and the 外观
page following the system, then forced light and dark, saving them under `system/`, `light/` and
`dark/`. Set `WECHAT_DEVTOOLS_CLI` if DevTools
is not installed in the default location.

Each script launches its own DevTools window by default. To reuse one simulator across runs, open
an automation instance once (`cli auto --project <path to apps/miniprogram> --auto-port 9420`) and
set `QA_WS_ENDPOINT=ws://127.0.0.1:9420`. The scripts then recompile it in place (which also resets the
simulator's file storage limit), attach to it, clear its storage, relaunch the first page and leave
it open when they finish.

## Student flows

Books, pays (through the fake gateway's 模拟支付 dialog), cancels, buys a package and loses a time
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
and sets weekly hours, a 请假 and a 加班, saving screenshots to `qa/miniprogram/screenshots/coach/`.
It uses the same seeded API as the student flows, and `QA_DB` must point at that API's database
file, because attendance needs a lesson that has started and the script moves one into the past:

```sh
QA_DB=../../apps/api/data/qa.db pnpm --filter @rs/qa-miniprogram coach
```

It unbinds the first seeded coach before it starts and after it ends.

## Coach pages

Checks the coach list on the home page, a coach's page (category, tags, prices, rich text
profile), booking from it, the links to it from the booking page (also the coach list shown
before a coach is picked) and the confirm page, and double taps on those links, saving screenshots to
`qa/miniprogram/screenshots/coach-profile/`. It uses the same seeded API as the student flows.
Run it once with DevTools in light mode and once in dark mode:

```sh
pnpm --filter @rs/qa-miniprogram coach-profile
```

## Student profiles

Checks 学员档案 on the coach lesson page: empty, filled in by the coach on the 学员档案 page (double
tap on 保存), filled in by the venue (through the admin API), a coach save refused because the venue
changed it meanwhile, the student's 课后点评 from every coach, the longest profile the admin allows,
lesson and no-show counts, and that the student's own lesson page carries none of it, saving screenshots to `qa/miniprogram/screenshots/student-profile/`. It
uses the same seeded API, and `QA_DB` as for the coach flows:

```sh
QA_DB=../../apps/api/data/qa.db pnpm --filter @rs/qa-miniprogram student-profile
```

## Front-desk students

Checks 同步前台记录: the desk adds a student and sells them a package through the admin API, a new
WeChat user opens 我的 and the link page, tries a wrong code, opens the page as the desk's 小程序码
would (`?scene=`), double taps 同步, and lands on 我的 with the desk's name, 学员编号 and lessons.
Screenshots go to `qa/miniprogram/screenshots/desk-link/`. It needs the seeded API:

```sh
pnpm --filter @rs/qa-miniprogram desk-link
```

## Forcing a theme

The 外观 setting under 我的 is stored in the `rs:theme` storage key: `light`, `dark`, or absent to
follow the system. Any script can force a theme without touching the DevTools or system setting:

```ts
await miniProgram.callWxMethod('setStorageSync', 'rs:theme', 'dark')
await miniProgram.reLaunch('/pages/booking/index')
// ...
await miniProgram.callWxMethod('removeStorageSync', 'rs:theme') // back to following the system
```

Following the system is the default, so a release still needs one run with DevTools itself in dark
mode and the key removed. Native dialogs such as `wx.showModal` always follow the system theme.

## Invoices

Requests an invoice from the 发票 page (a wrong tax number, then a double tap on submit), sees it
rejected with the reason and asks again with the saved title, then sees it issued on the list and
the package page and opens the PDF, saving screenshots to `qa/miniprogram/screenshots/invoices/`.
It uses the same seeded API as the student flows and signs in to the admin API with
`ADMIN_PASSWORD` (default `admin`). Run it once in light and once in dark mode:

```sh
pnpm --filter @rs/qa-miniprogram invoices
QA_THEME=dark pnpm --filter @rs/qa-miniprogram invoices   # forces the 外观 setting instead
```

## Lesson moves

A student moves a paid lesson (with a double tap on 确认改约), sees a time they cannot take
refused and runs out of moves, then the coach moves the lesson in coach mode, saving screenshots
to `qa/miniprogram/screenshots/moves/`. It uses the same seeded API as the student flows and
signs in to the admin API with `ADMIN_PASSWORD`. Run it once in light and once in dark mode:

```sh
pnpm --filter @rs/qa-miniprogram moves
QA_THEME=dark pnpm --filter @rs/qa-miniprogram moves   # forces the 外观 setting instead
```

## Lesson feedback

The student's empty 学习记录, a coach writing 课后点评 with photos (double taps on add, save and
delete), the student seeing it on the lesson and in 学习记录, and the coach deleting it after the
venue hid it, saving screenshots to `qa/miniprogram/screenshots/feedback/`. `QA_DB` must point
at the API's database file, because feedback needs a lesson that has ended:

```sh
QA_DB=../../apps/api/data/qa.db pnpm --filter @rs/qa-miniprogram feedback
QA_DB=../../apps/api/data/qa.db QA_THEME=dark pnpm --filter @rs/qa-miniprogram feedback
```
