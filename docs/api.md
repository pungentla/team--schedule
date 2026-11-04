# 接口清单

Base URL：`http://<host>:3000/api`

## 通用约定

**认证**：除 `/health`、`/auth/login`、`/auth/register` 外，均需在请求头带 token：

```
Authorization: Bearer <token>
```

**成功响应**：

```json
{ "data": { ... } }
```

**失败响应**：

```json
{ "error": { "code": "BAD_REQUEST", "message": "参数不合法" } }
```

**错误码**：

| HTTP | code | 含义 |
|---|---|---|
| 400 | `BAD_REQUEST` | 参数校验失败 |
| 401 | `UNAUTHORIZED` | 未登录或 token 失效 |
| 403 | `FORBIDDEN` | 无权限（如员工访问管理员接口、非本人发起换班） |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT` | 状态冲突（如重复确认换班、班次冲突） |
| 422 | `UNPROCESSABLE` | 业务规则不满足 |

---

## 一、健康检查

### `GET /health`

无需认证。返回服务与 SQLite 版本，用于部署探活。

```json
{ "data": { "ok": true, "service": "teamshift-backend", "version": "1.0.0", "sqliteVersion": "3.47.2", "time": "..." } }
```

---

## 二、鉴权 `/auth`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/auth/register` | 公开 | 工号 + 姓名 + 密码 + 邀请码注册 |
| POST | `/auth/login` | 公开 | 登录，返回 token（30 天有效） |
| POST | `/auth/logout` | 登录 | 吊销当前 token |
| GET | `/auth/me` | 登录 | 当前用户信息 |
| POST | `/auth/password` | 登录 | 修改密码（会吊销全部会话） |

**登录请求**

```json
{ "employeeNo": "admin", "password": "123456" }
```

**登录响应**

```json
{
  "data": {
    "user": { "id": 1, "employeeNo": "admin", "name": "管理员", "role": "admin", "status": "active" },
    "token": "l8Eb92umWmtZoqfw...",
    "expiresAt": "2026-12-04T04:13:02.034Z"
  }
}
```

---

## 三、基础配置

### 工作类型 `/work-types`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/work-types` | 登录 | 列表 |
| POST | `/work-types` | 管理员 | 新建（code/name/color/sortOrder） |
| PUT | `/work-types/:id` | 管理员 | 修改 |

### 班次 `/shifts`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/shifts` | 登录 | 列表 |
| POST | `/shifts` | 管理员 | 新建（code/name/startTime/endTime/seq） |
| PUT | `/shifts/:id` | 管理员 | 修改 |

`seq` 决定班次先后顺序，用于"禁止连续班次"判断（如早班 seq=1、中班 seq=2）。

---

## 四、周期与需求 `/periods`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/periods` | 登录 | 周期列表（含报名数、需求数、已发布版本） |
| GET | `/periods/current` | 登录 | **当前周期**（按日期范围覆盖今天判定） |
| GET | `/periods/:id` | 登录 | 单周期详情 |
| POST | `/periods` | 管理员 | 新建周期 |
| PUT | `/periods/:id` | 管理员 | 修改；传 `status` 则走状态流转 |
| POST | `/periods/:id/status` | 管理员 | 显式状态流转 |
| POST | `/periods/:id/slots/generate` | 管理员 | 按日期 × 班次生成需求格子 |
| GET | `/periods/:id/requirements` | 登录 | 需求矩阵（`period/workTypes/shifts/dates/totalNeeded`） |
| PUT | `/periods/:id/requirements` | 管理员 | 批量设置需求人数，`items[]` |

**状态机**

```
draft → enrolling → scheduling → published → archived
         ↑____________|
```

`published` 只能进 `archived`（如需重排，把状态改回 `scheduling` 重新生成发布）。

> `GET /periods/current` 的判定口径：优先"日期范围覆盖今天"的周期，其次"最近一个未开始"，再其次"最近结束"，最后兜底最新一条。**不按 status 挑**——历史周期也是 `published`，按状态挑会错选中上一周。

---

## 五、报名 `/enrollments`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/enrollments/context/:periodId` | 登录 | 报名页所需上下文（可选工作类型、班次、日期、已有报名） |
| GET | `/enrollments/mine/:periodId` | 登录 | 我的报名详情 |
| POST | `/enrollments/:periodId` | 登录 | 提交/更新报名 |
| GET | `/enrollments/:periodId` | 管理员 | 全团队报名汇总 |

**提交报名**

```json
{
  "maxShifts": 6,
  "workTypes": [
    { "workTypeId": 1, "preference": 1 },
    { "workTypeId": 3, "preference": 2 }
  ],
  "availability": [
    { "workDate": "2026-11-05", "shiftId": 1 },
    { "workDate": "2026-11-05", "shiftId": 2 }
  ],
  "unavailableDates": ["2026-11-08"]
}
```

- `preference`：1 最想去 / 2 可以 / 3 凑合，影响评分加成
- `availability`：可工作的时间段（日期 + 班次）
- `unavailableDates`：整天不可用，优先级高于 availability

---

## 六、排班 `/schedule`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/schedule/periods/:periodId/generate` | 管理员 | 生成排班（写入 draft，可传 seed） |
| POST | `/schedule/periods/:periodId/publish` | 管理员 | 发布（可传 runId，不传则发最新草稿） |
| GET | `/schedule/periods/:periodId` | 登录 | 排班表（矩阵 + 缺口 + 指标），可传 `?runId=` |
| GET | `/schedule/mine` | 登录 | 我的全部班次（`?upcoming=1` 只看未来） |
| GET | `/schedule/dashboard` | 管理员 | 管理总览 |
| GET | `/schedule/periods/:periodId/input-preview` | 管理员 | 预览算法输入（调试用） |
| GET | `/schedule/assignments/:id/explain` | 管理员 | 某条分配的打分解释 |

### 生成排班

```json
{ "seed": 42 }
```

响应（节选）：

```json
{
  "data": {
    "runId": 2,
    "assignments": [{ "workDate": "2026-11-05", "shiftId": 1, "workTypeId": 1, "userId": 2 }],
    "gaps": { "totalNeeded": 91, "totalFilled": 91, "totalGap": 0, "fillRate": 1 },
    "metrics": { "fairnessScore": 0.72, "grade": "good", "perWorkType": [], "workload": {} },
    "stats": { "rounds": 4, "durationMs": 130 },
    "algoVersion": "1.0.0",
    "seed": 42,
    "inputHash": "f9cbb16d"
  }
}
```

### 排班表读取的版本选择规则

这是容易踩坑的点：

| 调用方 | 默认返回 |
|---|---|
| 指定 `runId` | 该 run（管理员预览历史草稿） |
| 管理员 | **优先最新草稿**，无草稿则已发布 |
| 员工 | **只返回已发布**，没有则 `run: null` |

> 为什么管理员优先草稿：生成后必须能立刻看到结果，否则无法判断是否发布。
> 为什么员工不能看草稿：草稿未生效，展示给员工会造成误导。

### 响应主体结构

```json
{
  "data": {
    "period": { "id": 2, "name": "本周排班", "startDate": "...", "endDate": "...", "status": "published" },
    "run": { "id": 2, "status": "published", "seed": 42, "totalFilled": 91, "fillRate": 1, "inputHash": "..." },
    "assignments": [{ "id": 62, "userId": 4, "name": "李娜", "employeeNo": "emp003", "workDate": "...", "shiftName": "早班", "workTypeName": "前台接待", "source": "algo" }],
    "myAssignments": [],
    "matrix": [
      { "workDate": "2026-11-05", "shifts": [
        { "shiftId": 1, "shiftName": "早班", "shiftSeq": 1, "workTypes": [
          { "workTypeId": 1, "workTypeName": "前台接待", "workTypeColor": "#4A90D9", "needCount": 2, "filled": 2, "gap": 0, "assigned": [{ "id": 62, "userId": 4, "name": "李娜" }] }
        ]}
      ]}
    ],
    "gaps": { "totalNeeded": 91, "totalFilled": 91, "totalGap": 0, "fillRate": 1, "byWorkType": [], "byDateShift": [], "byEmployee": [] },
    "metrics": { "perWorkType": [], "workload": {}, "fairnessScore": 0.72, "grade": "good" }
  }
}
```

**工号脱敏**：员工视角 `employeeNo` 形如 `e***3`，管理员视角为完整工号。

---

## 七、换班 `/swaps`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/swaps` | 登录 | 发起换班 |
| GET | `/swaps` | 登录 | 列表，`?scope=mine`（我发起）/ `inbox`（待我确认），可带 `?status=` |
| GET | `/swaps/pending-count` | 登录 | 待我确认数量 |
| GET | `/swaps/candidates/:assignmentId` | 登录 | 可接班候选人 + 每人冲突原因 |
| GET | `/swaps/:id` | 参与者或管理员 | 详情（含实时冲突预检 + 时间线） |
| POST | `/swaps/:id/confirm` | 参与者 | 同意 |
| POST | `/swaps/:id/reject` | 参与者 | 拒绝（可带 reason） |
| POST | `/swaps/:id/cancel` | 发起人 | 撤回 |

### 发起

```json
{
  "type": "transfer",
  "fromAssignmentId": 62,
  "toUserId": 4,
  "message": "临时有事"
}
```

`type`：
- `transfer`（转班）：只需 `toUserId`
- `exchange`（互换）：还需 `toAssignmentId`（对方的一条班次）

**响应**：返回完整详情 `{ swap, fromAssignment, toAssignment, participants, myDecision, canConfirm, liveProblems, timeline }`

```json
{
  "data": {
    "swap": { "id": 1, "type": "transfer", "status": "pending", "requesterId": 2, "toUserId": 4 },
    "myDecision": "approved",
    "canConfirm": true,
    "liveProblems": [],
    "participants": [{ "userId": 2, "role": "requester", "status": "approved" }, { "userId": 4, "role": "receiver", "status": "pending" }],
    "timeline": [{ "at": "...", "label": "发起申请" }]
  }
}
```

### 确认

```json
{ "data": { "applied": true, "status": "approved", "appliedAt": "2026-11-04T04:17:21.168Z", "appliedItems": [{ "...": "..." }] } }
```

- `applied: false` + `status: "pending"` → 还有其他人没确认，`waitingFor` 列出待确认者
- `applied: true` → 全员同意，已在事务内生效
- 重复确认 → `409 ALREADY_DECIDED`
- 生效时冲突 → `409 SWAP_CONFLICT`，整体回滚，状态退回 `pending` 可重试

---

## 八、统计 `/stats`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/stats/periods/:periodId` | 管理员 | 周期公平度详情 |
| GET | `/stats/employees/:userId` | 本人或管理员 | 个人跨周期工作分布 |
| GET | `/stats/me` | 登录 | 自己的分布 |

---

## 九、管理 `/admin`

整个分组需要管理员权限。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/users` | 员工列表（`?keyword=`、`?includeDisabled=0`） |
| PATCH | `/admin/users/:id` | 改姓名/角色/状态/手机号 |
| POST | `/admin/users/:id/password` | 重置密码 |
| GET | `/admin/invites` | 邀请码列表（含已用次数） |
| POST | `/admin/invites` | 生成邀请码（maxUses / expiresInDays） |
| GET | `/admin/audit-logs` | 审计日志（page / pageSize / periodId / action / actorId） |
| GET | `/admin/swaps` | 某周期全部换班（`?periodId=` 必填，`?status=`） |

**保护规则**：不允许把最后一个启用状态的管理员降级或停用（返回 `409 LAST_ADMIN`）。

---

## 十、审计动作枚举

以 `backend/src/repositories/auditRepo.js` 的 `ACTIONS` 为准：

| action | 含义 |
|---|---|
| `AUTH_REGISTER` / `AUTH_LOGIN` / `AUTH_LOGOUT` | 注册 / 登录 / 登出 |
| `USER_UPDATE` | 员工信息变更、重置密码 |
| `INVITE_CREATE` | 生成邀请码 |
| `WORK_TYPE_CREATE` / `WORK_TYPE_UPDATE` | 工作类型维护 |
| `SHIFT_CREATE` / `SHIFT_UPDATE` | 班次维护 |
| `PERIOD_CREATE` / `PERIOD_UPDATE` | 周期新建 / 修改 |
| `SLOTS_GENERATE` | 生成需求格子 |
| `REQUIREMENT_UPDATE` | 批量设置需求人数 |
| `ENROLL_SUBMIT` | 提交报名 |
| `SCHEDULE_GENERATE` | 生成排班 |
| `SCHEDULE_PUBLISH` | 发布排班 |
| `ASSIGNMENT_MANUAL` | 手工调整某条分配 |
| `SWAP_CREATE` / `SWAP_CONFIRM` / `SWAP_REJECT` / `SWAP_CANCEL` | 换班发起 / 同意 / 拒绝 / 撤回 |
| `SWAP_APPLY` | 换班全部同意后实际生效 |

> 生效失败（冲突回滚）时额外写入 `SWAP_APPLY_FAILED`，用于排查"为什么换班没成功"。
