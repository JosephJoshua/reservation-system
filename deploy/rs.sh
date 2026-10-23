#!/bin/sh
# Runs the deployment on the server, from /srv/rs; see deploy/README.md.
set -eu
cd "${RS_HOME:-/srv/rs}"

usage() {
  cat <<'USAGE'
usage: rs.sh <command>
  build <dir> <tag>         build images rs-app:<tag> and rs-backup:<tag> from a release in <dir>
  staging <tag>             run <tag> on staging
  prod <tag>                back up, then run <tag> in production
  promote                   run the release that is on staging in production
  rollback                  swap production with the previous release
  backup                    back up production now
  backups                   list stored backups
  verify [backup]           download a backup (default: latest), check it and count its rows
  restore <backup> [tag]    stop production, restore a backup (or "latest"), start production
                            again on [tag] (default: the current release)
  restore-images            copy back uploaded images missing from production
  status                    show containers and releases
  logs [service]            follow logs (app, app-staging, backup, caddy)
  prune                     remove releases and images other than the newest five
USAGE
  exit 2
}

[ -f .env ] || { echo "$(pwd)/.env is missing, see deploy/README.md" >&2; exit 1; }

die() { echo "$1" >&2; exit 1; }
dc() { docker compose -f compose.yml "$@"; }
get() { sed -n "s/^$1=//p" .env; }
set_var() {
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >>.env; fi
}
need_image() { docker image inspect "rs-app:$1" >/dev/null 2>&1 || die "no image rs-app:$1, build it first"; }
prod_running() { [ -n "$(dc ps -q --status running app)" ]; }

# compose.yml, the Caddyfile and this script follow the production release, so shipping a branch
# to staging never changes how production runs. Copied then renamed: this script may be running.
install_config() {
  src=releases/$1/deploy
  [ -d "$src" ] || { echo "releases/$1 is gone, keeping the current compose.yml" >&2; return 0; }
  for file in compose.yml Caddyfile rs.sh; do
    cp "$src/$file" ".$file.new" && mv ".$file.new" "$file"
  done
  if [ -n "$(dc ps -q --status running caddy)" ]; then
    dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  fi
}

# Records the release being replaced as the one to roll back to.
remember_previous() {
  if [ -n "$1" ] && [ "$1" != "$2" ]; then set_var APP_PREV_TAG "$1"; fi
}

# Runs a backup script with the production release's image, or staging's before the first one.
backup_tool() {
  tag=$(get APP_TAG)
  [ -n "$tag" ] || tag=$(get STAGING_TAG)
  [ -n "$tag" ] || die "no release built yet"
  APP_TAG=$tag dc run --rm --no-deps backup "$@"
}

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
    ;;
  staging)
    [ $# -eq 1 ] || usage
    need_image "$1"
    # Without the AppSecret the API falls back to a development login that trusts any caller.
    grep -q '^WECHAT_APP_SECRET=.' staging.env || die "set WECHAT_APP_SECRET in staging.env first"
    [ -f compose.yml ] || install_config "$1"
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
    remember_previous "$current" "$1"
    install_config "$1"
    set_var APP_TAG "$1"
    dc up -d --wait app backup caddy
    echo "production runs $1"
    ;;
  promote)
    tag=$(get STAGING_TAG)
    [ -n "$tag" ] || die "nothing on staging"
    exec "$(pwd)/rs.sh" prod "$tag"
    ;;
  rollback)
    [ $# -eq 0 ] || usage
    tag=$(get APP_PREV_TAG)
    [ -n "$tag" ] || die "no previous release"
    exec "$(pwd)/rs.sh" prod "$tag"
    ;;
  backup)
    dc exec -T backup /app/api/backup/backup.sh
    ;;
  backups)
    backup_tool /app/api/backup/restore.sh list
    ;;
  verify)
    backup_tool /app/api/backup/restore.sh check "${1:-latest}"
    ;;
  restore)
    [ $# -ge 1 ] && [ $# -le 2 ] || usage
    current=$(get APP_TAG)
    tag=${2:-$current}
    [ -n "$tag" ] || die "no production release yet: rs.sh restore <backup> <tag>"
    need_image "$tag"
    # The scheduled backup must not copy the database while it is being swapped.
    dc stop app backup
    status=0
    APP_TAG=$tag dc run --rm --no-deps backup /app/api/backup/restore.sh restore "$1" || status=$?
    if [ "$status" -eq 99 ]; then
      die "production is stopped. Look at /data with: cd $(pwd) && APP_TAG=$tag docker compose -f compose.yml run --rm --no-deps backup sh
then run: $(pwd)/rs.sh restore $1 $tag"
    elif [ "$status" -ne 0 ]; then
      # Nothing was replaced: bring production back as it was.
      if [ -n "$current" ]; then dc up -d --wait app backup; fi
      exit 1
    fi
    # Started straight on the release meant for this database, so no other release migrates it.
    # The release it replaces ran on a newer database, so it is not offered as a rollback.
    if [ "$tag" != "$current" ]; then
      set_var APP_PREV_TAG ""
      install_config "$tag"
      set_var APP_TAG "$tag"
    fi
    dc up -d --wait app backup caddy
    echo "production runs $tag on the restored database"
    ;;
  restore-images)
    backup_tool /app/api/backup/restore.sh images
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
