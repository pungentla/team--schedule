#!/usr/bin/env bash
#
# 排班宝 TeamShift —— 数据库备份脚本
#
# 为什么不能直接 cp：
#   本项目用 WAL 模式，数据分布在 app.db + app.db-wal 两个文件里。
#   直接复制 app.db 可能拿到"还没合并 WAL"的不一致快照。
#   必须用 SQLite 的 .backup 命令（它会正确处理 WAL）。
#
# 用法：
#   ./deploy/backup.sh                    # 备份到 ./backups
#   ./deploy/backup.sh /mnt/backup        # 备份到指定目录
#
# 定时任务（每天 3 点）：
#   crontab -e
#   0 3 * * * /path/to/teamshift/deploy/backup.sh >> /var/log/teamshift-backup.log 2>&1

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[✓]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${1:-$PROJECT_ROOT/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
CONTAINER="${CONTAINER_NAME:-teamshift-backend}"
DB_IN_CONTAINER="/app/backend/data/app.db"

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y%m%d_%H%M%S)
OUT="$BACKUP_DIR/teamshift_$TS.db"

# 优先用容器内的 sqlite3 做在线备份（保证一致性）
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  docker exec "$CONTAINER" node -e "
const {DatabaseSync}=require('node:sqlite');
const fs=require('fs');
const db=new DatabaseSync('$DB_IN_CONTAINER');
// VACUUM INTO 生成一致快照，且自动合并 WAL
db.exec(\"VACUUM INTO '/tmp/backup.db'\");
db.close();
const size=fs.statSync('/tmp/backup.db').size;
console.log('SIZE='+size);
" || { error "备份失败（容器内执行出错）"; exit 1; }

  docker cp "${CONTAINER}:/tmp/backup.db" "$OUT" >/dev/null
  docker exec "$CONTAINER" rm -f /tmp/backup.db >/dev/null 2>&1 || true
  info "已备份（容器在线模式）: $OUT"
else
  # 容器没跑时，用本机 sqlite3（如果装了）
  if command -v sqlite3 >/dev/null 2>&1 && [ -f "$PROJECT_ROOT/data/app.db" ]; then
    sqlite3 "$PROJECT_ROOT/data/app.db" ".backup '$OUT'"
    info "已备份（本机 sqlite3）: $OUT"
  else
    error "容器未运行，且本机没有 sqlite3。请先启动服务，或安装 sqlite3"
    exit 1
  fi
fi

SIZE=$(du -h "$OUT" | cut -f1)
info "文件大小: $SIZE"

# 校验备份可用性：能打开且能查到表
docker run --rm -v "$BACKUP_DIR:/b:ro" --entrypoint node node:22-alpine -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/b/$(basename "$OUT")',{readOnly:true});
const t=db.prepare(\"SELECT COUNT(*) c FROM sqlite_master WHERE type='table'\").get();
const u=db.prepare('SELECT COUNT(*) c FROM users').get();
console.log('表数量: '+t.c+', 用户数: '+u.c);
" 2>/dev/null || error "备份校验失败（文件可能损坏）"

# 清理旧备份
DELETED=$(find "$BACKUP_DIR" -name "teamshift_*.db" -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && info "已清理 $DELETED 个超过 ${KEEP_DAYS} 天的旧备份"

info "备份完成"
