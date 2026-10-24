# shellcheck shell=sh disable=SC2034
# Shared by the backup scripts.
HERE=/app/api/backup
DB=${DATABASE_PATH:-/data/app.db}
UPLOADS=${UPLOADS_DIR:-/data/uploads}
# rclone reads the "cos" remote from RCLONE_CONFIG_COS_* variables (see deploy/README.md).
REMOTE="cos:${COS_BUCKET:-}"

# Posts to a WeCom group robot when ALERT_WEBHOOK is set.
alert() {
  [ -n "${ALERT_WEBHOOK:-}" ] || return 0
  ALERT_TEXT="球馆系统备份失败：$1" node -e '
    fetch(process.env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: process.env.ALERT_TEXT } }),
    }).catch((e) => console.error("alert failed:", e.message))' || true
}

# rclone lsf, where a folder not made yet lists as empty (rclone exits with 3) but any other
# failure, such as COS being unreachable, fails.
remote_ls() {
  ls_status=0
  rclone lsf "$@" || ls_status=$?
  [ "$ls_status" -eq 0 ] || [ "$ls_status" -eq 3 ]
}
