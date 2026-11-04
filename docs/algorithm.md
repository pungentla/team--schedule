# 排班算法详解

代码位置：`backend/src/scheduler/`

| 文件 | 职责 |
|---|---|
| `index.js` | 主流程：展开岗位 → 排序 → 贪心填充 → 迭代优化 → 输出 |
| `constraints.js` | 硬约束检查（H2–H8），维护每个员工的实时状态 |
| `scoring.js` | 单个「人 × 岗位」的匹配评分 |
| `gapReport.js` | 缺口归因（为什么这个岗位没排满） |
| `metrics.js` | 公平度指标计算 |

---

## 一、问题定义

**输入**：

- 一组岗位 `slots`：`{ workDate, shiftId, workTypeId, needCount }`
- 一组员工 `employees`：`{ userId, maxShifts, workTypes[], availability[], unavailableDates[], historyByWorkType }`
- 周期约束：`maxShiftsPerDay`、`maxShiftsPerWeek`、`forbidConsecutive`

**输出**：

- `assignments[]`：谁在哪个日期的哪个班次做哪个工作
- `gaps`：没排满的岗位及原因
- `metrics`：公平度指标

**目标**（软目标，按权重加权）：

1. **工作类型轮转公平**——同一个人不要总做同一个工作（最高优先级）
2. **工作量均衡**——每人本周期班次数尽量接近
3. **满足意愿**——尽量排到员工更想去的工作
4. **稀缺优先**——能胜任某工作的人越少，越要优先满足

**硬约束**（必须满足，否则该人不进入候选）。

---

## 二、阶段一：贪心构造

### 2.1 展开岗位为座位

一个岗位需求 3 人 → 展开成 3 个独立"座位"，每个座位单独分配。这样才能让不同的人做同样的工作。

```js
const seats = [];
for (const slot of slots) {
  for (let i = 0; i < slot.needCount; i++) {
    seats.push({ ...slot, seatIndex: i, key: `${slot.workDate}|${slot.shiftId}|${slot.workTypeId}|${i}` });
  }
}
```

同时建立 `seatByKey: Map` 索引，避免后续 O(n) 查找（这个优化把 91 岗位的生成时间从约 400ms 降到 130ms）。

### 2.2 MRV 排序

**MRV（Minimum Remaining Values）**：先安排"能接的人最少"的座位。

```
对每个座位，计算当前可接人数 candidatesCount
按 candidatesCount 升序排序（相同时按 日期 → 班次 → 工作类型 → 座位号 稳定排序）
```

**为什么这样排**：稀缺岗位（比如只有 2 人能做的工作）如果留到最后，很可能这 2 人已经被排满了，直接产生缺口。先排稀缺的，让宽松的岗位用剩下的名额。

### 2.3 逐座位贪心分配

```
for 每个座位（按 MRV 顺序）:
    candidates = 所有满足全部硬约束的员工
    if candidates 为空:
        记录缺口，continue
    for 每个 candidate:
        score = 计算评分(candidate, 座位)
    选 score 最高的候选人（同分时用确定性 jitter 打散）
    分配，并更新该员工的实时状态
```

**确定性 tie-break**：同分时不能用随机数（否则同 seed 结果不稳定），而是用 `deterministicJitter(seed, userId, date, shiftId, workTypeId)`：

```js
// 基于 FNV-1a 哈希 + mulberry32
const h = hashString(`${seed}:${userId}:${workDate}:${shiftId}:${workTypeId}`);
return mulberry32(h)() * 0.999;  // 0~0.999 之间的小数
```

同一个 seed + 同一个组合永远得到同一个值，保证结果可复现。

---

## 三、阶段二：迭代优化

贪心只做一次决定、不回头，容易留下次优解。用局部搜索改进：

```
for round in 1..maxRounds(30):
    improved = 0
    // 邻域 1：Replace —— 把某人的某班换给另一个人
    for 每条分配 a:
        for 每个其他人 e:
            if e 能接 a 且 a 的当前持有者能放下:
                if 交换后两人总评分之和上升:
                    执行交换, improved++
    // 邻域 2：PairSwap —— 两人互换各自的一个班次
    for 每对分配 (a, b) 属于不同人:
        if 互换后都合法 且 总评分上升:
            执行互换, improved++
    if improved < minImprovement: break
```

**关键：只接受总评分严格上升的改动**。评分函数里已经含轮转、均衡、意愿等所有目标，所以"总评分上升"就是"整体变得更好"。

> **踩过的坑**：曾尝试额外加一个"分配次数方差惩罚项"来直接压制不均衡，结果惩罚系数从 4 试到 25 全部无效（`improvedByOptimizer = 0`，轮数打满 30），反而让工作量标准差从 0.43 恶化到 1.2。原因是方差是全局量，单次局部交换对全局方差的影响微乎其微，梯度信号被噪声淹没。**结论：删掉这个惩罚项，回归纯评分和比较**——均衡性通过 `balance` 权重在单次评分里体现，效果更好。

---

## 四、评分函数

`backend/src/scheduler/scoring.js`

```js
score = rotation + rarity + balance + preference + periodLoad + weekLoad + jitter
```

### 4.1 轮转项（最高权重 60）

```js
const hHist = emp.historyCount(workTypeId);        // 历史周期做过几次
const hEff  = hHist + emp.assignedCount(workTypeId); // 加上本周期已排的
const rot = W.rotation / (1 + hEff);               // 60 / (1 + 次数)
```

**为什么必须加上本周期已排次数**：如果只用历史次数，同一个人在同一次生成里会被反复排到同一个工作（因为他的历史次数不会因本次分配而变化）。这是本项目最关键的一个修正：

| 版本 | 各工作分配标准差 | 分布（前台接待） | 评级 |
|---|---|---|---|
| 只用历史次数 | `[1.48, 0.66, 1.30]` | `[4,3,3,2,2,0,0,0]` | fair (1.15) |
| 加上本周期已排 | `[0.43, 0.43, 0.43]` | `[2,2,2,2,2,2,1,1]` | excellent |

### 4.2 工作量均衡项（权重 25）

```js
const load = emp.totalAssigned();
const balance = W.balance / (1 + load);  // 25 / (1 + 已排次数)
```

已排越多分数越低，自然把名额推给排得少的人。

### 4.3 稀缺度项（权重 12）

```js
const rarity = W.rarity * (1 / eligibleCount);  // 能胜任的人越少越高
```

### 4.4 意愿项

```js
preference: { 1: 15, 2: 8, 3: 0 }   // 最想去 +15，可以 +8，凑合 +0
```

### 4.5 负荷惩罚

```js
periodLoad: -6   // 本周期每多一个班，扣 6
weekLoad:   -3   // 本周每多一个班，扣 3
```

周期惩罚比周惩罚重，避免"前三周空着、最后一周爆满"。

### 4.6 抖动量

```js
jitter: 0.999 * deterministicJitter(...)  // 0~0.999
```

只用于打破同分平局，量级远小于任何真实评分项，不会改变实质决策。

---

## 五、硬约束

`backend/src/scheduler/constraints.js`

| 编号 | 约束 | 检查逻辑 | reason 码 |
|---|---|---|---|
| H2 | 报名范围 | `emp.workTypes.includes(workTypeId)` | `not_enrolled` |
| H3 | 不可用日期 | `!unavailableDates.includes(workDate)` | `unavailable_date` |
| H4 | 可用时段 | `availability` 含 `(workDate, shiftId)` | `not_available_slot` |
| H5 | 每日上限 | 当日已排 < `maxShiftsPerDay` | `daily_limit` |
| H6 | 个人上限 | `totalAssigned < maxShifts` | `period_limit` |
| H7 | 每周上限 | 该 ISO 周已排 < `maxShiftsPerWeek` | `weekly_limit` |
| H8 | 禁止连班 | 同日已有班次且 `forbidConsecutive` 时，`|seq差| === 1` 则拒绝 | `consecutive` |
| H9 | 岗位占用 | 同人同日同班次已有分配 | `slot_taken` |

> 编号以 `constraints.js` 中的 `REASON` 注释为准（H9 是后加的岗位占用检查）。

`EmployeeState` 类维护实时状态，每次分配/释放都同步更新计数索引，让约束检查是 O(1) 而非遍历。

**ISO 周计算**：用 `YYYY-Www` 格式（周四归属年份），避免跨年周的边界错误。

---

## 六、缺口归因

排不满时，不是简单报"缺 2 人"，而是给出原因（`gapReport.js`）：

| 原因 | 含义 | 管理员该做什么 |
|---|---|---|
| `no_candidate` | 全团队没人报名这个工作类型 | 扩大报名范围或调整工作类型 |
| `overloaded` | 有人能干但都达到个人上限 | 提高上限或减少需求 |
| `constraint_blocked` | 有人能干但时间冲突/连班/不可用 | 调整报名时间或放宽约束 |
| `no_candidates_left` | 本来有人，但都被排到别的岗位了 | 减少总需求或增加人手 |

---

## 七、公平度指标

`backend/src/scheduler/metrics.js`

### 7.1 单工作类型

```js
perWorkType: [{
  workTypeId, workTypeName, eligibleCount,
  totalAssigned, avg, std, range, max, min,
  distribution: [{ userId, name, count, historyCount }]  // 按次数降序
}]
```

- `std`（标准差）：越小越平均
- `range`（极差 = max − min）：直观反映"最多的人比最少的人多做了几班"

### 7.2 工作量

```js
workload: { avg, std, max, min, range, distribution: [{ userId, name, assigned, historyTotal }] }
```

### 7.3 综合评分

```js
fairnessScore = avgRotationStd          // 各工作类型 std 的平均值
grade = avgRotationStd <= 0.5  ? 'excellent'
      : avgRotationStd <= 1    ? 'good'
      : avgRotationStd <= 2    ? 'fair'
      : 'poor'
```

> **注意方向**：`fairnessScore` 是「**平均轮转标准差**」，**0 表示完美公平，数值越小越好**（不是 0~1 的得分）。命名容易误解，读数值时看 `grade` 更直观。

实测：20 人 / 91 岗位，`fairnessScore = 0.72` → `good`（接近 excellent 的 0.5 阈值），工作量 `std = 0.86`，人均 4.55 班。

## 八、确定性保证

**同一个 seed + 同一份输入 → 完全相同的输出**。

实现要点：

1. 所有排序都有完整 tie-break（不留"相等时任意"的分支）
2. 随机性全部来自 `deterministicJitter`，输入是 `(seed, userId, 日期, 班次, 工作类型)`
3. 输入序列化后算 `inputHash`（FNV-1a），写入 `schedule_runs.input_hash`，可用于校验"这次和上次是不是同一份输入"

**验证方式**：

```bash
npm run verify  # 内含"同 seed 两次生成 inputHash 一致"断言
```

实测两次生成 `inputHash` 均为 `f9cbb16d`，91 条分配逐条一致。

---

## 九、复杂度与调参

| 环节 | 复杂度 | 说明 |
|---|---|---|
| 展开座位 | O(总需求人数) | 91 |
| MRV 排序 | O(S² ) 朴素 / 优化后 O(S log S + S×E) | S=座位数，E=员工数 |
| 贪心分配 | O(S × E × 约束检查) | 约束为 O(1) |
| 迭代优化 | O(rounds × A × E) | A=分配数（91），rounds≤30 |

实测 91 岗位 / 20 人：**130ms**，4 轮迭代收敛。

**主要调参**（`backend/src/config.js`）：

| 参数 | 默认 | 调大 | 调小 |
|---|---|---|---|
| `rotation` | 60 | 更强调轮转，可能牺牲意愿 | 轮转变弱 |
| `balance` | 25 | 工作量更平均 | 允许忙闲不均 |
| `preference` | `{1:15,2:8,3:0}` | 更尊重员工意愿 | 完全按公平排 |
| `maxOptimizeRounds` | 30 | 结果更优但更慢 | 更快但可能次优 |
| `historyPeriods` | 6 | 更长期的历史公平 | 只看近期 |

---

## 十、已知限制

1. **启发式，非最优**：MRV + 局部搜索不保证全局最优。缺口较多时可尝试多个 seed 挑最好的。
2. **无回溯**：贪心阶段不回溯，极端约束下可能比"人工排"差。当前通过迭代优化部分弥补。
3. **规模**：20–100 人表现良好；200 人以上建议先跑 `input-preview` 看候选规模，必要时增大 `maxOptimizeRounds` 或引入分治。
4. **互换优化覆盖度**：PairSwap 只考虑两人互换，三人以上的连锁调整未实现。
