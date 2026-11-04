# 接口清单

Base URL：部署后为 `http://服务器IP/api`；本地后端直连为 `http://<host>:3000/api`。页面使用说明见 [H5 使用指南](h5-usage.md)。

文中的管理员权限包含 `admin` 和 `super_admin`；仅标注超级管理员的操作要求 `super_admin`。

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

`published` 的显式状态变更只能进入 `archived`；需要重排时直接生成新草稿、检查并发布，原生效版本在新草稿发布前保留。

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
    { "workTypeId": 1, "priority": 1, "dutyRole": "member" },
    { "workTypeId": 3, "priority": 2, "dutyRole": "primary" }
  ],
  "availability": [
    { "workDate": "2026-11-05", "shiftId": 1 },
    { "workDate": "2026-11-05", "shiftId": 2 }
  ],
  "unavailability": [{ "workDate": "2026-11-08", "reason": "请假" }],
  "submit": true
}
```

- `priority`：1 最想去 / 2 可以 / 3 凑合，影响评分加成
- `dutyRole`：普通工作用 member；主副工作用 primary / deputy / both
- `submit`：false 保存草稿；默认 true 正式提交
- `maxShifts`：null 不限，0 本期不接班
- `availability`：可工作的时间段（日期 + 班次）
- `unavailability`：整天不可用，优先级高于 availability

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

整个分组需要管理员权限。普通管理员仅可创建、修改、重置员工账号；超级管理员可管理管理员和员工。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/admin/users` | 创建账号（employeeNo/name/password/role/phone） |
| GET | `/admin/users` | 人员列表（`?keyword=`、`?includeDisabled=0`） |
| PATCH | `/admin/users/:id` | 改账号/姓名/角色/状态/手机号 |
| POST | `/admin/users/:id/password` | 重置密码 |
| GET | `/admin/invites` | 邀请码列表（含已用次数） |
| POST | `/admin/invites` | 生成邀请码（maxUses / expiresInDays） |
| GET | `/admin/audit-logs` | 审计日志（page / pageSize / periodId / action / actorId） |
| GET | `/admin/swaps` | 某周期全部换班（`?periodId=` 必填，`?status=`） |

**保护规则**：超级管理员不可降级或停用，不能修改其他超级管理员账号。修改账号、角色、状态或重置密码会吊销该账号所有会话。

---

## 十、审计动作枚举

以 `backend/src/repositories/auditRepo.js` 的 `ACTIONS` 为准：

| action | 含义 |
|---|---|
| `AUTH_REGISTER` / `AUTH_LOGIN` / `AUTH_LOGOUT` | 注册 / 登录 / 登出 |
| `AUTH_PASSWORD_CHANGE` | 本人改密 |
| `USER_UPDATE` | 员工信息变更、重置密码 |
| `INVITE_CREATE` | 生成邀请码 |
| `WORK_TYPE_CREATE` / `WORK_TYPE_UPDATE` | 工作类型维护 |
| `SHIFT_CREATE` / `SHIFT_UPDATE` | 班次维护 |
| `PERIOD_CREATE` / `PERIOD_UPDATE` | 周期新建 / 修改 |
| `PERIOD_DELETE` / `PERIOD_RESTORE` | 周期删除 / 恢复 |
| `SLOTS_GENERATE` | 生成需求格子 |
| `REQUIREMENT_UPDATE` | 批量设置需求人数 |
| `ENROLL_SUBMIT` | 提交报名 |
| `SCHEDULE_GENERATE` | 生成排班 |
| `SCHEDULE_PUBLISH` | 发布排班 |
| `ASSIGNMENT_MANUAL` | 手工调整某条分配 |
| `SWAP_CREATE` / `SWAP_CONFIRM` / `SWAP_REJECT` / `SWAP_CANCEL` | 换班发起 / 同意 / 拒绝 / 撤回 |
| `SWAP_APPLY` | 换班全部同意后实际生效 |

> 生效失败（冲突回滚）时额外写入 `SWAP_APPLY_FAILED`，用于排查"为什么换班没成功"。

## 扩展配置与排班操作

- 工作配置新增 `requiresRoles`、`weekdays`（0=周日，1–6=周一至周六）、`defaultNeed` 和 `weeklyAssignments:[{weekday,shiftId,userId,dutyRole}]`。长期名单可包含所有启用角色；主副工作每班需求为 0 或至少 2 人，发布时必须覆盖主、副各一人。
- 新建周期支持 `workTypeIds`、`shiftIds`（明确选择时各至少一项）与 `initializeRequirements:true`，创建时原子初始化所选项目的默认需求；周期最长 366 天。未传选择时保持旧客户端的全部启用项行为。
- 所有启用角色均可本人报名或进入固定名单；生成仍检查工作资格、主副角色、可用时间、请假和班次上限。提交个人草稿不会改变有效报名。
- 排班返回 `dutyRole`、主副缺口和固定人员冲突；管理员可用 `version=draft` 或 `version=published` 指定视图。员工仅可读取已发布版本。

| 方法与路径（前缀 /api） | 行为 |
|---|---|
| GET /periods/range | 管理员；startDate 与 duration=week/month/bimonth/quarter/halfyear/year，计算周期结束日期 |
| GET /periods/:id/preparation | 管理员；就绪状态、参与人员与下一步 |
| POST /periods/:id/prepare | 管理员；补齐未准备的班次需求，保留已有手工人数和 0 |
| POST /periods/:id/requirements/apply-rules | 管理员；按默认工作日、人数和固定名单重新填充 |
| GET /schedule/runs/:runId/candidates | 管理员；assignmentId，或 workDate/shiftId/workTypeId/dutyRole 指定草稿岗位 |
| POST /schedule/runs/:runId/adjust | 管理员；action=add/replace/remove、岗位目标、userId、revision，手工调配草稿 |
| POST /schedule/reassign | 管理员；type=transfer/exchange、fromAssignmentId、toUserId，互换还需 toAssignmentId；已发布排班立即调配，无需员工确认 |

发布可携带 `revision`、`publishedRunId`、`publishedRevision`，防止检查期间草稿或生效版本变化。需求、报名或有效配置变化后，旧草稿须重新生成。

## 代报名、近期安排与周期回收站


所有接口需 Bearer 登录令牌，成功返回 `{data}`，错误返回 `{error:{code,message}}`。

| 方法与路径（前缀 /api） | 权限与行为 |
|---|---|
| GET /enrollments/:periodId/users/:userId | 管理员：目标人员、报名上下文与已有报名 |
| POST /enrollments/:periodId/users/:userId | 管理员代报：`{workTypes:[{workTypeId,priority,dutyRole}]}`；角色为 member / primary / deputy / both，须符合工作配置；直接提交并保留原个人限制，已发布或归档周期锁定 |
| GET /schedule/mine/recent | 所有用户，本人身份取自登录态；`days` 默认 7，或 `startDate`、`endDate`（YYYY-MM-DD，最多 366 天）；返回日期范围、assignments 及各项 coworkers（userId、name、dutyRole） |
| DELETE /periods/:id | 管理员、超级管理员：软删除，返回 `{id,deleted:true}`，重复操作幂等 |
| GET /periods/deleted | 仅超级管理员：回收站周期、原状态、deletedAt、deletedBy、deletedByName |
| POST /periods/:id/restore | 仅超级管理员：恢复原周期 DTO，重复操作幂等；不自动重新生成或发布 |

数据库版本 v7，periods 新增可空 deleted_at、deleted_by。既有数据迁移后默认可见；删除不会改变关联数据或版本状态。

`POST /auth/password` 请求 `{oldPassword,newPassword}`。原密码须正确，新密码为 6–128 位且不能与原密码相同；更新密码与撤销本人全部会话处于同一事务。返回 `{data:{ok:true}}` 后当前令牌也失效，客户端返回登录页。审计不保存密码。
