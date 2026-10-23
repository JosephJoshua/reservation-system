# reservation-system

Booking system for private table tennis lessons at one venue.

- `apps/miniprogram`: WeChat mini program for students, with a coach mode for coaches
- `apps/admin`: web app for the venue admin
- `apps/api`: HTTP API and database
- `packages/shared`: schemas and booking rules shared by all apps
- `packages/theme`: brand tokens for TDesign
- `qa/`: Playwright and mini program automation
- `deploy/`: server setup, releases, backups; see `deploy/README.md`

## Development

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm dev
```

See `CLAUDE.md` for commands and conventions.

## Subscription messages

Pick one-time templates (一次性订阅消息) in the mini program console under 订阅消息, then give each
one to the API as the template ID followed by each of its fields and the value it shows, for
example `WECHAT_NOTICE_STUDENT_REMINDER="AbC123 thing1=lesson time2=time thing3=coach thing4=place"`.

| Variable | Sent to | When |
| --- | --- | --- |
| `WECHAT_NOTICE_COACH_BOOKED` | coach | a lesson is booked and paid |
| `WECHAT_NOTICE_COACH_CANCELLED` | coach | a booked lesson is cancelled |
| `WECHAT_NOTICE_STUDENT_BOOKED` | student | 预约成功 |
| `WECHAT_NOTICE_STUDENT_CANCELLED` | student | 课程取消, by the coach or the venue |
| `WECHAT_NOTICE_STUDENT_REMINDER` | student | 上课提醒, 2 hours before the lesson |
| `WECHAT_NOTICE_STUDENT_MOVED` | student | 课程变更, the lesson moved to another time |
| `WECHAT_NOTICE_STUDENT_FEEDBACK` | student | the coach wrote 课后点评 |

Values: `student`, `lesson`, `time`, `oldTime` (moved), `coach`, `place` (venue name),
`reason` (cancelled), `refund` (cancelled, such as `¥200 原路退回`), `note` (feedback).
`WECHAT_MINIPROGRAM_STATE` (`developer`, `trial` or `formal`) picks the build a message opens.
Students are asked for 预约成功, 课程取消 and 上课提醒 when they tap the booking button. Without
WeChat credentials (development), the API logs each message instead of sending it.
