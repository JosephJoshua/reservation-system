#!/bin/sh
# Runs the deployment on the server. Installed as /srv/rs/rs.sh; see deploy/README.md.
set -eu
cd "${RS_HOME:-/srv/rs}"

usage() {
  cat <<'USAGE'
usage: rs.sh <command>
  build <dir> <tag>   build images rs-app:<tag> and rs-backup:<tag> from a release in <dir>
  staging <tag>       run <tag> on staging
  prod <tag>          back up, then run <tag> in production
  promote             run the release that is on staging in production
  rollback            run the previous production release again
  backup              back up production now
  backups             list stored backups
  verify [name]       download a backup (default: latest), check it and count its rows
  restore <name>      stop production, restore a backup (or "latest"), start again
  status              show containers and releases
  logs [service]      follow logs (app, app-staging, backup, caddy)
  prune               remove releases and images other than the newest five
USAGE
  exit 2
}

[ -f .env ] || { echo "$(pwd)/.env is missing, see deploy/README.md" >&2; exit 1; }

dc() { docker compose -f compose.yml "$@"; }
get() { sed -n "s/^$1=//p" .env; }
set_var() {
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >>.env; fi
}
need_image() { docker image inspect "rs-app:$1" >/dev/null 2>&1 || { echo "no image rs-app:$1, build it first" >&2; exit 1; }; }
prod_running() { [ -n "$(dc ps -q --status running app)" ]; }

cmd=${1:-}
[ $# -gt 0 ] && shift
case $cmd in
  build)
    [ $# -eq 2 ] || usage
    dir=$1 tag=$2
    args=
    for name in NODE_IMAGE RCLONE_IMAGE NPM_REGISTRY; do
      value=$(get $name)
      [ -z "$value" ] || args="$args --build-arg $name=$value"
    done
    for target in app backup; do
      # shellcheck disable=SC2086
      docker build -f "$dir/deploy/Dockerfile" --target "$target" -t "rs-$target:$tag" $args "$dir"
    done
    cp "$dir/deploy/compose.yml" "$dir/deploy/Caddyfile" "$dir/deploy/rs.sh" .
    ;;
  staging)
    [ $# -eq 1 ] || usage
    need_image "$1"
    set_var STAGING_TAG "$1"
    dc up -d --wait app-staging caddy
    echo "staging runs $1"
    ;;
  prod)
    [ $# -eq 1 ] || usage
    need_image "$1"
    # A fresh copy first: a release may migrate the database, and this is the way back.
    if prod_running; then dc exec -T backup /app/api/backup/backup.sh; fi
    current=$(get APP_TAG)
    if [ -n "$current" ] && [ "$current" != "$1" ]; then set_var APP_PREV_TAG "$current"; fi
    set_var APP_TAG "$1"
    dc up -d --wait app backup caddy
    echo "production runs $1"
    ;;
  promote)
    tag=$(get STAGING_TAG)
    [ -n "$tag" ] || { echo "nothing on staging" >&2; exit 1; }
    exec "$(pwd)/rs.sh" prod "$tag"
    ;;
  rollback)
    tag=$(get APP_PREV_TAG)
    [ -n "$tag" ] || { echo "no previous release" >&2; exit 1; }
    exec "$(pwd)/rs.sh" prod "$tag"
    ;;
  backup)
    dc exec -T backup /app/api/backup/backup.sh
    ;;
  backups)
    dc run --rm --no-deps backup /app/api/backup/restore.sh list
    ;;
  verify)
    dc run --rm --no-deps backup /app/api/backup/restore.sh check "${1:-latest}"
    ;;
  restore)
    [ $# -eq 1 ] || usage
    dc stop app
    # Start production again even when the restore fails, on whichever database is in place.
    status=0
    dc run --rm --no-deps backup /app/api/backup/restore.sh restore "$1" || status=$?
    dc up -d --wait app
    exit $status
    ;;
  status)
    dc ps
    echo "production: $(get APP_TAG)  previous: $(get APP_PREV_TAG)  staging: $(get STAGING_TAG)"
    ;;
  logs)
    dc logs -f --tail 200 "$@"
    ;;
  prune)
    keep="$(get APP_TAG) $(get APP_PREV_TAG) $(get STAGING_TAG)"
    for dir in $(ls -1t releases | tail -n +6); do
      case " $keep " in *" $dir "*) continue ;; esac
      rm -rf "releases/$dir"
      docker image rm "rs-app:$dir" "rs-backup:$dir" 2>/dev/null || true
    done
    docker image prune -f
    ;;
  *) usage ;;
esac
