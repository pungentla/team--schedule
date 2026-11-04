# 排班宝 TeamShift

团队轮值排班系统。解决的核心问题：**多工作类型 + 人数需求不一 + 员工可报名多个工作 + 要求轮转公平** 的排班问题，并支持排班后由员工自行协商换班。

包含三端：

| 端 | 目录 | 说明 |
|---|---|---|
| 后端 API | `backend/` | Node.js + Express + SQLite（内置 `node:sqlite`，零原生依赖） |
| 微信小程序 | `miniprogram/` | 原生 WXML/WXSS/JS，16 个页面，tabBar 三栏。AppID `wx2503b1cfbc7a04a0` |
| H5 预览 | `h5/` | 零依赖静态页 + API 代理，用于在浏览器快速验收 |

---

## 快速开始

```bash
# 1. 安装依赖（只有 express 一个）
npm install

# 2. 初始化数据库并灌入演示数据
npm run seed

# 3. 启动后端（默认 3000）
npm run dev

# 4. 另开一个终端，启动 H5 预览（默认 8080）
npm run h5

# 浏览器打开 http://127.0.0.1:8080
```

### 演示账号

| 角色 | 工号 | 密码 |
|---|---|---|
| 管理员 | `admin` | `123456` |
| 员工 | `emp001` ~ `emp020` | `123456` |

邀请码：`TEAM2025`（注册新员工时用）

### 常用命令

```bash
npm run seed      # 灌演示数据（幂等，已存在则跳过）
npm run reset     # 清库重灌（会删除所有数据）
npm run migrate   # 只跑建表迁移
npm test          # 后端单元测试（49 个）
npm run verify    # 业务闭环验收（55 项，需后端已启动）
npm run verify:mp # 小程序接口联调（24 项，按页面调用序列验证）
npm run test:mp   # 小程序地址解析逻辑测试（20 项）

# 用 Docker 一键起全栈（后端 + H5）
docker compose up -d --build
docker compose exec backend node scripts/seed.js
```

---

## 功能概览

### 员工侧

- **报名**：选工作时间段 + 可胜任的工作类型 + 意愿优先级 + 本周期最多接几个班
- **看排班**：按「日期 → 班次 → 工作类型」矩阵查看，自己的班次高亮
- **换班**：把自己的班转给同事，或与同事互换；双方确认后自动生效，无需管理员审批
- **我的**：我的班次列表、我的工作分布、发起/待确认的换班

### 管理员侧

- **周期管理**：建排班周期、生成需求格子、批量设需求人数
- **排班生成**：一键生成，看填充率与缺口，不满意可换种子重试，确认后发布
- **公平度指标**：每个工作类型的分配标准差、极差、分布条形图
- **基础配置**：工作类型、班次、员工、邀请码
- **审计日志**：所有关键操作留痕

---

## 排班算法

**目标**：在满足硬约束的前提下，让每个人的工作类型尽量轮转，同时工作量尽量均衡。

**两阶段**：

1. **贪心构造（MRV 启发式）**——优先安排"能接的人最少"的岗位，减少后面卡死的概率
2. **迭代优化**——用 Replace / PairSwap 邻域搜索反复尝试改进总评分，直到无改进或达轮数上限

**评分权重**（`backend/src/config.js`）：

```js
rotation: 60,          // 轮转：历史+本周期次数越少，得分越高（核心项）
balance: 25,           // 工作量均衡：本周期已排越多，得分越低
rarity: 12,            // 稀缺度：能胜任的人越少，越应优先满足
preference: {1:15, 2:8, 3:0},  // 意愿优先级加分
periodLoad: -6,        // 周期内已排惩罚
weekLoad: -3,          // 本周已排惩罚
```

**确定性**：同一份输入 + 同一个 seed，必然产生完全相同的排班结果（`inputHash` 一致）。这是可复现和可审计的基础。

**实测效果**（20 人 / 91 个岗位 / 5 种工作）：

| 指标 | 结果 |
|---|---|
| 填充率 | 100%（91/91） |
| 各工作类型分配标准差 | 0.43（人均 2.9 班，分布 2/2/2/2/2/2/1/1） |
| 公平度 | `fairnessScore`（平均轮转标准差）0.43 → 评级 **excellent** |

> 关键设计：轮转评分用 `历史次数 + 本周期已排次数` 而非仅历史次数，否则同一人会被反复排到同一工作。

细节见 [`docs/algorithm.md`](docs/algorithm.md)。

---

## 硬约束

排班时必须同时满足，任一不满足则该人不进入该岗位候选：

| 约束 | 说明 |
|---|---|
| H2 报名范围 | 只能排到他报名过的工作类型 |
| H3 不可用日期 | 整天不可用则跳过 |
| H4 可用时段 | 只能排在标记为可用的（日期 + 班次） |
| H5 每日上限 | 同一天最多 N 个班次（周期配置，默认 1） |
| H6 个人上限 | 不超过本人申报的周期最多班次数 |
| H7 每周上限 | 同一 ISO 周最多 N 个班次 |
| H8 禁止连班 | 不允许连续班次（如早班接中班） |
| H9 岗位占用 | 同一人同一时间只能占一个岗位 |

无法满足的岗位不会硬塞，而是进 **缺口报告**，并按原因归因（`no_candidate` / `overloaded` / `constraint_blocked` / `no_candidates_left`），方便管理员定向补人。

---

## 换班机制

```
发起人提交（transfer 转班 / exchange 互换）
  → 系统实时预检冲突（新持有人的上限、连班、同班次占用）
  → 对方确认
  → 全部参与者同意 → 事务内原子生效
  → 原分配置 released，新分配 source='swap'
```

- **无需管理员审批**，符合"员工协商通过即可"的诉求
- **失败回滚**：生效时若因期间他人被排班产生冲突，整体回滚，并把确认人状态退回 `pending`（可重试），同时写 `SWAP_APPLY_FAILED` 审计日志
- **换班不影响轮转公平**：被换走的 `released` 记录不计入历史次数

---

## 技术选型说明

| 决策 | 选择 | 理由 |
|---|---|---|
| SQLite 驱动 | Node 22 内置 `node:sqlite` | 零原生依赖，`npm install` 只需 2 秒；避免 node-gyp 编译失败 |
| 密码存储 | scrypt + salt | 比 bcrypt 少一个原生依赖，强度足够 |
| 会话 | 自管 `sessions` 表 + `sha256(token)` | 不用 JWT，支持服务端主动吊销 |
| 时区 | `Asia/Shanghai` + `Intl` 计算日期 | 避免 SQLite 的 `date('now')` 按 UTC 算导致差一天 |
| 唯一性 | 部分唯一索引 `WHERE status='active'` | 允许"草稿 + 已发布"共存，也允许换班后保留历史记录 |

---

## 目录结构

```
.
├── backend/
│   ├── src/
│   │   ├── config.js            # 枚举 + 评分权重
│   │   ├── db/
│   │   │   ├── schema.sql       # 18 张表 DDL
│   │   │   ├── db.js            # 唯一接触 node:sqlite 的封装
│   │   │   └── migrate.js       # 版本化迁移
│   │   ├── scheduler/           # 排班算法
│   │   │   ├── constraints.js   # 硬约束检查
│   │   │   ├── scoring.js       # 评分函数
│   │   │   ├── gapReport.js     # 缺口归因
│   │   │   ├── metrics.js       # 公平度指标
│   │   │   └── index.js         # 贪心 + 迭代优化主流程
│   │   ├── services/            # 业务编排
│   │   ├── repositories/        # 数据访问
│   │   ├── routes/              # HTTP 路由
│   │   └── middleware/
│   ├── scripts/
│   │   ├── seed.js              # 演示数据
│   │   └── verify-e2e.js        # 端到端验收
│   └── test/                    # 39 个单元测试
├── miniprogram/                 # 微信小程序
├── h5/                          # H5 预览
└── docs/
    ├── api.md                   # 接口清单
    ├── algorithm.md             # 算法详解
    ├── schema.md                # 数据模型
    ├── deployment.md            # 小程序上线配置指南
    ├── trial-guide.md           # 给同事试用的操作指南
    ├── production-setup.md      # 生产部署完整指南
    └── screenshots/             # 验收截图
```

---

## 生产部署（轻量云服务器 + Docker）

```bash
# 服务器上（Ubuntu 22.04+）
git clone <你的仓库> /opt/teamshift && cd /opt/teamshift
cp .env.production.example .env.production && nano .env.production   # 填域名和邮箱
./deploy/deploy.sh            # 自动申请证书 + 构建 + 启动 + 冒烟测试
```

脚本会自动完成：环境自检 → Let's Encrypt 证书 → 构建镜像 → 启动 Nginx + 后端 → 验证 HTTPS。

**运维命令**：

```bash
./deploy/backup.sh                 # 备份（建议 cron 每天）
./deploy/restore.sh                # 恢复（自动校验备份完整性）
docker compose -f docker-compose.prod.yml ps      # 状态
docker compose -f docker-compose.prod.yml logs -f backend
```

完整步骤（服务器选型、防火墙、备案、证书续期、排查）见 [`docs/production-setup.md`](docs/production-setup.md)。

**内置安全措施**：

| 措施 | 说明 |
|---|---|
| 双层登录限流 | 单 IP 总量 + IP&工号组合，换工号也绕不过 |
| 全局限流 | 300 次/分钟/IP |
| 后端不暴露公网 | 仅 `expose`，只让 Nginx 访问 |
| 安全响应头 | HSTS / nosniff / X-Frame-Options |

## 界面截图

| 截图 | 说明 |
|---|---|
| [`01-login.png`](docs/screenshots/01-login.png) | 登录页 |
| [`02-schedule-matrix.png`](docs/screenshots/02-schedule-matrix.png) | 排班矩阵（日期 → 班次 → 工作类型 → 人员） |
| [`03-admin-dashboard.png`](docs/screenshots/03-admin-dashboard.png) | 管理后台（统计卡 / 生成发布 / 公平度 / 换班 / 审计） |
| [`04-metrics.png`](docs/screenshots/04-metrics.png) | 公平度指标条形图 |
| [`06-employee-view.png`](docs/screenshots/06-employee-view.png) | 员工视角（无管理入口，工号脱敏） |

## 验收记录

| 项目 | 结果 |
|---|---|
| 后端单元测试 | 49 / 49 通过（含 10 项限流测试） |
| 业务闭环验收 | 55 / 55 项通过（含登录、生成、发布、换班闭环、脱敏、审计） |
| 小程序接口联调 | 24 / 24 项通过（按 16 个页面的真实调用序列） |
| 小程序地址逻辑 | 20 / 20 项通过（模拟 wx 环境，含穿透域名场景） |
| Docker 镜像 | 构建通过，容器内 55 项验收 + 24 项联调全通过（healthy） |
| 备份恢复 | 实做过损坏→备份→恢复演练，数据完整还原 |
| 限流 | 实测单账号第 6 次拦截、IP 维度换工号仍被拦 |
| 排班确定性 | 同 seed 两次生成 `inputHash` 一致，91 条分配逐条相同 |
| 填充率 | 100%（20 人 / 91 岗位） |
| H5 全流程 | 管理员与员工两视角均走通，控制台零报错 |

---

## 已知边界

- 排班算法是启发式，**不保证全局最优**；对更大规模（如 200 人以上）建议先增大迭代轮数观察效果
- 微信小程序已接入真实 AppID `wx2503b1cfbc7a04a0`。**正式版需 HTTPS + 备案域名 + 后台配置 request 合法域名**，详见 [`docs/deployment.md`](docs/deployment.md)
- 项目不收集用户隐私信息（未使用 `wx.login` / 手机号授权 / 位置 / 相册），无需配置隐私保护指引
- H5 预览仅用于开发验收，**不是生产前端**，未做 CSRF/限流等加固
- 数据库为单体 SQLite，适合单团队（几十到几百人）；多团队多租户需另做隔离设计
