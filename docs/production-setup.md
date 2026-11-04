# 生产部署：轻量云服务器 + Docker

面向：**1–100 人的团队排班**，单机部署，月成本约 ¥30–60。

---

## 一、买什么

### 配置要求

| 项目 | 最低 | 推荐 | 说明 |
|---|---|---|---|
| CPU | 1 核 | 2 核 | 排班算法 91 岗位约 130ms，1 核算得动 |
| 内存 | 1 GB | 2 GB | Node + Nginx 实际占用约 200MB |
| 磁盘 | 20 GB | 40 GB | 数据库不到 1MB，日志和备份占大头 |
| 带宽 | 1 Mbps | 3 Mbps | 只传 JSON，单次响应几 KB |
| 系统 | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS | 脚本按 Debian 系写，CentOS 需微调 |
| 地域 | — | 选离团队近的 | 国内团队选国内节点 |

### 厂商选择

阿里云轻量应用服务器、腾讯云轻量、华为云耀，都行，配置一样。按年付通常有折扣。

IP 部署无需购买域名或等待 DNS、证书，浏览器直接访问 `http://服务器IP`。

### 可选：域名 HTTPS / 小程序正式版

1. **域名**（约 ¥50–80/年）：阿里云/腾讯云都能买
2. **ICP 备案**（免费，但需 7–20 个工作日）：在服务器厂商的控制台提交

这些不是 IP 部署的前置条件。微信小程序正式版的合法域名要求见 [小程序上线配置指南](deployment.md)，本次改动不改变平台限制。

---

## 二、服务器初始化

以 Ubuntu 22.04 为例，SSH 登录后依次执行：

### 2.1 创建非 root 用户（安全基线）

```bash
adduser deploy
usermod -aG sudo deploy
usermod -aG docker deploy      # 稍后装了 docker 再加

# 复制你的 SSH 公钥给新用户
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

之后用 `ssh deploy@你的IP` 登录，**不要用 root 直接跑服务**。

### 2.2 基础安全

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 防火墙：SSH / HTTP；仅 HTTPS 模式需要 443
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
# sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status

# 自动安全更新
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

云控制台的安全组也需放行 TCP 80（HTTPS 模式另放行 443）。**别开 3000 端口**：后端只在 Docker 内网暴露，由 Nginx 统一转发并传递客户端 IP。

### 2.3 安装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker            # 让组权限立即生效

docker --version
docker compose version
```

### 2.4 时间同步（重要）

排班严重依赖日期计算，服务器时间错了会算错周期：

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true
timedatectl status
```

---

## 三、部署

### 3.1 拉代码

```bash
cd /opt
sudo git clone <你的仓库地址> teamshift
sudo chown -R $USER:$USER /opt/teamshift
cd /opt/teamshift
```

没有 Git 仓库的话，用 `scp` 把整个目录传上去也行：

```bash
# 在你本地执行
scp -r ./teamshift deploy@服务器IP:/opt/
```

### 3.2 配置环境变量

```bash
cp .env.production.example .env.production
nano .env.production
```

默认即可通过 IP 部署，不必填写域名和邮箱。可选填写公网 IP，用于部署完成后的地址提示：

```ini
DEPLOY_SCHEME=http
SERVER_IP=你的服务器公网IP
DOMAIN=
CERT_EMAIL=
```

### 3.3 可选：启用域名 HTTPS

只通过 IP 访问时跳过本节。需要 HTTPS 时改为：

```ini
DEPLOY_SCHEME=https
DOMAIN=shift.yourcompany.com
CERT_EMAIL=admin@yourcompany.com
```

到域名服务商添加 A 记录：

| 类型 | 主机记录 | 记录值 |
|---|---|---|
| A | `shift`（或 `@`） | 你的服务器公网 IP |

等 5–10 分钟生效，用 `ping shift.yourcompany.com` 确认解析到你的 IP。

### 3.4 一键部署

```bash
./deploy/deploy.sh
```

脚本会：

1. 检查 Docker、端口占用（仅 HTTPS 模式检查域名解析）
2. HTTP 模式跳过证书；HTTPS 模式用 Let's Encrypt 申请证书
3. 构建镜像并启动 Nginx + 后端
4. 从服务器本机经 Nginx 验证 API 健康检查和 H5 首页

看到 `部署完成` 后，从电脑或手机浏览器打开 **`http://服务器IP`**，确认公网可达；健康检查为 `http://服务器IP/health`，API 为 `http://服务器IP/api`。HTTP 模式不会跳转 HTTPS，也不需要证书。

HTTP 会明文传输账号和登录令牌，请在可信网络使用；公网敏感使用建议启用 HTTPS。首次部署需要按下一节创建账号才能登录。

从旧配置升级时，即使已填写 `DOMAIN`，未设置 `DEPLOY_SCHEME` 也默认使用 HTTP；希望继续使用 HTTPS 的环境请明确设置 `DEPLOY_SCHEME=https`。直接执行 Compose 时也要带 `--env-file .env.production`，确保访问方式一致。

### 3.5 建账号

**二选一：**

```bash
# 选项 A：灌演示数据（含 admin/123456、emp001~020/123456、邀请码 TEAM2025）
docker compose -f docker-compose.prod.yml --env-file .env.production exec backend node scripts/seed.js

# 选项 B：生产模式，只建一个超级管理员，之后在账号管理中创建管理员和员工，也可用邀请码注册员工
docker compose -f docker-compose.prod.yml --env-file .env.production exec backend node -e "
const userRepo = require('./src/repositories/userRepo');
const { hashPasswordSync } = require('./src/utils/security');
const pwd = process.argv[1];
userRepo.insertUser({
  employeeNo: 'admin',
  name: '超级管理员',
  passwordHash: hashPasswordSync(pwd),
  role: 'super_admin',
  phone: null,
});
console.log('管理员已创建，密码:', pwd);
" '你的强密码'
```

> 生产环境**别用 123456**。选项 B 的密码自己定，建议 12 位以上。

---

## 四、配置小程序

浏览器通过 IP 访问不需要本节。以下仅针对使用 HTTPS 合法域名的小程序正式版；IP 部署不能解除微信平台的域名校验要求。

两处要改：

**1. 填线上地址** —— `miniprogram/config/env.js`

```js
const PROD_URL = 'https://shift.yourcompany.com';   // 不带 /api
```

**2. 后台配合法域名** —— 小程序管理后台

开发 → 开发管理 → 开发设置 → 服务器域名 → request 合法域名，填 `https://shift.yourcompany.com`

然后上传代码 → 提审 → 发布。

---

## 五、日常运维

### 常用命令

```bash
cd /opt/teamshift
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

$COMPOSE ps                    # 服务状态（应为 healthy）
$COMPOSE logs -f backend       # 实时日志
$COMPOSE logs --tail=50 nginx  # Nginx 日志
$COMPOSE restart backend       # 重启后端
$COMPOSE down                  # 停止全部
$COMPOSE up -d                 # 启动全部
```

HTTPS 环境手动执行 Compose 时，请在 `-f docker-compose.prod.yml` 后追加 `-f docker-compose.https.yml`，以映射 443 端口；一键部署脚本会自动添加。

### 更新代码

```bash
cd /opt/teamshift
git pull
./deploy/deploy.sh
```

数据库不会受影响（在 `./data` 目录）。

### 备份（强烈建议）

```bash
# 手动备份
./deploy/backup.sh

# 定时备份：每天凌晨 3 点
crontab -e
```

加入：

```cron
0 3 * * * /opt/teamshift/deploy/backup.sh >> /var/log/teamshift-backup.log 2>&1
```

备份默认保留 14 天，存在 `backups/`。**建议再同步到别处**（对象存储、另一台机器），否则服务器挂了备份也一起没了。

```bash
# 例：每天同步到阿里云 OSS（需装 ossutil）
30 3 * * * ossutil cp -r /opt/teamshift/backups oss://your-bucket/teamshift/ --update
```

### 恢复

```bash
./deploy/restore.sh                              # 用最新备份
./deploy/restore.sh backups/teamshift_xxx.db     # 指定备份
```

脚本会先校验备份完整性，再把当前库另存为 `.before-restore-时间戳`，恢复错了能回退。

> ⚠️ **恢复必须先删 `app.db-wal`**。本项目用 WAL 模式，旧的 WAL 日志会污染新库。脚本已处理，手动操作时别忘。

### 证书续期

仅 HTTPS 模式需要；HTTP/IP 模式跳过。

Let's Encrypt 证书 90 天到期。加个定时任务自动续：

```bash
crontab -e

# 每月 1 号凌晨 4 点尝试续期，续完重载 Nginx
0 4 1 * * cd /opt/teamshift && docker compose -f docker-compose.prod.yml --env-file .env.production run --rm certbot renew --webroot -w /var/www/certbot && docker compose -f docker-compose.prod.yml --env-file .env.production exec nginx nginx -s reload
```

---

## 六、安全加固清单

| 项 | 做法 | 状态 |
|---|---|---|
| 非 root 运行 | 用 `deploy` 用户 | 部署时做 |
| 防火墙 | 只开 22/80/443 | 第二节 |
| 后端不暴露 | compose 里用 `expose` 不用 `ports` | 已配 |
| 登录限流 | 双层限流（IP + IP&工号） | 已内置 |
| 全局限流 | 300 次/分钟/IP | 已内置 |
| 安全响应头 | nosniff / DENY；HSTS 仅 HTTPS 模式 | 已内置 |
| 密码强度 | 管理员用 12 位以上 | 你做 |
| SSH 密钥登录 | 禁用密码登录 | 建议做 |
| 定期备份 | cron 每天 | 你做 |

### 禁用 SSH 密码登录（可选但推荐）

```bash
sudo nano /etc/ssh/sshd_config
# 改成：
# PasswordAuthentication no
# PubkeyAuthentication yes

sudo systemctl restart ssh
```

**改之前先确认你的密钥能登录**，否则会把自己锁在外面。

---

## 七、排查

| 现象 | 排查 |
|---|---|
| `deploy.sh` 报证书申请失败 | 域名解析未生效 / 80 端口被占 / 域名未备案 |
| 浏览器访问 IP 超时 | 云安全组和防火墙是否放行 TCP 80；确认填写服务器公网 IP |
| 浏览器访问 IP / 域名 502 | `docker compose -f docker-compose.prod.yml --env-file .env.production logs nginx`，多半是后端没起 |
| 502 且后端 healthy | Nginx 里 `proxy_pass http://backend:3000` 服务名是否对得上 |
| 小程序报「不在合法域名列表」 | 后台没配或配错，必须 `https://` 前缀 |
| 小程序报证书错误 | 证书链不完整，确认用的是 `fullchain.pem` |
| 登录提示限流 | 正常保护机制，等 10 分钟；生产可调 `RATE_LIMIT_LOGIN_PER_10MIN` |
| 数据突然空了 | 检查是否误挂载卷，`docker compose ps` 看映射；从备份恢复 |
| 排班日期差一天 | 容器 TZ 没生效，检查 `docker exec teamshift-backend date` |

### 快速健康检查

```bash
# 1. 容器
docker compose -f docker-compose.prod.yml --env-file .env.production ps

# 2. 后端直连（容器内网）
docker compose -f docker-compose.prod.yml --env-file .env.production exec backend \
  node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(d=>console.log(d))"

# 3. 经 Nginx
curl -fsS http://你的服务器IP/api/health

# 4. 容器时间
docker exec teamshift-backend date
```

---

## 八、成本估算

| 项目 | 年成本 |
|---|---|
| 轻量服务器 2核2G | ¥300–600 |
| 域名（可选） | ¥50–80 |
| ICP 备案（域名方案） | 免费 |
| HTTPS 证书（可选） | 免费（Let's Encrypt） |
| **IP 部署合计** | **约 ¥300–600/年** |

> 团队 10 人以内用 1核2G 也够，能再省一半。
