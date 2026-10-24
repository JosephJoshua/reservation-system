#!/bin/sh
# Database copies in COS.
#   restore.sh list                     show the stored copies, oldest first
#   restore.sh check latest | <name>    download a copy, check it and count what it holds
#   restore.sh restore latest | <name>  put a copy in place of the live database
#   restore.sh images [<YYYYMMDD>]      copy back uploaded images missing from the volume, with
#                                       those removed from it since that UTC day
# Restore only while the app container is stopped; rs.sh restore does that for you. Exit status 99
# means the swap stopped halfway: the files in /data need a look before production starts.
set -eu
# shellcheck source=common.sh
. /app/api/backup/common.sh
die() { echo "restore failed: $1" >&2; exit 1; }
[ -n "${COS_BUCKET:-}" ] || die "COS_BUCKET is not set"
usage() { echo "usage: restore.sh list | images [<YYYYMMDD>] | check <name> | restore <name>  (name: latest or app-<time>.db.gz)" >&2; exit 2; }

# Copies back what is missing, and lesson photos removed on or after day $1 (YYYYMMDD), which a
# database copied before then may still use; the app clears ones it does not use within a day.
# Other removed files stay out: an invoice PDF removed with a deleted account must not come back,
# and nothing would clear it again. rclone exits with 3 when there is no uploads/ folder yet,
# which just means no images.
copy_images() {
  status=0
  rclone copy "$REMOTE/uploads" "$UPLOADS" || status=$?
  [ "$status" -eq 0 ] || [ "$status" -eq 3 ] || return 1
  [ -n "${1:-}" ] || return 0
  days=$(remote_ls --dirs-only "$REMOTE/uploads-removed") || return 1
  for day in $days; do
    day=${day%/}
    case $day in *[!0-9]*) continue ;; esac
    if [ "$day" -ge "$1" ]; then
      rclone copy "$REMOTE/uploads-removed/$day" "$UPLOADS" --include '/fb*' || return 1
    fi
  done
}

case ${1:-} in
  list)
    rclone lsl "$REMOTE/db" | sort -k4
    exit 0
    ;;
  images)
    case ${2:-} in '' | [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) usage ;; esac
    copy_images "${2:-}" || die "copying images failed"
    exit 0
    ;;
esac
[ $# -eq 2 ] || usage
command=$1
case $command in check | restore) ;; *) usage ;; esac
case $2 in
  latest)
    name=$(rclone lsf "$REMOTE/db" --files-only | grep -E '^app-[0-9]{8}T[0-9]{6}Z\.db\.gz$' | sort | tail -n 1 || true)
    [ -n "$name" ] || die "no backups in $REMOTE/db"
    ;;
  app-*.db.gz)
    name=$2
    case $name in */*) usage ;; esac
    ;;
  *) usage ;;
esac

[ -n "$(rclone lsf "$REMOTE/db/$name")" ] || die "no backup named $name"
# A restore downloads next to the database, so putting it in place is a rename on the same disk;
# a check stays out of the live volume.
if [ "$command" = restore ]; then
  tmp=$(mktemp -d "$(dirname "$DB")/.restore.XXXXXX")
else
  tmp=$(mktemp -d)
fi
trap 'rm -rf "$tmp"' EXIT
rclone copyto "$REMOTE/db/$name" "$tmp/app.db.gz"
gunzip "$tmp/app.db.gz"
node "$HERE/sqlite.mjs" check "$tmp/app.db"

if [ "$command" = check ]; then
  node "$HERE/sqlite.mjs" summary "$tmp/app.db"
  echo "db/$name is readable"
  exit 0
fi

# Keep the database being replaced with copies of its WAL files, which may hold its newest writes;
# left in place they would corrupt the restored file. Copies, so a rerun after a failure here
# never loses them.
halfway() {
  echo "restore failed halfway: $1" >&2
  if [ -n "${kept:-}" ]; then
    echo "this run moved the live database to $kept; move it back with any $kept-wal and $kept-shm" >&2
  else
    echo "this run did not move a live database aside" >&2
  fi
  exit 99
}
if [ -f "$DB" ]; then
  kept="$DB.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  for suffix in -wal -shm; do
    if [ -f "$DB$suffix" ] && ! cp -p "$DB$suffix" "$kept$suffix"; then
      rm -f "$kept-wal" "$kept-shm"
      die "could not copy $DB$suffix"
    fi
  done
  if ! mv "$DB" "$kept"; then
    rm -f "$kept-wal" "$kept-shm"
    die "could not move the current database aside"
  fi
  echo "previous database kept as $kept"
fi
rm -f "$DB-wal" "$DB-shm" || halfway "could not remove the old WAL files"
mv "$tmp/app.db" "$DB" || halfway "could not put db/$name in place"

# The database is replaced from here on, so a failed image copy is a warning, not a failure.
day=$(echo "$name" | cut -c5-12)
copy_images "$day" || echo "WARNING: some images were not copied back; run rs.sh restore-images $day" >&2
echo "restored db/$name"
