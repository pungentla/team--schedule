'use strict';

/**
 * 排班算法主引擎 —— 纯函数，不接触数据库，便于单元测试。
 *
 * 问题：带约束的二分匹配（员工 × 槽位座位），NP-hard。
 * 方案：MRV 贪心 + Replace/PairSwap 迭代优化，不做 ILP。
 *
 * 阶段 1  MRV 贪心：按"候选人最少的槽位优先"排序再逐个填充。
 *          先排最难排的格子，能显著提高整体填充率（经典的约束满足启发式）。
 * 阶段 2  迭代优化（≤ maxOptimizeRounds 轮，每轮必须有效改进 ≥ minImprovement 才继续）：
 *          a) Replace：把槽位上评分较低的 x 换成评分更高的 y
 *          b) PairSwap：x@s1 与 y@s2 互换，双方各自更适合对方槽位
 *          目标函数 = Σ评分（越大越好）。单调上升 ⇒ 必然收敛。
 *
 * 确定性：所有评分抖动来自 deterministicJitter(seed, ...)；
 *         所有排序都以唯一 id 收尾，不依赖引擎排序稳定性。
 */

const { EmployeeState, checkSlot, REASON } = require('./constraints');
const { scoreEmployee } = require('./scoring');
const { buildGapReport } = require('./gapReport');
const { computeMetrics } = require('./metrics');
const { isoWeekKey } = require('../utils/date');
const { hashString } = require('../utils/random');

const ALGO_VERSION = '1.0.0';

/**
 * @param {object} input
 * @param {object} input.period  { id, startDate, endDate, maxShiftsPerDay, maxShiftsPerWeek, forbidConsecutive }
 * @param {Array}  input.employees [{ userId, name, employeeNo, maxShifts, workTypes:[{workTypeId,priority}],
 *                                   availability:['date|shiftId'], unavailableDates:['date'],
 *                                   historyByWorkType:Map, historyTotal, lastDateByWorkType:Map }]
 * @param {Array}  input.slots   [{ workDate, shiftId, shiftSeq, workTypeId, needCount, workTypeName, workTypeColor, shiftName }]
 * @param {number} input.seed
 * @param {object} [opts]        { maxRounds, minImprovement, explain }
 */
function generateSchedule(input, opts = {}) {
  const started = Date.now();
  const maxRounds = opts.maxRounds ?? 30;
  const minImprovement = opts.minImprovement ?? 1.0;
  const seed = Number.isInteger(input.seed) ? input.seed : 42;

  const { period, slots } = input;

  // ---- 展开为"座位"级别的槽位（need=3 拆成 3 个座位）----
  const seats = [];
  for (const s of slots) {
    for (let k = 0; k < s.needCount; k += 1) {
      seats.push({
        key: `${s.workDate}|${s.shiftId}|${s.workTypeId}`,
        seatKey: `${s.workDate}|${s.shiftId}|${s.workTypeId}|${k}`,
        workDate: s.workDate,
        shiftId: s.shiftId,
        shiftSeq: s.shiftSeq,
        workTypeId: s.workTypeId,
        needCount: s.needCount,
        workTypeName: s.workTypeName,
        workTypeColor: s.workTypeColor,
        shiftName: s.shiftName,
      });
    }
  }

  // ---- 初始化员工状态 ----
  const employees = input.employees.map((e) => new EmployeeState(e, period));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const seatByKey = new Map(seats.map((s) => [s.seatKey, s]));

  // 按历史轮转的关键字排序，让确定性抖动之外的顺序也稳定
  employees.sort((a, b) => a.employeeNo.localeCompare(b.employeeNo) || a.id - b.id);

  const ctx = { seed, periodStartDate: period.startDate, refDate: period.startDate };

  // 岗位稀缺度：每个工作类型有多少人报名。人越少越"难找替补"，需要额外加成。
  const rarityMap = new Map();
  for (const s of slots) {
    if (rarityMap.has(s.workTypeId)) continue;
    rarityMap.set(
      s.workTypeId,
      employees.reduce((acc, e) => acc + (e.workTypes.has(s.workTypeId) ? 1 : 0), 0)
    );
  }
  ctx.workTypeRarity = rarityMap;

  // ---- 阶段 1：MRV 贪心 ----
  // 先为每个座位计算"初始候选人数"（在任何人被排之前），用于排序
  const seatOrder = [...seats].map((seat) => {
    const count = employees.reduce(
      (acc, e) => acc + (canAssignWith(e, seat, period) ? 1 : 0),
      0
    );
    return { seat, candidateCount: count };
  });

  seatOrder.sort((a, b) => {
    // 候选人少 → 先排（MRV）
    if (a.candidateCount !== b.candidateCount) return a.candidateCount - b.candidateCount;
    // 需求多 → 先排
    if (b.seat.needCount !== a.seat.needCount) return b.seat.needCount - a.seat.needCount;
    // 日期早 → 先排
    if (a.seat.workDate !== b.seat.workDate) return a.seat.workDate.localeCompare(b.seat.workDate);
    if (a.seat.shiftSeq !== b.seat.shiftSeq) return a.seat.shiftSeq - b.seat.shiftSeq;
    if (a.seat.workTypeId !== b.seat.workTypeId) return a.seat.workTypeId - b.seat.workTypeId;
    return a.seat.seatKey.localeCompare(b.seat.seatKey);
  });

  /** 分配结果：seatKey → assignment */
  const assigned = new Map();
  /** 槽位 key → 已分配列表 */
  const bySlotKey = new Map();

  function recordAssignment(seat, emp) {
    const assignment = {
      seatKey: seat.seatKey,
      slotKey: seat.key,
      userId: emp.id,
      name: emp.name,
      employeeNo: emp.employeeNo,
      workDate: seat.workDate,
      shiftId: seat.shiftId,
      shiftSeq: seat.shiftSeq,
      workTypeId: seat.workTypeId,
      workTypeName: seat.workTypeName,
      workTypeColor: seat.workTypeColor,
      shiftName: seat.shiftName,
      score: scoreEmployee(emp, seat, ctx),
    };
    assigned.set(seat.seatKey, assignment);
    if (!bySlotKey.has(seat.key)) bySlotKey.set(seat.key, []);
    bySlotKey.get(seat.key).push(assignment);
    emp.addAssignment({ date: seat.workDate, shiftSeq: seat.shiftSeq, workTypeId: seat.workTypeId });
    return assignment;
  }

  function releaseAssignment(assignment) {
    const emp = empById.get(assignment.userId);
    emp.removeAssignment({
      date: assignment.workDate,
      shiftSeq: assignment.shiftSeq,
      workTypeId: assignment.workTypeId,
    });
    assigned.delete(assignment.seatKey);
    const list = bySlotKey.get(assignment.slotKey);
    if (list) {
      const i = list.findIndex((a) => a.seatKey === assignment.seatKey);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) bySlotKey.delete(assignment.slotKey);
    }
  }

  // 贪心填充
  for (const { seat } of seatOrder) {
    let best = null;
    let bestScore = -Infinity;
    for (const emp of employees) {
      if (!canAssignWith(emp, seat, period)) continue;
      const s = scoreEmployee(emp, seat, ctx);
      // 平局用 employeeNo 决定，保证顺序确定
      if (s > bestScore || (s === bestScore && best && emp.employeeNo < best.employeeNo)) {
        bestScore = s;
        best = emp;
      }
    }
    if (best) recordAssignment(seat, best);
  }

  const greedyFilled = assigned.size;

  // ---- 阶段 2：迭代优化 ----
  let rounds = 0;
  let improved = true;

  /**
   * 目标函数（越大越好）= 分配总评分。
   * PairSwap 不改变任何人的班次总数，因此只需比较评分总和；
   * 工作量均衡由评分里的 periodLoad 惩罚项保证。
   */
  function objectiveScore() {
    let total = 0;
    for (const a of assigned.values()) total += a.score;
    return total;
  }

  while (improved && rounds < maxRounds) {
    rounds += 1;
    improved = false;

    // (a) Replace：槽位上已有分配但存在更优的人选
    for (const [slotKey, list] of [...bySlotKey.entries()]) {
      for (const current of [...list]) {
        const seat = seatByKey.get(current.seatKey);
        if (!seat) continue;
        const currentEmp = empById.get(current.userId);

        // 临时释放，看是否有人能顶替且得分更高
        releaseAssignment(current);
        let bestEmp = null;
        let bestScore = current.score + minImprovement; // 必须显著更优才换
        for (const emp of employees) {
          if (emp.id === currentEmp.id) continue;
          if (!canAssignWith(emp, seat, period)) continue;
          const s = scoreEmployee(emp, seat, ctx);
          if (s > bestScore) {
            bestScore = s;
            bestEmp = emp;
          }
        }

        if (bestEmp) {
          recordAssignment(seat, bestEmp);
          improved = true;
        } else {
          // 换不成就还原
          recordAssignment(seat, currentEmp);
        }
      }
    }

    // (b) PairSwap：两个人都更适合对方的槽位
    const entries = [...assigned.values()];
    for (let i = 0; i < entries.length; i += 1) {
      const a = entries[i];
      if (!assigned.has(a.seatKey)) continue;
      const aEmp = empById.get(a.userId);
      const aSeat = seatByKey.get(a.seatKey);
      if (!aSeat) continue;

      for (let j = i + 1; j < entries.length; j += 1) {
        const b = entries[j];
        if (a.workDate === b.workDate && a.shiftId === b.shiftId) continue; // 同一班次不互换
        if (!assigned.has(a.seatKey) || !assigned.has(b.seatKey)) continue;

        const bEmp = empById.get(b.userId);
        const bSeat = seatByKey.get(b.seatKey);
        if (!bSeat) continue;
        if (aEmp.id === bEmp.id) continue;

        const before = a.score + b.score;

        // 评估互换：先释放两者，再互相试探
        releaseAssignment(a);
        releaseAssignment(b);

        const aOk = canAssignWith(aEmp, bSeat, period);
        const bOk = canAssignWith(bEmp, aSeat, period);

        if (aOk && bOk) {
          const aNewScore = scoreEmployee(aEmp, bSeat, ctx);
          const bNewScore = scoreEmployee(bEmp, aSeat, ctx);
          const after = aNewScore + bNewScore;

          if (after > before + minImprovement) {
            recordAssignment(bSeat, aEmp);
            recordAssignment(aSeat, bEmp);
            improved = true;
            continue; // 已换，进入下一对
          }
        }

        // 不换 → 还原
        recordAssignment(aSeat, aEmp);
        recordAssignment(bSeat, bEmp);
      }
    }
  }

  // ---- 输出 ----
  const assignments = [...assigned.values()].map((a) => ({
    userId: a.userId,
    name: a.name,
    employeeNo: a.employeeNo,
    workDate: a.workDate,
    shiftId: a.shiftId,
    shiftSeq: a.shiftSeq,
    workTypeId: a.workTypeId,
    workTypeName: a.workTypeName,
    workTypeColor: a.workTypeColor,
    shiftName: a.shiftName,
    slotKey: a.slotKey,
    score: Number(a.score.toFixed(4)),
  }));

  // 按日期/班次/工作类型排序，输出稳定
  assignments.sort(
    (x, y) =>
      x.workDate.localeCompare(y.workDate) ||
      x.shiftSeq - y.shiftSeq ||
      x.workTypeId - y.workTypeId ||
      x.employeeNo.localeCompare(y.employeeNo)
  );

  const gaps = buildGapReport({
    slots: dedupeSlots(seats),
    assignmentsBySlot: bySlotKey,
    employees,
    period,
    checkSlot,
  });

  const workTypes = dedupeWorkTypes(slots);
  const metrics = computeMetrics({ employees, workTypes, assignments });
  const inputHash = computeInputHash(input);

  return {
    algoVersion: ALGO_VERSION,
    seed,
    inputHash,
    assignments,
    gaps,
    metrics,
    stats: {
      seats: seats.length,
      filled: assignments.length,
      greedyFilled,
      improvedByOptimizer: assignments.length - greedyFilled,
      rounds,
      durationMs: Date.now() - started,
    },
    employees: employees.map((e) => ({
      userId: e.id,
      name: e.name,
      employeeNo: e.employeeNo,
      total: e.total,
      maxShifts: e.maxShifts,
    })),
  };
}

/** 包一层，避免 EmployeeState 的 period 参数遗漏 */
function canAssignWith(emp, seat, period) {
  return checkSlot(emp, seat, period) === null;
}

/** seats 是按座位展开的，去重回槽位（用于缺口统计） */
function dedupeSlots(seats) {
  const map = new Map();
  for (const s of seats) {
    if (!map.has(s.key)) {
      map.set(s.key, {
        key: s.key,
        workDate: s.workDate,
        shiftId: s.shiftId,
        shiftSeq: s.shiftSeq,
        workTypeId: s.workTypeId,
        needCount: s.needCount,
        workTypeName: s.workTypeName,
        workTypeColor: s.workTypeColor,
        shiftName: s.shiftName,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.workDate.localeCompare(b.workDate) || a.shiftSeq - b.shiftSeq || a.workTypeId - b.workTypeId
  );
}

function dedupeWorkTypes(slots) {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.workTypeId)) {
      map.set(s.workTypeId, {
        id: s.workTypeId,
        name: s.workTypeName || `工作${s.workTypeId}`,
        color: s.workTypeColor || '#4A90D9',
      });
    }
  }
  return [...map.values()];
}

/** 输入规范化哈希 —— 用于复现断言与缓存判断 */
function computeInputHash(input) {
  const { period, slots, employees, seed } = input;
  const norm = {
    period: {
      id: period.id,
      startDate: period.startDate,
      endDate: period.endDate,
      maxShiftsPerDay: period.maxShiftsPerDay,
      maxShiftsPerWeek: period.maxShiftsPerWeek,
      forbidConsecutive: period.forbidConsecutive,
    },
    seed,
    slots: [...slots]
      .map((s) => `${s.workDate}|${s.shiftId}|${s.workTypeId}|${s.needCount}`)
      .sort()
      .join(';'),
    employees: [...employees]
      .map(
        (e) =>
          `${e.userId}:${e.maxShifts ?? 'x'}:${e.workTypes
            .map((w) => `${w.workTypeId}-${w.priority}`)
            .sort()
            .join(',')}:${[...(e.availability || [])].sort().join(',')}:${[...(e.unavailableDates || [])]
            .sort()
            .join(',')}`
      )
      .sort()
      .join(';'),
  };
  return hashString(JSON.stringify(norm)).toString(16);
}

module.exports = {
  generateSchedule,
  ALGO_VERSION,
  dedupeSlots,
  computeInputHash,
  REASON,
};
