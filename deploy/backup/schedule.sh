#!/bin/sh
# Runs backup.sh every day at BACKUP_AT (HH:MM, venue time).
set -eu
at=${BACKUP_AT:-03:30}
export TZ=Asia/Shanghai
while true; do
  next=$(date -d "$at" +%s)
  [ "$next" -gt "$(date +%s)" ] || next=$(date -d "tomorrow $at" +%s)
  echo "next backup at $(date -d "@$next" '+%Y-%m-%d %H:%M %Z')"
  sleep $((next - $(date +%s)))
  /app/api/backup/backup.sh || true
done
