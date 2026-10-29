# Deployment runbook

Production and staging run on one Tencent Cloud Lighthouse server in mainland China.

```
             ┌──────────── Lighthouse server, /srv/rs ────────────┐
 mini program│  caddy :443 ─┬─ app.example.cn     → app          │
 admin       │   (HTTPS)    └─ staging.example.cn → app-staging  │
             │  backup: nightly copy of prod-data → COS bucket    │
             └────────────────────────────────────────────────────┘
```

- `app` is one container per environment: the API, which also serves the admin app at
  `/admin/`. Its database and uploaded images live in a Docker volume (`prod-data`,
  `staging-data`).
- Releases are images tagged with the git commit, built on the server. A release goes to staging
  first and is promoted to production as the same image.
- `backup` copies the production database and images to COS every night at 03:30 venue time and
  before every production deploy. Copies are kept for 30 days.

Files here: `Dockerfile` (targets `app` and `backup`), `compose.yml`, `Caddyfile`, `rs.sh` (runs on
the server), `ship.sh` (runs on your machine), `backup/` (backup and restore scripts), `env/`
(examples of the server's settings files), `test/drill.sh` (backup and restore drill, run in CI).

## First setup

Needs the accounts in the launch checklist: the server, the filed domain, and a COS bucket.

1. Buy a Lighthouse server in a mainland region close to the venue (2 cores, 4 GB is plenty),
   with the **Docker CE** application image. Note its public IP.
2. Point DNS A records for the production and staging names (such as `app.` and `staging.`) at
   the IP. HTTPS only works once the domain's ICP filing is approved: Tencent Cloud blocks
   ports 80 and 443 for unfiled domains.
3. On the server, as root:

   ```sh
   # Docker Hub is not reachable from the mainland; use Tencent Cloud's mirror.
   echo '{"registry-mirrors":["https://mirror.ccs.tencentyun.com"]}' > /etc/docker/daemon.json
   systemctl restart docker
   mkdir -p /srv/rs/releases /srv/rs/secrets/prod /srv/rs/secrets/staging
   ```

4. From your machine, copy the examples and fill them in on the server (see
   [Settings](#settings)):

   ```sh
   scp deploy/env/compose.env.example root@IP:/srv/rs/.env
   scp deploy/env/prod.env.example    root@IP:/srv/rs/prod.env
   scp deploy/env/staging.env.example root@IP:/srv/rs/staging.env
   scp deploy/env/backup.env.example  root@IP:/srv/rs/backup.env
   ssh root@IP 'chmod 600 /srv/rs/*.env'
   ```

5. Put the WeChat Pay key files in `/srv/rs/secrets/prod/` (and `secrets/staging/` once staging
   uses real payments), readable by the app's user:
   `chown -R 1000:1000 /srv/rs/secrets && chmod 600 /srv/rs/secrets/*/*`.
6. Ship the first release and put it in production, as below. The first production deploy
   creates an empty database; sign in to `https://app.example.cn/admin/` and set up the venue.

## On a server that already runs nginx

On a server with its own reverse proxy on 80 and 443, leave Caddy off: set `PROXY=external` in
`/srv/rs/.env`. `rs.sh` then starts only the app containers, which listen on `127.0.0.1` at
`APP_PORT` (production, default 8787) and `STAGING_PORT` (staging, default 8788); pick ports
nothing else uses. `APP_DOMAIN`, `STAGING_DOMAIN` and `ACME_EMAIL` must still be set, as compose
reads them, but only the proxy uses the names. The proxy gets the certificates and forwards to the
port, keeping the client address and the original host and port:

```nginx
server {
    listen 443 ssl;
    server_name staging.example.cn;
    ssl_certificate     /etc/ssl/staging.example.cn/fullchain.pem;
    ssl_certificate_key /etc/ssl/staging.example.cn/key.pem;
    client_max_body_size 12m;   # invoice PDFs are up to 10MB
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
```

## Testing before the ICP filing

Until the domain is filed, the venue can test on staging on a server outside the mainland, or on
a mainland server that is reachable on another port, such as `https://test.example.com:444`, with
a domain that is not the one being filed. Keep `NODE_ENV=staging` and the pay lines empty, so
payments are fake, and set `WECHAT_APP_SECRET`, so sign-in is real (`rs.sh` refuses to start
staging without it). `PUBLIC_BASE_URL` includes the port.

Build the mini program with that address (`API_BASE_URL=https://test.example.com:444`) and upload
it as the 体验版. Add each tester under 成员管理 → 体验成员. A domain without a filing cannot be a
服务器域名, so each tester opens the 体验版, taps ··· → 开发调试 → 打开调试 and reopens it: WeChat
then skips the domain check. A filed domain on a non-standard port can be added as a 服务器域名
with its port instead, and then no tester needs 开发调试.

## Releases

From your machine, with ssh access to the server:

```sh
RS_HOST=root@IP deploy/ship.sh            # ships origin/main to staging
RS_HOST=root@IP deploy/ship.sh my-branch  # or any commit, branch or tag
```

`ship.sh` sends the committed code only (`git archive`), builds both images on the server and
restarts staging. Check staging, then on the server:

```sh
/srv/rs/rs.sh promote     # back up production, then run the staging release there
/srv/rs/rs.sh status      # what runs where
/srv/rs/rs.sh logs app    # follow production logs (app, app-staging, backup, caddy)
```

A deploy restarts the container: the API finishes open requests and closes the database, and
Caddy holds new requests for up to 15 seconds meanwhile, so users see a slow request rather than
an error. Migrations run when the API starts.

**Rolling back.** `rs.sh rollback` swaps production with the previous release (`rs.sh status`
shows both), so running it again swaps back. If the release being undone changed the database
(new files in `apps/api/drizzle/`), the old code may not work on the migrated database. Restore
instead, and start the release that ran before the bad deploy on the copy taken just before it:
`rs.sh restore app-<time>.db.gz <tag>`. In `rs.sh backups`, that copy is the newest one older than
the bad deploy. After any restore, `rollback` has no previous release to offer. Staging still runs the bad
release, so ship a fix to staging before the next `promote`. Bookings and payments made since that
copy are lost, so check the orders in the WeChat Pay merchant platform afterwards.

`compose.yml`, the `Caddyfile` and `rs.sh` in `/srv/rs` follow the production release: they are
replaced when a release goes to production, not when one is shipped to staging, and `ship.sh`
always runs the server's `rs.sh`. A release that changes them is tested on staging with the old
ones.

`rs.sh prune` removes releases and images other than the newest five. The disk fills up slowly
without it; run it every month or so.

## Mini program builds

The mini program is built with the API address baked in, then uploaded from WeChat DevTools:

```sh
API_BASE_URL=https://app.example.cn     pnpm --filter @rs/miniprogram build   # for release
API_BASE_URL=https://staging.example.cn pnpm --filter @rs/miniprogram build   # for testing
```

In the mini program console, under 开发管理 → 开发设置 → 服务器域名, add both domains as
`request`, `uploadFile` and `downloadFile` domains. Upload a
staging build as the 体验版 to test on phones; upload a production build for review.

Optional, for the front desk 签到码: under 开发管理 → 开发设置 → 扫普通链接二维码打开小程序, add
the rule `https://app.example.cn/checkin` → page `pages/checkin/index`. WeChat then opens the
mini program straight from its own scanner. WeChat first asks you to put a check file at the
domain root: set `WECHAT_LINK_CHECK` to its name and content and redeploy. Without the rule,
students scan from 课程 → 扫码签到.

## Settings

`/srv/rs/.env` (compose and `rs.sh`):

| Variable | Meaning |
| --- | --- |
| `APP_DOMAIN`, `STAGING_DOMAIN` | Host names Caddy serves and gets certificates for. |
| `ACME_EMAIL` | Let's Encrypt contact for certificate problems. |
| `PROXY` | `caddy` (default), or `external` when the server already runs a reverse proxy; see [On a server that already runs nginx](#on-a-server-that-already-runs-nginx). |
| `APP_PORT`, `STAGING_PORT` | Local ports the app containers listen on, on `127.0.0.1`. Default 8787 and 8788. |
| `NPM_REGISTRY` | npm mirror for builds, `https://registry.npmmirror.com` in the mainland. |
| `NODE_IMAGE`, `RCLONE_IMAGE` | Optional base image overrides; the Docker mirror usually makes them unnecessary. |
| `APP_TAG`, `APP_PREV_TAG`, `STAGING_TAG` | Written by `rs.sh`. Do not edit. |

`/srv/rs/prod.env` and `/srv/rs/staging.env` (the app):

| Variable | Meaning |
| --- | --- |
| `ADMIN_PASSWORD` | Password of the first admin login, `admin`, created when the database has no staff yet. Use a long random one. After that, staff logins are managed on the admin 员工 page and changing this variable has no effect; the image still refuses to start without it. |
| `WECHAT_APPID` | Mini program AppID (`wxb8dc89b45d422bf1`). |
| `WECHAT_LINK_CHECK` | Optional. The check file for 扫普通链接二维码打开小程序, as `name.txt=content`; served at the domain root. |
| `TENCENT_MAP_KEY` | Optional. A 腾讯位置服务 key (lbs.qq.com → 控制台 → 应用管理 → 我的应用 → 创建应用 → 添加 key, product WebServiceAPI and 地图组件, with the admin's domain under 域名白名单). It shows 在地图上选点 and a map preview under 设置 → 地图坐标. Without it admins paste a map share link or coordinates. |
| `WECHAT_APP_SECRET` | AppSecret from 开发管理 → 开发设置. Enables real WeChat sign-in and subscription messages. Required on staging too: without it the API uses a development login that trusts any caller. |
| `PUBLIC_BASE_URL` | `https://` address of this environment. WeChat Pay sends payment and refund results to it. |
| `WECHAT_PAY_MCHID` | Merchant ID (商户号). |
| `WECHAT_PAY_API_V3_KEY` | APIv3 key, set in the merchant platform under 账户中心 → API安全. |
| `WECHAT_PAY_MERCHANT_SERIAL` | Serial number of the merchant API certificate (商户API证书序列号). |
| `WECHAT_PAY_MERCHANT_PRIVATE_KEY` | `apiclient_key.pem` from the certificate download: a path such as `/secrets/apiclient_key.pem`, or the PEM itself with `\n` for line breaks. |
| `WECHAT_PAY_PUBLIC_KEY` | WeChat Pay public key (微信支付公钥), path or PEM. |
| `WECHAT_PAY_PUBLIC_KEY_ID` | Its ID, starting with `PUB_KEY_ID_`. |
| `ALERT_WEBHOOK` | Production only, optional: the same WeCom group robot webhook as in `backup.env`. The app then checks every hour that a backup succeeded in the last 36 hours and tells the group once a day while none has (see [Backups and restore](#backups-and-restore)). Leave it out of `staging.env`, which is not backed up. |
| `WECHAT_MINIPROGRAM_STATE` | Which build a tapped message opens: `formal` (production), `trial` (staging), `developer`. |
| `NODE_ENV` | Set by the image to `production`, which requires WeChat sign-in and WeChat Pay to be configured. Staging uses `staging` until the merchant account exists; it then uses a fake payment gateway, where a signed-in user can mark their own staging orders paid. |
| `WECHAT_NOTICE_COACH_BOOKED`, `WECHAT_NOTICE_COACH_CANCELLED`, `WECHAT_NOTICE_COACH_MOVED` | Coach subscription messages: new, cancelled and moved (改约) lessons. A lesson moved to another coach reaches the old coach as cancelled and the new one as new. Each template is the template ID from 订阅消息 (pick one-time templates, 一次性订阅消息), then each field and what goes in it, such as `AbC123 thing1=student time2=time thing3=lesson`. A template left empty is not sent. |
| `WECHAT_NOTICE_STUDENT_BOOKED`, `WECHAT_NOTICE_STUDENT_CANCELLED`, `WECHAT_NOTICE_STUDENT_REMINDER` | Student messages: 预约成功, 课程取消 (by the coach or the venue) and 上课提醒 (2 hours before). |
| `WECHAT_NOTICE_STUDENT_MOVED`, `WECHAT_NOTICE_STUDENT_FEEDBACK` | Student messages for 改约 (sent whoever moved the lesson) and 课后点评 (sent once, when the coach first writes it). The booking button asks for 上课提醒, then 课程取消, 改约 and 课后点评, then 预约成功, three templates at most, so set one 课程变动 template as both CANCELLED and MOVED (see `status` below) to fit 课后点评 in. Kinds with no template are not asked for. |
| `WECHAT_NOTICE_STUDENT_PACKAGE` | Student message about a package running out (a template such as 课时包到期提醒): 7 days before it expires with lessons left (`status` `即将到期`), and once its last lesson is booked (`课时已约完`, not sent when the student has another package for the same lesson type). Asked for on the package buy button, and on the booking button after the kinds above when paying with a package, if there is room. A package that lasts 7 days or less is not reminded of. Example: `XyZ789 thing1=package number2=left date3=expiry thing4=note`. |

Template values: `student`, `lesson`, `time`, `oldTime` (moved lesson, student and coach), `status` (`已取消` or `已改约`, so one 课程变动 template with a status field can serve as both `WECHAT_NOTICE_STUDENT_CANCELLED` and `WECHAT_NOTICE_STUDENT_MOVED`; set the same template ID in both, each with its own field mapping, and the booking prompt asks for it once), `coach`, `place` (venue name), `reason` (cancelled), `refund` (cancelled, such as `¥200 原路退回` or `课时已退回课时包`), `note` (feedback, or a line on the package for the package message), `package` (package name), `left` (lessons left, such as `3节`; a `number` field gets `3`), `expiry` (last day it can be used, such as `2026年11月22日`). Without `WECHAT_APP_SECRET` (development), the API logs each message instead of sending it.

The image sets `PORT`, `DATABASE_PATH`, `UPLOADS_DIR`, `ADMIN_DIR` and `HELP_DIR` (the 使用手册 at `/help/`); leave them alone. All the
WeChat Pay variables go together: setting some but not all stops the API at start.

`/srv/rs/backup.env`:

| Variable | Meaning |
| --- | --- |
| `COS_BUCKET` | Bucket name with its APPID suffix, such as `rs-backup-1250000000`. |
| `RCLONE_CONFIG_COS_ENDPOINT` | `cos.<region>.myqcloud.com`, the bucket's region. |
| `RCLONE_CONFIG_COS_ACCESS_KEY_ID`, `..._SECRET_ACCESS_KEY` | SecretId and SecretKey of a CAM sub-user allowed only on this bucket. |
| `BACKUP_AT` | Nightly run time, venue time, default `03:30`. |
| `BACKUP_KEEP_DAYS` | Days to keep database copies and removed images, default 30. The privacy policy tells students erased data stays in backups about 30 days: raising it needs the policy (`packages/shared/src/policies.ts`) changed too. |
| `BACKUP_ALLOW_REMOVALS` | Leave unset. `rs.sh backup --allow-removals` sets it for one run, to mirror more than 300 removed images. |
| `ALERT_WEBHOOK` | Optional WeCom group robot webhook that is told when a backup fails. Set the same one in `prod.env` to also hear when backups stop running. |
| `RCLONE_CONFIG_COS_SERVER_SIDE_ENCRYPTION` | Optional, `AES256`: COS stores each new copy encrypted at rest (SSE-COS). Turning on 默认加密 (SSE-COS) for the bucket in the COS console does the same for every upload and is the simpler choice; either way, anyone with the bucket keys still reads the copies. |
| `BACKUP_CRYPT_PASSWORD` | Optional, recommended: encrypts the database copies and images with this key before they leave the server (rclone crypt), so the bucket keys alone cannot read them. Off when empty. See [Encrypted backups](#encrypted-backups): without the key, no copy can be restored. |

After changing a settings file, apply it with `docker compose -f compose.yml up -d <service>` in
`/srv/rs` (`app`, `app-staging` or `backup`).

## Backups and restore

```sh
/srv/rs/rs.sh backup            # back up production now
/srv/rs/rs.sh backups           # list the copies in COS
/srv/rs/rs.sh verify            # check the newest copy without restoring it
/srv/rs/rs.sh restore latest    # or a name from the list
```

A backup is an online SQLite copy (safe while the app writes), checked with `integrity_check`,
gzipped and stored as `db/app-<UTC time>.db.gz`. Uploaded images are mirrored to `uploads/`; an
image deleted on the server (a lesson photo removed by its coach or with a deleted account) moves to
`uploads-removed/<UTC date>/` and is purged after `BACKUP_KEEP_DAYS`, like the database backups.
More than 300 images gone since the last backup stops it with an alert instead, as that usually
means images were lost from the volume: copy them back with `rs.sh restore-images`. If they were
removed on purpose, such as with a deleted account that had many lesson photos, run
`rs.sh backup --allow-removals` once.
Until then a lesson photo can come back: a restore copies back lesson photos removed since its
copy was taken, as that database may still show them, and `rs.sh restore-images <YYYYMMDD>` does
the same since that day. Lesson photos nothing uses are cleared again within a day. Other removed
files, such as the invoice PDFs of deleted accounts, are not brought back.

`restore` stops production and the backup schedule, downloads and checks the copy, keeps the
current database (with its WAL files) next to it as `app.db.before-restore-<time>` in the volume,
puts the copy in place, copies back any missing images and starts both again. Everything written
after the copy was taken is lost. If the image copy fails, the database is still restored; run the
`rs.sh restore-images <day>` it prints to finish it. If a restore fails before the swap, production starts again
on the database it had. If it fails in the middle of the swap (it says so), production stays
stopped: look at `/data` and rerun the restore with the commands the message prints. The replaced
database and its WAL files are kept either way.

**Deleted accounts come back with a restore.** A student who deleted their account (注销), or a
front-desk student staff removed, after the copy was taken is back in the restored database with
their name and phone, and their lesson photos are copied back with it. The deletion has to be done
again; nothing does it for you. After every restore:

1. Find them. The replaced database is kept as `app.db.before-restore-<time>`; students deleted in it
   but not in the restored one are the ones to delete again. `<tag>` is the release production runs,
   as `rs.sh restore` printed:

   ```sh
   cd /srv/rs && APP_TAG=<tag> docker compose -f compose.yml run --rm --no-deps backup node -e '
     const D = require("better-sqlite3"), [o, n] = process.argv.slice(1).map((f) => new D(f, { readonly: true }))
     const q = "select id, created_at as c, deleted_at as d from students where deleted_at is "
     const live = new Map(n.prepare(q + "null").all().map((r) => [r.id, r.c]))
     // Same id and creation time: the same person, not a student created after the copy.
     for (const r of o.prepare(q + "not null").all())
       if (live.get(r.id) === r.c) console.log(r.id, "deleted", new Date(r.d).toISOString())
   ' /data/app.db.before-restore-<time> /data/app.db
   ```

   If that file is lost or unreadable, the app logs each deletion as `account erased {studentId}`:
   `docker compose -f compose.yml logs app | grep 'account erased'` (the logs keep about 100MB). Check
   that each of those ids was created before the copy was taken: ids given out after it can be given
   out again to someone else.
2. Delete them again: ask the developer to run the account deletion for those ids. Then run
   `rs.sh backup --allow-removals`, so the backup does not count their photos as lost.

**Before every production deploy** (`prod`, `promote`, `rollback`) `rs.sh` backs up the database
in a one-off backup container, also when the app is down or restarting, and stops the deploy if
that backup fails. Only a server with no database yet skips it. For an urgent fix while COS cannot
be reached, `RS_DEPLOY_WITHOUT_BACKUP=1 /srv/rs/rs.sh promote` deploys without it; take a copy
with `rs.sh backup` as soon as COS works again.

**When backups stop.** A failed backup alerts by itself. A backup that never runs (the backup
container stopped, or a run that hangs) cannot, so each successful backup touches `backup-ok`
next to the database, and with `ALERT_WEBHOOK` in `prod.env` the app checks it every hour: older
than 36 hours, it logs `backup stale` and tells the group, once a day until a backup succeeds.
Before the first backup it counts from the app's start. 36 hours leaves room for a run that
takes hours longer than usual, such as the first encrypted one. A backup that uploads but cannot
touch `backup-ok` alerts at once, so an app restart cannot hide it.

### Encrypted backups

By default copies sit in the bucket as plain gzip files, readable by anyone who gets the bucket's
keys. Two optional layers, which can be used together:

- **At rest in COS**: turn on 默认加密 (SSE-COS) for the bucket in the COS console, or set
  `RCLONE_CONFIG_COS_SERVER_SIDE_ENCRYPTION=AES256` in `backup.env`. COS decrypts on download,
  so nothing else changes, and it protects against lost disks at Tencent Cloud, not leaked keys.
- **Before upload (recommended)**: set `BACKUP_CRYPT_PASSWORD` to a long random key, such as the
  output of `openssl rand -base64 32`, then in `/srv/rs` run
  `docker compose -f compose.yml up -d backup` (the running container keeps its old settings
  until it is recreated), `rs.sh backup` and `rs.sh verify`. Copies then go
  to `crypt/db/` and `crypt/uploads/` in the bucket, encrypted with rclone crypt; file names stay
  readable. **Keep the key outside the server and outside COS**, such as in the venue's password
  manager: a new server after losing the old one needs it to restore anything. `backups`,
  `verify`, `restore` and `restore-images` read the encrypted copies while the key is set.

Turning on `BACKUP_CRYPT_PASSWORD` starts a new set under `crypt/`: the first run uploads all
images again, and the earlier plain copies in `db/`, `uploads/` and `uploads-removed/` are no
longer listed or pruned. To reach those, put `RS_BACKUP_PLAIN=1` in front of `backups`,
`verify`, `restore` or `restore-images`, such as
`RS_BACKUP_PLAIN=1 /srv/rs/rs.sh restore app-<time>.db.gz`; `restore` still stops and restarts
production and the backup schedule as usual. Once the encrypted copies cover `BACKUP_KEEP_DAYS`,
delete the plain folders in the COS console. Do not change the key afterwards: images already in
`crypt/uploads/` are not uploaded again, so they would stay readable only with the old key. If the
key leaked, delete `crypt/` in the COS console, set the new key and run `rs.sh backup` and
`rs.sh verify` straight away; the earlier encrypted copies are gone with it.

Releases from before encrypted backups ignore `BACKUP_CRYPT_PASSWORD`: they would back up
unencrypted, never touch `backup-ok` and read only the old plain copies. While the key is set,
`rs.sh` refuses to deploy, roll back to or restore onto such a release, and to run `backups`,
`verify` or `restore-images` with it unless `RS_BACKUP_PLAIN=1`. To go back to one anyway, empty
`BACKUP_CRYPT_PASSWORD` first: backups are then plain again.

**Moving to a new server**, or after losing the old one: do the first setup, ship a release, then
`rs.sh restore latest <tag>` with the tag `ship.sh` printed. That restores the newest copy and
starts production on it.

**Check the backups** once a month: `rs.sh backups` should list one copy per night, and
`rs.sh verify` downloads the newest one, checks it and prints how many students, bookings and
orders it holds and when the newest booking was made. It does not touch the live database.

`deploy/test/drill.sh` runs the same backup and restore against a stand-in for COS on every pull
request.

## When something is wrong

- **Site down**: `rs.sh status`. A container that keeps restarting shows why in `rs.sh logs app`.
  A missing or incomplete setting is reported on the first lines.
- **Certificate errors**: `rs.sh logs caddy`. Usually DNS not pointing at the server, or ports
  80 and 443 closed in the Lighthouse firewall.
- **Payments stuck as unpaid**: WeChat Pay cannot reach `PUBLIC_BASE_URL`. When an order's hold
  runs out, the API asks WeChat Pay before closing it, so a payment whose notice was lost is
  still recorded then.
- **Backup failed**: `rs.sh logs backup`, then `rs.sh backup` to retry. Most failures are a
  wrong COS key or bucket name.
- **No successful backup for 36 hours**: `rs.sh status` shows whether the `backup` container
  runs; start it with `docker compose -f compose.yml up -d backup` in `/srv/rs`. Then
  `rs.sh logs backup` for the last run, and `rs.sh backup` to make a copy now.
- **Disk full**: `df -h`, then `rs.sh prune` and `docker system prune`.
