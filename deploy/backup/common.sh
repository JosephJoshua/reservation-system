# shellcheck shell=sh disable=SC2034
# Shared by the backup scripts.
HERE=/app/api/backup
DB=${DATABASE_PATH:-/data/app.db}
UPLOADS=${UPLOADS_DIR:-/data/uploads}
: "${COS_BUCKET:?COS_BUCKET is not set}"
# rclone reads the "cos" remote from RCLONE_CONFIG_COS_* variables (see deploy/README.md).
REMOTE="cos:$COS_BUCKET"

# Logs the reason and, when ALERT_WEBHOOK is set, posts it to a WeCom group robot.
fail() {
  echo "backup failed: $1" >&2
  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    ALERT_TEXT="球馆系统备份失败：$1" node -e '
      fetch(process.env.ALERT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: process.env.ALERT_TEXT } }),
      }).catch((e) => console.error("alert failed:", e.message))' || true
  fi
  exit 1
}
