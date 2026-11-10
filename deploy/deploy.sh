#!/usr/bin/env bash
#
# 排班宝 TeamShift —— 一键部署脚本（轻量云服务器 + Docker）
#
# 适用：Ubuntu 20.04+ / Debian 11+ / CentOS Stream 9+
# 用法：
#   chmod +x deploy/deploy.sh
#   ./deploy/deploy.sh
#
# 脚本做四件事：
#   1. 环境自检（Docker、端口占用；HTTPS 模式另查域名）
#   2. HTTP 模式跳过证书；HTTPS 模式申请证书（Let's Encrypt）
#   3. 构建并启动服务
#   4. 冒烟测试（API 健康检查 + H5 首页）

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }
die()   { error "$*"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

ENV_FILE=".env.production"
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE")

echo ""
echo "  排班宝 TeamShift —— 生产部署"
echo "  目录: $PROJECT_ROOT"
echo ""

# ============================================================
# 1. 环境自检
# ============================================================
echo "── 步骤 1/4：环境自检 ──"

command -v docker >/dev/null 2>&1 || die "未安装 Docker。请先执行：curl -fsSL https://get.docker.com | sh"
docker info >/dev/null 2>&1 || die "Docker 未运行或无权限。尝试：sudo systemctl start docker，并把当前用户加入 docker 组"
info "Docker 可用：$(docker --version | head -1)"

docker compose version >/dev/null 2>&1 || die "未安装 Docker Compose v2。请升级 Docker 到 20.10+"
info "Compose 可用：$(docker compose version --short)"

[ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE。请先执行：cp .env.production.example $ENV_FILE"

# 默认使用 HTTP/IP；只有显式开启 HTTPS 才要求域名和证书邮箱。
set -a; . "$ENV_FILE"; set +a
DEPLOY_SCHEME="${DEPLOY_SCHEME:-http}"
case "$DEPLOY_SCHEME" in
  http|https) ;;
  *) die "DEPLOY_SCHEME 只支持 http 或 https" ;;
esac
export DEPLOY_SCHEME

if [ "$DEPLOY_SCHEME" = "https" ]; then
  COMPOSE+=(-f docker-compose.https.yml)
  [ -n "${DOMAIN:-}" ] || die "$ENV_FILE 里 DOMAIN 未填写"
  [ "$DOMAIN" != "shift.example.com" ] || die "请把 DOMAIN 改成你的真实域名（当前仍是示例值）"
  [ -n "${CERT_EMAIL:-}" ] || die "$ENV_FILE 里 CERT_EMAIL 未填写"

  info "域名: $DOMAIN"

  # 校验域名解析是否指向本机
  SERVER_IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || curl -s -m 5 ifconfig.me 2>/dev/null || echo "")
  DOMAIN_IP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || echo "")
  if [ -n "$SERVER_IP" ] && [ -n "$DOMAIN_IP" ]; then
    if [ "$SERVER_IP" = "$DOMAIN_IP" ]; then
      info "域名解析正确 → $DOMAIN_IP"
    else
      warn "域名解析到 $DOMAIN_IP，但本机公网 IP 是 $SERVER_IP"
      warn "如果刚改 DNS，可能还没生效（等 10 分钟）；否则证书申请会失败"
      read -r -p "仍要继续？(y/N) " ans
      [ "$ans" = "y" ] || exit 1
    fi
  elif [ -z "$DOMAIN_IP" ]; then
    die "域名 $DOMAIN 无法解析。请先在域名服务商处添加 A 记录指向本机 IP"
  fi
  BASE_URL="https://$DOMAIN"
  HEALTH_CURL=(curl -fsS -m 10 --resolve "$DOMAIN:443:127.0.0.1")
  CHECK_URL="$BASE_URL"
else
  BASE_URL="http://${SERVER_IP:-<服务器IP>}"
  HEALTH_CURL=(curl -fsS -m 10)
  CHECK_URL="http://127.0.0.1"
  info "HTTP/IP 模式，无需域名和证书；请放行服务器 TCP 80 端口"
fi

# 检查端口占用
PORTS=(80)
[ "$DEPLOY_SCHEME" = "https" ] && PORTS+=(443)
for p in "${PORTS[@]}"; do
  if ss -tlnp 2>/dev/null | grep -q ":$p "; then
    warn "端口 $p 已被占用，可能影响 Nginx 启动"
    ss -tlnp 2>/dev/null | grep ":$p " | head -2
  fi
done

# 数据目录
mkdir -p data deploy/certs
info "数据目录: $PROJECT_ROOT/data"

# ============================================================
# 2. 证书
# ============================================================
echo ""
echo "── 步骤 2/4：HTTPS 证书 ──"

CERT_PATH="deploy/certs/live/teamshift/fullchain.pem"

if [ "$DEPLOY_SCHEME" = "http" ]; then
  info "HTTP/IP 模式，跳过证书申请"
elif [ -f "$CERT_PATH" ]; then
  info "证书已存在，跳过申请"
  # 检查是否快过期
  if command -v openssl >/dev/null 2>&1; then
    END=$(openssl x509 -enddate -noout -in "$CERT_PATH" | cut -d= -f2)
    info "证书到期时间: $END"
  fi
else
  warn "未找到证书，开始申请（需要 80 端口可访问）"

  # 先用临时 nginx 占住 80 端口响应 ACME 验证
  docker run -d --name ts-acme-temp -p 80:80 \
    -v "$PROJECT_ROOT/deploy/certs:/etc/letsencrypt" \
    -v "$PROJECT_ROOT/.certbot-webroot:/var/www/certbot" \
    nginx:1.27-alpine >/dev/null 2>&1 || true

  docker exec ts-acme-temp sh -c "mkdir -p /var/www/certbot" >/dev/null 2>&1 || true
  # 写一个最小配置专门响应 challenge
  docker exec ts-acme-temp sh -c 'cat > /etc/nginx/conf.d/default.conf <<EOF
server {
  listen 80;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 200 "ok"; }
}
EOF
nginx -s reload' >/dev/null 2>&1 || true

  docker run --rm \
    -v "$PROJECT_ROOT/deploy/certs:/etc/letsencrypt" \
    -v "$PROJECT_ROOT/.certbot-webroot:/var/www/certbot" \
    certbot/certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" --email "$CERT_EMAIL" --agree-tos --no-eff-email \
    --cert-name teamshift --non-interactive \
    || { docker rm -f ts-acme-temp >/dev/null 2>&1 || true; die "证书申请失败。常见原因：域名未备案、80 端口被占用、域名解析未生效"; }

  docker rm -f ts-acme-temp >/dev/null 2>&1 || true

  # certbot 会生成 live/teamshift/，对应 nginx.https.conf 里的路径
  [ -f "$CERT_PATH" ] || die "证书已申请但路径不对，检查 deploy/certs/live/teamshift/"
  info "证书申请成功"
fi

# ============================================================
# 3. 构建与启动
# ============================================================
echo ""
echo "── 步骤 3/4：构建并启动 ──"

"${COMPOSE[@]}" up -d --build

info "等待服务健康..."
for i in $(seq 1 30); do
  if docker inspect --format='{{.State.Health.Status}}' teamshift-backend 2>/dev/null | grep -q healthy; then
    info "后端已就绪"
    break
  fi
  [ "$i" -eq 30 ] && { error "后端启动超时"; "${COMPOSE[@]}" logs --tail=40 backend; exit 1; }
  sleep 2
done

# ============================================================
# 4. 冒烟测试
# ============================================================
echo ""
echo "── 步骤 4/4：冒烟测试 ──"

sleep 2
HEALTH=$("${HEALTH_CURL[@]}" "$CHECK_URL/api/health" || echo "")
if echo "$HEALTH" | grep -q '"ok":true'; then
  info "Nginx → API 健康检查通过（$DEPLOY_SCHEME）"
else
  error "健康检查失败，返回: $HEALTH"
  echo ""
  error "排查建议："
  echo "  1. 容器状态:  ${COMPOSE[*]} ps"
  echo "  2. Nginx 日志: ${COMPOSE[*]} logs nginx --tail=30"
  echo "  3. 后端日志:  ${COMPOSE[*]} logs backend --tail=30"
  exit 1
fi

"${HEALTH_CURL[@]}" "$CHECK_URL/" >/dev/null || die "H5 页面访问失败，请检查 Nginx 日志和 H5 镜像构建结果"
info "H5 页面检查通过"

# 检查是否有用户数据，没有则提示灌种子
USER_COUNT=$("${COMPOSE[@]}" exec -T backend node -e "
const {DatabaseSync}=require('node:sqlite');
try{
  const db=new DatabaseSync('/app/backend/data/app.db',{readOnly:true});
  const r=db.prepare('SELECT COUNT(*) c FROM users').get();
  console.log(r.c);
}catch(e){console.log('0');}
" 2>/dev/null || echo "0")

if [ "$USER_COUNT" = "0" ]; then
  warn "数据库为空，未灌入任何账号"
  echo ""
  echo "  两种选择："
  echo "    A. 灌演示数据（含 admin/123456 与 emp001~020）："
  echo "       ${COMPOSE[*]} exec backend node scripts/seed.js"
  echo "    B. 生产模式（不灌演示数据，需手动建管理员）：见 docs/production-setup.md"
else
  info "数据库已有 $USER_COUNT 个账号"
fi

echo ""
echo "════════════════════════════════════════"
info "部署完成"
echo ""
echo "  浏览器访问: $BASE_URL/"
echo "  API 地址:   $BASE_URL/api"
echo "  健康检查:   $BASE_URL/health"
echo "  请从另一台设备访问上述地址，确认云安全组和防火墙已放行。"
echo ""
if [ "$DEPLOY_SCHEME" = "https" ]; then
  echo "  小程序上线："
  echo "    1. 在小程序后台配置 request 合法域名: $BASE_URL"
  echo "    2. 修改 miniprogram/config/env.js 的 PROD_URL 为 $BASE_URL"
  echo "    3. 上传代码并提交审核"
else
  warn "HTTP 不加密，账号和登录令牌以明文传输；请在可信网络使用，公网敏感使用建议切换 HTTPS。"
  echo "  IP 模式可供浏览器使用；微信小程序正式版仍需 HTTPS 合法域名，见 docs/deployment.md。"
fi
echo ""
echo "  常用命令："
echo "    ${COMPOSE[*]} ps              # 状态"
echo "    ${COMPOSE[*]} logs -f backend # 日志"
echo "    ${COMPOSE[*]} restart backend # 重启"
echo "════════════════════════════════════════"
echo ""
