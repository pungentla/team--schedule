#!/usr/bin/env bash
#
# 排班宝 TeamShift —— 数据库恢复脚本
#
# 用备份文件覆盖当前数据库。操作前会自动把"当前库"另存为 .broken，
# 万一恢复错了还能回退。
#
# 用法：
#   ./deploy/restore.sh backups/teamshift_20261104_130857.db
#   ./deploy/restore.sh                              # 用最新备份
#
# 注意：恢复期间服务会短暂中断（约 10 秒）。

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f $PROJECT_ROOT/docker-compose.prod.yml"
CONTAINER="${CONTAINER_NAME:-teamshift-backend}"
DB_DIR="$PROJECT_ROOT/data"

BACKUP_FILE="${1:-}"

# 没指定则取最新
if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE=$(ls -t "$PROJECT_ROOT"/backups/teamshift_*.db 2>/dev/null | head -1 || true)
  [ -n "$BACKUP_FILE" ] || { error "backups/ 下没有可用备份"; exit 1; }
  warn "未指定备份，使用最新: $(basename "$BACKUP_FILE")"
fi

[ -f "$BACKUP_FILE" ] || { error "备份文件不存在: $BACKUP_FILE"; exit 1; }

# 校验备份可用
info "校验备份完整性..."
docker run --rm -v "$(dirname "$(realpath "$BACKUP_FILE")"):/b:ro" --entrypoint node node:22-alpine -e "
const {DatabaseSync}=require('node:sqlite');
const path=require('path');
const f='/b/'+path.basename('$BACKUP_FILE');
const db=new DatabaseSync(f,{readOnly:true});
const r=Object.values(db.prepare('PRAGMA integrity_check').get())[0];
if(r!=='ok'){console.error('完整性检查失败: '+r);process.exit(1);}
const u=db.prepare('SELECT COUNT(*) c FROM users').get();
const a=db.prepare('SELECT COUNT(*) c FROM assignments').get();
console.log('  完整性 ok / 用户 '+u.c+' / 分配 '+a.c);
" 2>/dev/null || { error "备份文件校验失败，已中止（未做任何修改）"; exit 1; }

# 确认
echo ""
warn "即将用备份覆盖当前数据库："
echo "    备份: $BACKUP_FILE"
echo "    目标: $DB_DIR/app.db"
echo ""
read -r -p "确认恢复？(y/N) " ans
[ "$ans" = "y" ] || { info "已取消"; exit 0; }

TS=$(date +%Y%m%d_%H%M%S)

# 1. 停服务
info "停止后端..."
docker stop "$CONTAINER" >/dev/null 2>&1 || true

# 2. 另存当前库（可能已损坏，留作排查）
if [ -f "$DB_DIR/app.db" ]; then
  cp "$DB_DIR/app.db" "$DB_DIR/app.db.before-restore-$TS"
  info "当前库已另存: app.db.before-restore-$TS"
fi

# 3. 覆盖（必须先删 WAL/SHM，否则旧日志会污染新库）
cp "$BACKUP_FILE" "$DB_DIR/app.db"
rm -f "$DB_DIR/app.db-wal" "$DB_DIR/app.db-shm"
info "数据库已替换，WAL 已清理"

# 4. 启动
info "启动后端..."
docker start "$CONTAINER" >/dev/null

# 5. 等健康
for i in $(seq 1 20); do
  if docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null | grep -q healthy; then
    info "后端已就绪"
    break
  fi
  [ "$i" -eq 20 ] && { error "启动超时，请检查日志: docker logs $CONTAINER --tail=40"; exit 1; }
  sleep 1.5
done

echo ""
info "恢复完成"
echo ""
echo "  请验证："
echo "    1. 用管理员账号登录确认数据正确"
echo "    2. 检查最近排班是否为你期望的版本"
echo "    3. 若恢复错了，可回退："
echo "       cp $DB_DIR/app.db.before-restore-$TS $DB_DIR/app.db && docker restart $CONTAINER"
echo ""
