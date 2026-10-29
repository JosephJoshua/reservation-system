# shellcheck shell=sh disable=SC2034
# Shared by the backup scripts.
HERE=/app/api/backup
DB=${DATABASE_PATH:-/data/app.db}
UPLOADS=${UPLOADS_DIR:-/data/uploads}
# rclone reads the "cos" remote from RCLONE_CONFIG_COS_* variables (see deploy/README.md).
REMOTE="cos:${COS_BUCKET:-}"
# With BACKUP_CRYPT_PASSWORD, copies are encrypted before upload and live under crypt/ in the
# bucket. File names stay readable, so the COS console still shows which copies exist.
# BACKUP_PLAIN=1 (rs.sh passes it for RS_BACKUP_PLAIN=1) reads the unencrypted copies instead.
# Called by each script once its error handling is in place.
use_remote() {
  [ -n "${BACKUP_CRYPT_PASSWORD:-}" ] && [ "${BACKUP_PLAIN:-}" != 1 ] || return 0
  export RCLONE_CONFIG_COSCRYPT_TYPE=crypt
  export RCLONE_CONFIG_COSCRYPT_REMOTE="cos:${COS_BUCKET:-}"
  export RCLONE_CONFIG_COSCRYPT_FILENAME_ENCRYPTION=off
  export RCLONE_CONFIG_COSCRYPT_DIRECTORY_NAME_ENCRYPTION=false
  RCLONE_CONFIG_COSCRYPT_PASSWORD=$(printf '%s' "$BACKUP_CRYPT_PASSWORD" | rclone obscure -) ||
    return 1
  export RCLONE_CONFIG_COSCRYPT_PASSWORD
  REMOTE=coscrypt:crypt
}
# Touched after each successful backup; the app alerts when it gets old (deploy/README.md).
MARKER="$(dirname "$DB")/backup-ok"

# Posts to a WeCom group robot when ALERT_WEBHOOK is set. The robot answers 200 with a non-zero
# errcode for a wrong key or too many messages, which counts as a failure too.
alert() {
  [ -n "${ALERT_WEBHOOK:-}" ] || return 0
  ALERT_TEXT="球馆系统备份失败：$1" node -e '
    fetch(process.env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: process.env.ALERT_TEXT } }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok || (body.errcode ?? 0) !== 0)
          throw new Error("HTTP " + res.status + " errcode " + body.errcode + " " + (body.errmsg ?? ""))
      })
      .catch((e) => console.error("alert failed:", e.message))' || true
}

# rclone lsf, where a folder not made yet lists as empty (rclone exits with 3) but any other
# failure, such as COS being unreachable, fails.
remote_ls() {
  ls_status=0
  rclone lsf "$@" || ls_status=$?
  [ "$ls_status" -eq 0 ] || [ "$ls_status" -eq 3 ]
}
