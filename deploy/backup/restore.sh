#!/bin/sh
# Database copies in COS.
#   restore.sh list                     show the stored copies, oldest first
#   restore.sh check latest | <name>    download a copy, check it and count what it holds
#   restore.sh restore latest | <name>  put a copy in place of the live database
# Restore only while the app container is stopped; rs.sh restore does that for you.
set -eu
# shellcheck source=common.sh
. /app/api/backup/common.sh
die() { echo "restore failed: $1" >&2; exit 1; }
usage() { echo "usage: restore.sh list | check <name> | restore <name>  (name: latest or app-<time>.db.gz)" >&2; exit 2; }

if [ "${1:-}" = list ]; then
  rclone lsl "$REMOTE/db" | sort -k4
  exit 0
fi
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
# Downloaded next to the database, so putting it in place is a rename on the same disk.
tmp=$(mktemp -d "$(dirname "$DB")/.restore.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
rclone copyto "$REMOTE/db/$name" "$tmp/app.db.gz"
gunzip "$tmp/app.db.gz"
node "$HERE/sqlite.mjs" check "$tmp/app.db"

if [ "$command" = check ]; then
  node "$HERE/sqlite.mjs" summary "$tmp/app.db"
  echo "db/$name is readable"
  exit 0
fi

# Keep the database being replaced, and drop its WAL files: they belong to the old file and
# would corrupt the restored one.
if [ -f "$DB" ]; then
  kept="$DB.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$DB" "$kept"
  echo "previous database kept as $kept"
fi
rm -f "$DB-wal" "$DB-shm"
mv "$tmp/app.db" "$DB"

# Images are only ever added, so copying back what is missing is enough.
if [ -n "$(rclone lsf "$REMOTE/uploads" --max-depth 1 2>/dev/null | head -n 1)" ]; then
  rclone copy "$REMOTE/uploads" "$UPLOADS"
fi
echo "restored db/$name"
