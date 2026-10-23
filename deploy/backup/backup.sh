#!/bin/sh
# Copies the database and uploaded images to COS. The database goes to db/ as one gzipped file per
# run; files older than BACKUP_KEEP_DAYS are pruned, but only after a new copy has landed.
set -eu
# shellcheck source=common.sh
. /app/api/backup/common.sh

tmp=
reason=
fail() { reason=$1; exit 1; }
# Every way out that is not success alerts, including a command stopped by set -e.
finish() {
  status=$?
  [ -z "$tmp" ] || rm -rf "$tmp"
  if [ "$status" -ne 0 ]; then
    reason=${reason:-"stopped with status $status"}
    echo "backup failed: $reason" >&2
    alert "$reason"
  fi
}
trap finish EXIT

[ -n "${COS_BUCKET:-}" ] || fail "COS_BUCKET is not set"
[ -f "$DB" ] || fail "database $DB not found"
tmp=$(mktemp -d)
name="app-$(date -u +%Y%m%dT%H%M%SZ).db.gz"

node "$HERE/sqlite.mjs" snapshot "$DB" "$tmp/app.db" || fail "snapshot failed"
gzip -9 "$tmp/app.db" || fail "compressing the snapshot failed"
rclone copyto "$tmp/app.db.gz" "$REMOTE/db/$name" || fail "upload of $name failed"
if [ -d "$UPLOADS" ]; then
  # Uploaded images never change once written, so a copy only sends new files.
  rclone copy "$UPLOADS" "$REMOTE/uploads" || fail "upload of images failed"
fi
rclone delete "$REMOTE/db" --min-age "${BACKUP_KEEP_DAYS:-30}d" || fail "pruning old backups failed"
echo "backup ok: db/$name ($(du -k "$tmp/app.db.gz" | cut -f1) KB)"
