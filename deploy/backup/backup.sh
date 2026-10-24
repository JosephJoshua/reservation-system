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
# Mirrors the images. One removed here, such as a lesson photo of a deleted account, moves to
# uploads-removed/<date> and is purged with the database backups of that age. An empty folder is
# never mirrored, and more than 300 removals in a day stop the mirror: that is a lost volume, not
# a cleanup.
if [ -d "$UPLOADS" ] && [ -n "$(ls -A "$UPLOADS")" ]; then
  # Every file, in subfolders such as invoices/ too, as the sync below goes through them all.
  (cd "$UPLOADS" && find . -type f | sed 's|^\./||') | sort >"$tmp/local"
  remote_ls -R --files-only "$REMOTE/uploads" >"$tmp/remote" || fail "listing images in COS failed"
  gone=$(sort "$tmp/remote" | comm -23 - "$tmp/local" | wc -l)
  [ "$gone" -le 300 ] || [ -n "${BACKUP_ALLOW_REMOVALS:-}" ] ||
    fail "$gone images are gone from $UPLOADS since the last backup: restore them with rs.sh restore-images, or if they were removed on purpose, run rs.sh backup --allow-removals"
  rclone sync "$UPLOADS" "$REMOTE/uploads" --backup-dir "$REMOTE/uploads-removed/$(date -u +%Y%m%d)" ||
    fail "upload of images failed"
fi
rclone delete "$REMOTE/db" --min-age "${BACKUP_KEEP_DAYS:-30}d" || fail "pruning old backups failed"
cutoff=$(date -u -d "${BACKUP_KEEP_DAYS:-30} days ago" +%Y%m%d)
days=$(remote_ls --dirs-only "$REMOTE/uploads-removed") || fail "listing removed images failed"
for day in $days; do
  day=${day%/}
  case $day in *[!0-9]*) continue ;; esac
  if [ "$day" -lt "$cutoff" ]; then
    rclone purge "$REMOTE/uploads-removed/$day" || fail "pruning removed images failed"
  fi
done
echo "backup ok: db/$name ($(du -k "$tmp/app.db.gz" | cut -f1) KB)"
