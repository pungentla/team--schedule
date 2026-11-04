# 数据模型

数据库：SQLite（Node 22 内置 `node:sqlite`），DDL 见 `backend/src/db/schema.sql`，共 **18 张表**。

迁移用 `PRAGMA user_version` 版本化，当前版本 `1`（`backend/src/db/migrate.js`）。

---

## 一、关系总览

```
roles ──< users ──< sessions
              │
              ├──< invites (created_by)
              │
              └──< enrollments ──< enrollment_work_types
                        │        └──< availability_slots
                        │        └──< unavailability_dates
                        │
periods ──< period_slots
    │    └──< slot_requirements ──> work_types / shifts
    │
    ├──< schedule_runs ──< assignments ──> users / shifts / work_types
    │
    └──< swap_requests ──< swap_participants
                  └──> assignments (from / to)

audit_logs ──> (多态关联 entity_type + entity_id)
```

---

## 二、基础字典

### `roles`

角色定义表。当前只有 `admin` / `employee` 两个角色，但保留表结构便于扩展。

### `work_types`

工作类型（如前台接待、后厨帮工）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `code` | TEXT UNIQUE | 唯一编码，如 `FRONT` |
| `name` | TEXT | 显示名 |
| `description` | TEXT | 描述 |
| `color` | TEXT | 展示色，如 `#4A90D9` |
| `sort_order` | INTEGER | 排序 |
| `active` | INTEGER | 0/1，停用后不影响历史数据 |

### `shifts`

班次（早班 / 中班 / 晚班）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | TEXT UNIQUE | 如 `S1` |
| `name` | TEXT | 如「早班」 |
| `start_time` / `end_time` | TEXT | `HH:MM` |
| `seq` | INTEGER | **顺序号，用于禁止连班判断** |
| `color` | TEXT | |
| `active` | INTEGER | |

> `seq` 是关键字段：早班 seq=1、中班 seq=2、晚班 seq=3。禁止连班时判断 `|seqA − seqB| === 1`。

---

## 三、人员

### `users`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `employee_no` | TEXT UNIQUE | 工号，登录用 |
| `name` | TEXT | 姓名 |
| `password_hash` | TEXT | `scrypt$N$r$p$saltHex$hashHex` |
| `role` | TEXT | `admin` / `employee` |
| `phone` | TEXT | 可空 |
| `status` | TEXT | `active` / `disabled` |

**安全约束**：不允许把最后一个 `active` 的管理员降级或停用（服务层校验，返回 `409 LAST_ADMIN`）。

### `sessions`

自管会话表，不用 JWT。

| 字段 | 说明 |
|---|---|
| `token_hash` | `sha256(token)`，**库中不存明文 token** |
| `user_id` | 外键 |
| `expires_at` | 过期时间（默认 30 天） |
| `revoked_at` | 吊销时间，非空即失效 |

### `invites`

注册邀请码。

| 字段 | 说明 |
|---|---|
| `code` | 唯一邀请码，如 `TEAM2025` |
| `max_uses` / `used_count` | 可用次数 / 已用次数 |
| `expires_at` | 过期时间 |
| `created_by` | 创建人 |

---

## 四、周期与需求

### `periods`

一个排班周期（通常一周）。

| 字段 | 说明 |
|---|---|
| `name` | 如「本周排班 11-05 ~ 11-11」 |
| `start_date` / `end_date` | `YYYY-MM-DD` |
| `max_shifts_per_day` | 每日最多班次（约束 H5） |
| `max_shifts_per_week` | 每周最多班次（约束 H7） |
| `forbid_consecutive` | 是否禁止连班（约束 H8） |
| `status` | `draft` / `enrolling` / `scheduling` / `published` / `archived` |
| `enrollment_deadline` | 报名截止日 |

> **当前周期的判定不依赖 status**，而是看 `start_date <= today <= end_date`。原因：历史周期也是 `published`，按状态挑会命中旧周期。

### `period_slots`

周期内可用的（日期 × 班次）组合，是需求格子的容器。

`UNIQUE(period_id, work_date, shift_id)`

### `slot_requirements`

需求人数配置，排班的直接输入。

| 字段 | 说明 |
|---|---|
| `period_id` / `work_date` / `shift_id` / `work_type_id` | 四元组定位一个岗位 |
| `need_count` | 需要几个人 |

`UNIQUE(period_id, work_date, shift_id, work_type_id)`

> 91 个岗位 = 7 天 × 3 班次 × 若干工作类型（按需求人数求和）

---

## 五、报名

### `enrollments`

每人每周期一条报名记录。

| 字段 | 说明 |
|---|---|
| `period_id` / `user_id` | 唯一组合 |
| `max_shifts` | 本人本周期最多接几个班（约束 H6） |
| `status` | `draft` / `submitted` |

### `enrollment_work_types`

报名的工作类型 + 意愿优先级。

| 字段 | 说明 |
|---|---|
| `enrollment_id` / `work_type_id` | 唯一组合 |
| `preference` | 1 最想去 / 2 可以 / 3 凑合 |

### `availability_slots`

可工作的时间段。

| 字段 | 说明 |
|---|---|
| `enrollment_id` / `work_date` / `shift_id` | 唯一组合 |

### `unavailability_dates`

整天不可用的日期。**优先级高于 availability**——即使那天有可用时段，也会被跳过。

---

## 六、排班结果

### `schedule_runs`

一次排班生成的完整快照。

| 字段 | 说明 |
|---|---|
| `period_id` | 所属周期 |
| `algo_version` | 算法版本，如 `1.0.0` |
| `seed` | 随机种子 |
| `input_hash` | 输入哈希（FNV-1a），用于验证"是否同一份输入" |
| `status` | `draft` / `published` / `discarded` |
| `total_needed` / `total_filled` / `fill_rate` | 需求数 / 已排数 / 填充率 |
| `metrics_json` | 公平度指标快照（JSON） |
| `gaps_json` | 缺口报告快照（JSON） |
| `rounds` / `duration_ms` | 优化轮数 / 耗时 |
| `created_by` | 生成人 |

**关键索引**：

```sql
-- 一个周期最多一个已发布版本
CREATE UNIQUE INDEX uq_runs_one_published
  ON schedule_runs(period_id) WHERE status = 'published';
```

### `assignments`

一条分配 = 某人在某天某班次做某个工作。

| 字段 | 说明 |
|---|---|
| `run_id` | 所属排班版本 |
| `period_id` | 冗余字段，便于按周期查询 |
| `work_date` / `shift_id` / `work_type_id` / `user_id` | 定位 |
| `status` | `active` / `released` |
| `source` | `algo`（算法排的）/ `swap`（换班产生的）/ `manual` |
| `released_at` | 释放时间 |

**关键索引（踩过坑）**：

```sql
CREATE UNIQUE INDEX uq_assignment_active_person_slot
  ON assignments(run_id, user_id, work_date, shift_id) WHERE status = 'active';
```

> 为什么按 `run_id` 而不是 `period_id`：同一周期可能同时存在 draft 和 published 两套 run，如果用 `period_id` 建唯一索引，两套 run 的分配会互相冲突，插入时报 `UNIQUE constraint failed`。
>
> 为什么加 `WHERE status='active'`：换班后原分配变成 `released`，必须允许"同一人同一班次"存在一条 released + 一条 active 的历史记录。

---

## 七、换班

### `swap_requests`

| 字段 | 说明 |
|---|---|
| `period_id` | 所属周期 |
| `type` | `transfer`（转班）/ `exchange`（互换） |
| `from_assignment_id` | 转出的班次 |
| `to_assignment_id` | 互换时对方的班次（transfer 为 null） |
| `requester_id` / `to_user_id` | 发起人 / 接收人 |
| `status` | `pending` / `approved` / `rejected` / `cancelled` |
| `message` | 备注 |
| `decided_at` / `applied_at` | 决策时间 / 生效时间 |

### `swap_participants`

参与者逐人确认状态（支持未来扩展多人协商）。

| 字段 | 说明 |
|---|---|
| `swap_id` / `user_id` | |
| `role` | `requester` / `receiver` |
| `seq` | 确认顺序 |
| `status` | `pending` / `approved` / `rejected` |
| `decided_at` | |

**状态机**：

```
创建 → requester 直接 approved，receiver pending
     → receiver 确认
        ├─ 全部 approved → 事务内 applySwap → swap.status=approved, applied_at 落时间
        └─ 有人 rejected → swap.status=rejected
     → requester 可 cancel（仅 pending 时）
```

**生效失败处理**：`applySwap` 在事务内执行，若冲突（如期间别人被排到该班次）则整体回滚，把确认人状态退回 `pending`、`decided_at=NULL`，并写 `SWAP_APPLY_FAILED` 审计日志。**这样用户可以重试**——早期没做这个回退，会导致换班"卡死"（既不能重试也不能重新确认）。

---

## 八、审计

### `audit_logs`

| 字段 | 说明 |
|---|---|
| `action` | 动作码，见 `auditRepo.ACTIONS` |
| `entity_type` / `entity_id` | 多态关联，如 `('swap', 1)` |
| `period_id` | 可空，便于按周期筛 |
| `actor_id` | 操作人 |
| `detail_json` | 动作详情快照 |
| `request_id` | 请求追踪 ID，便于串联一次请求的所有日志 |
| `created_at` | |

日志写入失败**不抛错**（只在控制台记录），避免审计故障阻断主业务。

---

## 九、索引清单

| 索引 | 表 | 用途 |
|---|---|---|
| `uq_runs_one_published` | schedule_runs | 一周期一发布版本 |
| `uq_assignment_active_person_slot` | assignments | 防同一人同班次重复占用 |
| `idx_assignment_period_date` | assignments | 按周期+日期查（排班表） |
| `idx_assignment_user` | assignments | 我的排班 |
| `idx_assignment_run` | assignments | 按版本读全部 |
| `idx_assignment_worktype` | assignments | 工作分布统计 |
| `idx_avail_lookup` / `idx_unavail_lookup` | 报名子表 | 算法加载可用性 |
| `idx_req_period` | slot_requirements | 读需求 |
| `idx_swaps_to_user` | swap_requests | 待我确认 |
| `idx_audit_action` / `idx_audit_period` | audit_logs | 日志筛选 |

---

## 十、连接配置

`backend/src/db/db.js` 在 `open()` 时执行：

```sql
PRAGMA foreign_keys = ON;      -- 外键强制（否则约束形同虚设）
PRAGMA journal_mode = WAL;     -- 读写并发
PRAGMA busy_timeout = 3000;    -- 锁等待 3 秒
PRAGMA synchronous = NORMAL;   -- WAL 下的安全/性能平衡
```

**驱动层注意事项**：`node:sqlite` 的 `DatabaseSync` **不接受 `undefined` / `boolean` / `bigint` 参数**，会直接抛 `ERR_SQLITE_ERROR`。`db.js` 里做了统一规整：

```js
function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
```

这是全项目**唯一**接触 `node:sqlite` 的文件，其余各层只用 `run / get / all / pluck / tx / exec`。

---

## 十一、事务

`db.tx(fn)` 自实现，支持嵌套（用 `SAVEPOINT`）：

```js
tx(() => {
  // 外层：BEGIN
  tx(() => { /* 内层：SAVEPOINT sp_1 */ });
  // 内层成功：RELEASE sp_1
});
// 外层成功：COMMIT
```

内层抛错 → `ROLLBACK TO sp_1`，外层可选择继续或让异常上抛。换班生效就是在事务内完成"释放原分配 + 插入新分配 + 更新换班状态 + 写审计"四步，任一步失败全回滚。
