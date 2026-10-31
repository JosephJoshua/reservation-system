#!/bin/sh
# Backup and restore drill: builds the images, runs the app on a scratch volume, backs it up to a
# local S3 server standing in for COS, then restores onto the same volume and onto an empty one.
# Run from the repo root: deploy/test/drill.sh. Extra docker build flags go in DRILL_BUILD_ARGS.
set -eu
p=rs-drill
port=18787
key=drillkey secret=drillsecret password=drill-password

cleanup() {
  docker rm -f $p-app $p-s3 >/dev/null 2>&1 || true
  docker volume rm $p-data $p-fresh $p-crypt >/dev/null 2>&1 || true
  docker network rm $p >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT
step() { echo "== $*"; }
die() { echo "FAIL: $*" >&2; exit 1; }

step build
for target in app backup; do
  # shellcheck disable=SC2086
  docker build -q -f deploy/Dockerfile --target $target -t rs-$target:drill ${DRILL_BUILD_ARGS:-} . >/dev/null
done

docker network create $p >/dev/null
docker volume create $p-data >/dev/null
docker volume create $p-fresh >/dev/null

step "fake COS (rclone serve s3)"
# COS addresses buckets by host name, as bucket.<endpoint>.
docker run -d --name $p-s3 --network $p --network-alias bucket.$p-s3 --entrypoint sh rs-backup:drill \
  -c "mkdir -p /tmp/s3/bucket && exec rclone serve s3 /tmp/s3 --addr :9000 \
    --auth-key $key,$secret --force-path-style=false" >/dev/null

backup() {
  volume=$1
  shift
  docker run --rm --network $p -v "$volume:/data" \
    -e COS_BUCKET=bucket \
    -e RCLONE_CONFIG_COS_TYPE=s3 -e RCLONE_CONFIG_COS_PROVIDER=TencentCOS \
    -e RCLONE_CONFIG_COS_ENDPOINT=http://$p-s3:9000 \
    -e RCLONE_CONFIG_COS_ACCESS_KEY_ID=$key -e RCLONE_CONFIG_COS_SECRET_ACCESS_KEY=$secret \
    -e BACKUP_KEEP_DAYS=30 -e "BACKUP_AT=${BACKUP_AT:-03:30}" \
    ${crypt:+-e "BACKUP_CRYPT_PASSWORD=$crypt"} ${sse:+-e "RCLONE_CONFIG_COS_SERVER_SIDE_ENCRYPTION=$sse"} \
    ${plainread:+-e BACKUP_PLAIN=1} \
    rs-backup:drill "$@"
}
run_backup() { backup $p-data /app/api/backup/backup.sh; }

start_app() {
  docker run -d --name $p-app --network $p -p 127.0.0.1:$port:8787 -v "$1:/data" \
    -e NODE_ENV=staging -e ADMIN_PASSWORD=$password rs-app:drill >/dev/null
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' $p-app)" = healthy ] && return 0
    sleep 1
  done
  docker logs $p-app
  die "app did not become healthy"
}
stop_app() { docker rm -f $p-app >/dev/null; }
status_of() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$1"; }
api() { curl -sf -H "Authorization: Bearer $token" "$@"; }
login() {
  token=$(curl -sf -X POST http://127.0.0.1:$port/api/admin/login \
    -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$password\"}" | jq -r .token)
}
add_coach() {
  api -X POST http://127.0.0.1:$port/api/admin/coaches -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\"}" >/dev/null
}
coach_names() { api http://127.0.0.1:$port/api/admin/coaches | jq -r '.[].name' | sort | tr '\n' ' '; }

step "app with data"
start_app $p-data
login
add_coach 甲
add_coach 乙
printf '\211PNG\r\n\032\n' >"${TMPDIR:-/tmp}/drill.png"
image=$(api -F "file=@${TMPDIR:-/tmp}/drill.png;type=image/png" http://127.0.0.1:$port/api/admin/uploads | jq -r .url)
curl -sf -o /dev/null "http://127.0.0.1:$port$image" || die "uploaded image not served"

step "admin app is served"
[ "$(status_of /admin/)" = 200 ] || die "/admin/ not served"
[ "$(status_of /admin/some/page)" = 200 ] || die "admin page paths do not get the app"
[ "$(status_of /admin/assets/gone-1234.js)" = 404 ] || die "a missing bundle is not a 404"

step "user manual is served"
[ "$(status_of /help/)" = 200 ] || die "/help/ not served"
[ "$(status_of /help/admin/settings.html)" = 200 ] || die "manual pages not served"
[ "$(status_of /help/gone.html)" = 404 ] || die "a missing manual page is not a 404"

step "backup while the app runs"
backup $p-data rm -f /data/backup-ok
run_backup
backup $p-data /app/api/backup/restore.sh list | grep -q 'app-.*\.db\.gz' || die "no backup listed"
backup $p-data test -f /data/backup-ok || die "a backup did not leave its marker for the app"

step "check the backup without touching the database"
summary=$(backup $p-data /app/api/backup/restore.sh check latest)
echo "$summary" | grep -q '^coaches: 2$' || die "check said: $summary"

step "change data after the backup"
add_coach 丙
[ "$(coach_names)" = "丙 乙 甲 " ] || die "unexpected coaches before restore: $(coach_names)"

step "restore onto the same volume, after a crash that left a WAL"
docker kill $p-app >/dev/null
backup $p-data test -f /data/app.db-wal || die "expected a WAL after a crash"
stop_app
backup $p-data /app/api/backup/restore.sh restore latest
backup $p-data sh -c 'ls /data/app.db.before-restore-*-wal' >/dev/null || die "old database or its WAL not kept"
start_app $p-data
login
[ "$(coach_names)" = "乙 甲 " ] || die "restore gave coaches: $(coach_names)"
curl -sf -o /dev/null "http://127.0.0.1:$port$image" || die "image missing after restore"

step "a stop closes the database cleanly"
started=$(date +%s)
docker stop $p-app >/dev/null
[ $(($(date +%s) - started)) -lt 5 ] || die "stopping the app took the full timeout"
if backup $p-data test -f /data/app.db-wal; then die "the WAL was left behind after a stop"; fi
stop_app

step "restore onto an empty volume, as on a new server"
backup $p-fresh /app/api/backup/restore.sh restore latest
start_app $p-fresh
login
[ "$(coach_names)" = "乙 甲 " ] || die "fresh restore gave coaches: $(coach_names)"
curl -sf -o /dev/null "http://127.0.0.1:$port$image" || die "image missing on the new volume"
stop_app

step "encrypted backups: server-side and with a key of our own"
crypt=drill-crypt-key sse=AES256
out=$(backup $p-data sh -c '. /app/api/backup/common.sh && use_remote && rclone copyto /etc/hostname "$REMOTE/sse-probe" -vv --dump headers 2>&1')
echo "$out" | grep -qi 'X-Amz-Server-Side-Encryption: AES256' || die "server-side encryption was not asked for"
run_backup
crypt='' sse=''
# What lands in COS is rclone crypt, not gzip, and not readable without the key.
raw=$(backup $p-data sh -c '. /app/api/backup/common.sh && rclone lsf "$REMOTE/crypt/db" | tail -n 1')
case $raw in app-*.db.gz.bin) ;; *) die "no encrypted copy under crypt/db: $raw" ;; esac
magic=$(backup $p-data sh -c ". /app/api/backup/common.sh && rclone cat \"\$REMOTE/crypt/db/$raw\" | head -c 6")
[ "$magic" = RCLONE ] || die "the encrypted copy is not rclone crypt: $magic"
crypt=drill-crypt-key
summary=$(backup $p-data /app/api/backup/restore.sh check latest)
echo "$summary" | grep -q '^coaches: 2$' || die "check of the encrypted copy said: $summary"
crypt=wrong-key
if backup $p-data /app/api/backup/restore.sh check latest >/dev/null 2>&1; then die "a wrong key read the copy"; fi
crypt=drill-crypt-key plainread=1
# The plain copies made before the key was set stay reachable with BACKUP_PLAIN (RS_BACKUP_PLAIN).
plain=$(backup $p-data /app/api/backup/restore.sh list)
echo "$plain" | grep -q 'app-.*\.db\.gz$' || die "plain copies not listed with BACKUP_PLAIN: $plain"
if echo "$plain" | grep -q '\.bin$'; then die "BACKUP_PLAIN listed encrypted copies"; fi
summary=$(backup $p-data /app/api/backup/restore.sh check latest)
echo "$summary" | grep -q '^coaches: 2$' || die "check of a plain copy said: $summary"
plainread=''
docker volume create $p-crypt >/dev/null
backup $p-crypt /app/api/backup/restore.sh restore latest
crypt=''
start_app $p-crypt
login
[ "$(coach_names)" = "乙 甲 " ] || die "encrypted restore gave coaches: $(coach_names)"
curl -sf -o /dev/null "http://127.0.0.1:$port$image" || die "image missing after the encrypted restore"
stop_app

step "pruning keeps recent copies and drops old ones"
backup $p-data sh -c '
  . /app/api/backup/common.sh
  for age in 10 40; do
    f=/tmp/app-$(date -u -d "$age days ago" +%Y%m%dT%H%M%SZ).db.gz
    echo x >$f && touch -d "$age days ago" $f && rclone copyto $f "$REMOTE/db/${f#/tmp/}"
  done'
run_backup
list=$(backup $p-data /app/api/backup/restore.sh list)
echo "$list" | grep -q "app-$(date -u -d '10 days ago' +%Y%m%d)" || die "a 10 day old copy was pruned"
if echo "$list" | grep -q "app-$(date -u -d '40 days ago' +%Y%m%d)"; then
  die "a 40 day old copy was kept"
fi

step "failures are reported"
if backup $p-fresh sh -c 'rm /data/app.db && /app/api/backup/backup.sh'; then die "backup of a missing database passed"; fi
if backup $p-data /app/api/backup/restore.sh restore app-nope.db.gz; then die "restore of a missing copy passed"; fi
if backup $p-data /app/api/backup/restore.sh restore ../x; then die "restore accepted a bad name"; fi

step "schedule"
next=$(docker run --rm -e BACKUP_AT=03:30 rs-backup:drill timeout 2 /app/api/backup/schedule.sh || true)
echo "$next" | grep -q 'next backup at .* 03:30 CST' || die "schedule said: $next"

echo "drill passed"
