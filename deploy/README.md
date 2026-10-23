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

**Rolling back.** `rs.sh rollback` runs the previous production release again. If the release
being undone changed the database (new files in `apps/api/drizzle/`), the old code may not work
on the migrated database: pass the copy taken just before the deploy,
`rs.sh rollback app-<time>.db.gz` (find it with `rs.sh backups`). That restores it and starts the
previous release on it, so the newer release never touches it again. Bookings and payments made
since that copy are lost, so check the orders in the WeChat Pay merchant platform afterwards.

`compose.yml`, the `Caddyfile` and `rs.sh` in `/srv/rs` follow the production release: they are
replaced when a release goes to production, not when one is shipped to staging. A release that
changes them is tested on staging with the old ones.

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

## Settings

`/srv/rs/.env` (compose and `rs.sh`):

| Variable | Meaning |
| --- | --- |
| `APP_DOMAIN`, `STAGING_DOMAIN` | Host names Caddy serves and gets certificates for. |
| `ACME_EMAIL` | Let's Encrypt contact for certificate problems. |
| `NPM_REGISTRY` | npm mirror for builds, `https://registry.npmmirror.com` in the mainland. |
| `NODE_IMAGE`, `RCLONE_IMAGE` | Optional base image overrides; the Docker mirror usually makes them unnecessary. |
| `APP_TAG`, `APP_PREV_TAG`, `STAGING_TAG` | Written by `rs.sh`. Do not edit. |

`/srv/rs/prod.env` and `/srv/rs/staging.env` (the app):

| Variable | Meaning |
| --- | --- |
| `ADMIN_PASSWORD` | Admin sign-in password. Required; use a long random one. |
| `WECHAT_APPID` | Mini program AppID (`wxb8dc89b45d422bf1`). |
| `WECHAT_APP_SECRET` | AppSecret from 开发管理 → 开发设置. Enables real WeChat sign-in and subscription messages. Required on staging too: without it the API uses a development login that trusts any caller. |
| `PUBLIC_BASE_URL` | `https://` address of this environment. WeChat Pay sends payment and refund results to it. |
| `WECHAT_PAY_MCHID` | Merchant ID (商户号). |
| `WECHAT_PAY_API_V3_KEY` | APIv3 key, set in the merchant platform under 账户中心 → API安全. |
| `WECHAT_PAY_MERCHANT_SERIAL` | Serial number of the merchant API certificate (商户API证书序列号). |
| `WECHAT_PAY_MERCHANT_PRIVATE_KEY` | `apiclient_key.pem` from the certificate download: a path such as `/secrets/apiclient_key.pem`, or the PEM itself with `\n` for line breaks. |
| `WECHAT_PAY_PUBLIC_KEY` | WeChat Pay public key (微信支付公钥), path or PEM. |
| `WECHAT_PAY_PUBLIC_KEY_ID` | Its ID, starting with `PUB_KEY_ID_`. |
| `WECHAT_MINIPROGRAM_STATE` | Which build a tapped message opens: `formal` (production), `trial` (staging), `developer`. |
| `WECHAT_NOTICE_COACH_BOOKED`, `WECHAT_NOTICE_COACH_CANCELLED` | Subscription message templates: the template ID from 订阅消息, then each field and what goes in it, such as `AbC123 thing1=student time2=time thing3=lesson`. Values: `student`, `lesson`, `time`, `coach`, `reason`. A template left empty is not sent. |
| `NODE_ENV` | Set by the image to `production`, which requires WeChat sign-in and WeChat Pay to be configured. Staging uses `staging` until the merchant account exists; it then uses a fake payment gateway, where a signed-in user can mark their own staging orders paid. |

The image sets `PORT`, `DATABASE_PATH`, `UPLOADS_DIR` and `ADMIN_DIR`; leave them alone. All the
WeChat Pay variables go together: setting some but not all stops the API at start.

`/srv/rs/backup.env`:

| Variable | Meaning |
| --- | --- |
| `COS_BUCKET` | Bucket name with its APPID suffix, such as `rs-backup-1250000000`. |
| `RCLONE_CONFIG_COS_ENDPOINT` | `cos.<region>.myqcloud.com`, the bucket's region. |
| `RCLONE_CONFIG_COS_ACCESS_KEY_ID`, `..._SECRET_ACCESS_KEY` | SecretId and SecretKey of a CAM sub-user allowed only on this bucket. |
| `BACKUP_AT` | Nightly run time, venue time, default `03:30`. |
| `BACKUP_KEEP_DAYS` | Days to keep database copies, default 30. Images are kept for good. |
| `ALERT_WEBHOOK` | Optional WeCom group robot webhook that is told when a backup fails. |

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
gzipped and stored as `db/app-<UTC time>.db.gz`. Uploaded images are copied to `uploads/`.

`restore` stops production, downloads and checks the copy, keeps the current database next to it
as `app.db.before-restore-<time>` in the volume, puts the copy in place, copies back any missing
images and starts production again. Everything written after the copy was taken is lost.

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
- **Disk full**: `df -h`, then `rs.sh prune` and `docker system prune`.
