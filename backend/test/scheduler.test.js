'use strict';

/**
 * 排班算法单元测试 —— node --test
 * 算法是纯函数，因此可以完全不碰数据库直接验证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateSchedule } = require('../src/scheduler');
const { isoWeekKey } = require('../src/utils/date');

// ---------------------------------------------------------------------------
// 测试数据构造器
// ---------------------------------------------------------------------------

const WT = { FRONT: 1, KITCHEN: 2, CLEAN: 3 };

function makePeriod(overrides = {}) {
  return {
    id: 1,
    name: '测试周期',
    startDate: '2025-01-06', // 周一
    endDate: '2025-01-12',   // 周日
    maxShiftsPerDay: 1,
    maxShiftsPerWeek: 5,
    forbidConsecutive: true,
    ...overrides,
  };
}

let shiftSeqCounter;
function resetShifts() {
  shiftSeqCounter = { 10: 1, 11: 2, 12: 3 }; // shiftId → seq（早/中/晚）
}

function makeEmployee(userId, workTypeIds, overrides = {}) {
  return {
    userId,
    name: `员工${userId}`,
    employeeNo: `E${String(userId).padStart(3, '0')}`,
    maxShifts: null,
    workTypes: workTypeIds.map((id, i) => ({ workTypeId: id, priority: Math.min(i + 1, 3) })),
    availability: [],
    unavailableDates: [],
    historyByWorkType: new Map(),
    historyTotal: 0,
    lastDateByWorkType: new Map(),
    ...overrides,
  };
}

/** 为 [start,end] 的每天生成一个班次的工作需求 */
function makeSlots({ dates, shiftId, workTypeId, needCount, shiftName = '早班' }) {
  return dates.map((d) => ({
    workDate: d,
    shiftId,
    shiftSeq: shiftSeqCounter[shiftId],
    workTypeId,
    needCount,
    workTypeName: `工作${workTypeId}`,
    workTypeColor: '#4A90D9',
    shiftName,
  }));
}

function allDates(start, end) {
  const out = [];
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  for (let d = s; d <= e; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

test.beforeEach(() => resetShifts());

test('主副岗位保留可配置总人数，优化后仍遵守每人的报名角色', () => {
  const choices = ['primary', 'deputy', 'primary', 'both'];
  const employees = choices.map((dutyRole, i) => makeEmployee(i + 1, [WT.FRONT], { workTypes: [{ workTypeId: WT.FRONT, priority: 1, dutyRole }] }));
  const slots = makeSlots({ dates: ['2025-01-06'], shiftId: 10, workTypeId: WT.FRONT, needCount: 4 }).map((s) => ({ ...s, requiresRoles: true }));
  for (const seed of [1, 42, 99]) {
    const input = { period: makePeriod(), employees, slots, seed };
    const result = generateSchedule(input);
    assert.equal(result.assignments.length, 4);
    assert.ok(result.assignments.some((a) => a.dutyRole === 'primary'));
    assert.ok(result.assignments.some((a) => a.dutyRole === 'deputy'));
    assert.equal(new Set(result.assignments.map((a) => a.userId)).size, 4);
    for (const a of result.assignments) assert.ok(choices[a.userId - 1] === 'both' || choices[a.userId - 1] === a.dutyRole);
    assert.deepEqual(generateSchedule(input).assignments, result.assignments);
  }
});

test('主副皆可的两名员工优先配齐主副，缺口只留在额外名额', () => {
  const result = generateSchedule({ period: makePeriod(), seed: 42,
    employees: [1, 2].map((id) => makeEmployee(id, [WT.FRONT], { workTypes: [{ workTypeId: WT.FRONT, priority: 1, dutyRole: 'both' }] })),
    slots: makeSlots({ dates: ['2025-01-06'], shiftId: 10, workTypeId: WT.FRONT, needCount: 3 }).map((s) => ({ ...s, requiresRoles: true })),
  });
  assert.deepEqual(result.assignments.map((a) => a.dutyRole).sort(), ['deputy', 'primary']);
  assert.equal(result.gaps.totalGap, 1);
  assert.equal(result.gaps.byDateShift[0].items[0].dutyRole, 'either');
});

test('一个人不能同时填主副两个名额', () => {
  const result = generateSchedule({ period: makePeriod(), seed: 42,
    employees: [makeEmployee(1, [WT.FRONT], { workTypes: [{ workTypeId: WT.FRONT, priority: 1, dutyRole: 'both' }] })],
    slots: makeSlots({ dates: ['2025-01-06'], shiftId: 10, workTypeId: WT.FRONT, needCount: 2 }).map((s) => ({ ...s, requiresRoles: true })),
  });
  assert.equal(result.assignments.length, 1);
  assert.equal(result.gaps.totalGap, 1);
});

// ---------------------------------------------------------------------------
// 1. 简单场景：需求能被完全满足
// ---------------------------------------------------------------------------
test('fills_simple_case: 7天×1班×1工作×1人，10人报名 → 填充率 100%', () => {
  const period = makePeriod();
  const dates = allDates(period.startDate, period.endDate);

  const employees = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) =>
    makeEmployee(id, [WT.FRONT], { maxShifts: 2 })
  );

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({ dates, shiftId: 10, workTypeId: WT.FRONT, needCount: 1 }),
    seed: 42,
  });

  assert.equal(result.assignments.length, 7, '应排满 7 个班次');
  assert.equal(result.gaps.totalGap, 0, '不应有缺口');
  assert.equal(result.gaps.fillRate, 1);
});

// ---------------------------------------------------------------------------
// 2. 同一人同一天同一班次不能重复
// ---------------------------------------------------------------------------
test('never_assigns_same_shift_twice: 同班次需求 5 人只有 3 人报名 → 3 人各不相同', () => {
  const period = makePeriod();
  const employees = [1, 2, 3].map((id) => makeEmployee(id, [WT.FRONT]));

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({
      dates: ['2025-01-06'],
      shiftId: 10,
      workTypeId: WT.FRONT,
      needCount: 5,
    }),
    seed: 42,
  });

  const userIds = result.assignments.map((a) => a.userId);
  assert.equal(new Set(userIds).size, userIds.length, '同一班次不能被同一人占两个座位');
  assert.equal(result.assignments.length, 3);
  assert.equal(result.gaps.totalGap, 2, '缺口应为 2');
});

// ---------------------------------------------------------------------------
// 3. 请假不排（H3）
// ---------------------------------------------------------------------------
test('respects_unavailability: 请假的人不被排班', () => {
  const period = makePeriod();
  const dates = allDates(period.startDate, period.endDate);

  const employees = [
    makeEmployee(1, [WT.FRONT], { unavailableDates: ['2025-01-06', '2025-01-07'] }),
    makeEmployee(2, [WT.FRONT]),
  ];

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({ dates, shiftId: 10, workTypeId: WT.FRONT, needCount: 1 }),
    seed: 42,
  });

  const emp1OnLeave = result.assignments.filter(
    (a) => a.userId === 1 && ['2025-01-06', '2025-01-07'].includes(a.workDate)
  );
  assert.equal(emp1OnLeave.length, 0, '请假日期不应被排班');
  assert.equal(result.assignments.length, 7, '另一人应覆盖 7 天');
});

// ---------------------------------------------------------------------------
// 4. 每日 / 每周上限（H5 / H6 / H7）
// ---------------------------------------------------------------------------
test('respects_daily_and_weekly_caps: 单人不超每日1班、每周2班', () => {
  const period = makePeriod({ maxShiftsPerDay: 1, maxShiftsPerWeek: 2 });
  const dates = allDates(period.startDate, period.endDate);

  // 一个人报名、需求每天1人 → 每周最多只能排2天
  const employees = [makeEmployee(1, [WT.FRONT])];
  const slots = dates.flatMap((d) =>
    [10, 11].map((shiftId) => ({
      workDate: d,
      shiftId,
      shiftSeq: shiftSeqCounter[shiftId],
      workTypeId: WT.FRONT,
      needCount: 1,
      workTypeName: '工作1',
      workTypeColor: '#4A90D9',
      shiftName: shiftId === 10 ? '早班' : '中班',
    }))
  );

  const result = generateSchedule({ period, employees, slots, seed: 42 });

  // 按日统计
  const byDate = new Map();
  for (const a of result.assignments) {
    byDate.set(a.workDate, (byDate.get(a.workDate) || 0) + 1);
  }
  for (const [d, c] of byDate) {
    assert.ok(c <= 1, `${d} 当日排了 ${c} 班，超过每日上限 1`);
  }
  // 按周统计（全部落在同一 ISO 周）
  const byWeek = new Map();
  for (const a of result.assignments) {
    const k = isoWeekKey(a.workDate);
    byWeek.set(k, (byWeek.get(k) || 0) + 1);
  }
  for (const [w, c] of byWeek) {
    assert.ok(c <= 2, `${w} 排了 ${c} 班，超过每周上限 2`);
  }
  assert.equal(result.assignments.length, 2, '一周上限 2 → 总排班应为 2');
});

// ---------------------------------------------------------------------------
// 5. 禁止连续班次（H8）
// ---------------------------------------------------------------------------
test('forbids_consecutive_shifts: 同一人同一天不排相邻 seq 的班次', () => {
  const period = makePeriod({ maxShiftsPerDay: 2, maxShiftsPerWeek: 7, forbidConsecutive: true });
  const employees = [makeEmployee(1, [WT.FRONT])];

  // 早(seq1) + 中(seq2) 相邻
  const slots = [
    { workDate: '2025-01-06', shiftId: 10, shiftSeq: 1, workTypeId: WT.FRONT, needCount: 1, workTypeName: '工作1', workTypeColor: '#4A90D9', shiftName: '早班' },
    { workDate: '2025-01-06', shiftId: 11, shiftSeq: 2, workTypeId: WT.FRONT, needCount: 1, workTypeName: '工作1', workTypeColor: '#4A90D9', shiftName: '中班' },
  ];

  const result = generateSchedule({ period, employees, slots, seed: 42 });
  assert.equal(result.assignments.length, 1, '相邻班次只能排 1 个');
  assert.equal(result.gaps.totalGap, 1);
});

test('allows_non_consecutive_shifts: 早(1) + 晚(3) 不相邻，可以都排', () => {
  const period = makePeriod({ maxShiftsPerDay: 2, maxShiftsPerWeek: 7, forbidConsecutive: true });
  const employees = [makeEmployee(1, [WT.FRONT])];

  const slots = [
    { workDate: '2025-01-06', shiftId: 10, shiftSeq: 1, workTypeId: WT.FRONT, needCount: 1, workTypeName: '工作1', workTypeColor: '#4A90D9', shiftName: '早班' },
    { workDate: '2025-01-06', shiftId: 12, shiftSeq: 3, workTypeId: WT.FRONT, needCount: 1, workTypeName: '工作1', workTypeColor: '#4A90D9', shiftName: '晚班' },
  ];

  const result = generateSchedule({ period, employees, slots, seed: 42 });
  assert.equal(result.assignments.length, 2, '早班+晚班不相邻，应都能排');
});

// ---------------------------------------------------------------------------
// 6. 轮转公平性（核心目标）
// ---------------------------------------------------------------------------
test('rotation_fairness: 3种工作均等需求 → 各工作类型内标准差趋近 0', () => {
  const period = makePeriod({
    startDate: '2025-01-06',
    endDate: '2025-01-19', // 两周，14 天
    maxShiftsPerWeek: 5,
  });
  const dates = allDates(period.startDate, period.endDate);

  // 9 人全部报名 3 种工作，每天 1 班，每班每种工作各 1 人
  const employees = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) =>
    makeEmployee(id, [WT.FRONT, WT.KITCHEN, WT.CLEAN], { maxShifts: 5 })
  );

  const slots = dates.flatMap((d) => [
    { workDate: d, shiftId: 10, shiftSeq: 1, workTypeId: WT.FRONT, needCount: 1, workTypeName: '前台', workTypeColor: '#1' , shiftName: '早班' },
    { workDate: d, shiftId: 11, shiftSeq: 2, workTypeId: WT.KITCHEN, needCount: 1, workTypeName: '后厨', workTypeColor: '#2', shiftName: '中班' },
    { workDate: d, shiftId: 12, shiftSeq: 3, workTypeId: WT.CLEAN, needCount: 1, workTypeName: '清洁', workTypeColor: '#3', shiftName: '晚班' },
  ]);

  const result = generateSchedule({ period, employees, slots, seed: 42 });

  // 每人总班次应接近均值
  const counts = result.employees.map((e) => e.total);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((acc, c) => acc + (c - avg) ** 2, 0) / counts.length;
  const workloadStd = Math.sqrt(variance);

  assert.ok(workloadStd <= 1.5, `工作量标准差应较小，实际 ${workloadStd.toFixed(2)}`);

  // 每种工作类型内部分配应接近均匀
  for (const wt of result.metrics.perWorkType) {
    assert.ok(
      wt.std <= 1.2,
      `${wt.workTypeName} 的轮转标准差应 ≤ 1.2，实际 ${wt.std}（分布：${wt.distribution
        .map((d) => d.count)
        .join(',')}）`
    );
  }
});

test('rotation_prefers_never_done_work: 没做过某工作的人优先被排该工作', () => {
  const period = makePeriod({ startDate: '2025-01-06', endDate: '2025-01-06' });

  const employees = [
    // 员工1 历史做过 KITCHEN 3 次，员工2 从未做过
    makeEmployee(1, [WT.KITCHEN], {
      historyByWorkType: new Map([[WT.KITCHEN, 3]]),
      historyTotal: 3,
      lastDateByWorkType: new Map([[WT.KITCHEN, '2025-01-01']]),
    }),
    makeEmployee(2, [WT.KITCHEN]),
  ];

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({ dates: ['2025-01-06'], shiftId: 10, workTypeId: WT.KITCHEN, needCount: 1 }),
    seed: 42,
  });

  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].userId, 2, '应从没做过的人优先轮转');
});

// ---------------------------------------------------------------------------
// 7. 确定性（可复现）
// ---------------------------------------------------------------------------
test('deterministic_same_seed: 同输入同 seed 跑两次结果完全一致', () => {
  const period = makePeriod();
  const dates = allDates(period.startDate, period.endDate);
  const employees = [1, 2, 3, 4, 5, 6].map((id) =>
    makeEmployee(id, [WT.FRONT, WT.KITCHEN], { maxShifts: 3 })
  );
  const slots = dates.flatMap((d) => [
    { workDate: d, shiftId: 10, shiftSeq: 1, workTypeId: WT.FRONT, needCount: 2, workTypeName: '前台', workTypeColor: '#1', shiftName: '早班' },
    { workDate: d, shiftId: 11, shiftSeq: 2, workTypeId: WT.KITCHEN, needCount: 1, workTypeName: '后厨', workTypeColor: '#2', shiftName: '中班' },
  ]);

  const input = { period, employees, slots, seed: 12345 };
  const a = generateSchedule(input);
  const b = generateSchedule(input);

  assert.equal(a.inputHash, b.inputHash, 'inputHash 应相同');
  assert.equal(a.assignments.length, b.assignments.length);
  assert.deepEqual(
    a.assignments.map((x) => `${x.workDate}|${x.shiftId}|${x.workTypeId}|${x.userId}`),
    b.assignments.map((x) => `${x.workDate}|${x.shiftId}|${x.workTypeId}|${x.userId}`),
    '两次分配必须逐条相同'
  );
});

test('different_seed_may_differ_but_both_valid', () => {
  const period = makePeriod();
  const dates = allDates(period.startDate, period.endDate);
  const employees = [1, 2, 3].map((id) => makeEmployee(id, [WT.FRONT]));
  const slots = makeSlots({ dates, shiftId: 10, workTypeId: WT.FRONT, needCount: 1 });

  const a = generateSchedule({ period, employees, slots, seed: 1 });
  const b = generateSchedule({ period, employees, slots, seed: 999 });
  assert.equal(a.assignments.length, b.assignments.length, '不同 seed 也应填满同样数量');
});

// ---------------------------------------------------------------------------
// 8. 缺口归因
// ---------------------------------------------------------------------------
test('gap_reasons_correct: 无人报名 → no_candidate', () => {
  const period = makePeriod();
  const employees = [makeEmployee(1, [WT.FRONT])]; // 没人报名 KITCHEN

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({ dates: ['2025-01-06'], shiftId: 10, workTypeId: WT.KITCHEN, needCount: 2 }),
    seed: 42,
  });

  const gap = result.gaps.byDateShift[0].items[0];
  assert.equal(gap.reason, 'no_candidate');
  assert.equal(gap.gap, 2);
});

test('gap_reasons_correct: 达上限 → overloaded', () => {
  const period = makePeriod({ maxShiftsPerWeek: 1 });
  const employees = [makeEmployee(1, [WT.FRONT])];
  // 同一周内需要 2 天，但每周上限 1
  const slots = makeSlots({
    dates: ['2025-01-06', '2025-01-07'],
    shiftId: 10,
    workTypeId: WT.FRONT,
    needCount: 1,
  });

  const result = generateSchedule({ period, employees, slots, seed: 42 });
  assert.equal(result.assignments.length, 1);
  const gap = result.gaps.byDateShift[0].items[0];
  assert.equal(gap.reason, 'overloaded', `实际因：${gap.reason}`);
});

test('gap_reasons_correct: 请假 → constraint_blocked', () => {
  const period = makePeriod();
  const employees = [makeEmployee(1, [WT.FRONT], { unavailableDates: ['2025-01-07'] })];
  const slots = makeSlots({
    dates: ['2025-01-07'],
    shiftId: 10,
    workTypeId: WT.FRONT,
    needCount: 1,
  });

  const result = generateSchedule({ period, employees, slots, seed: 42 });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.gaps.byDateShift[0].items[0].reason, 'constraint_blocked');
});

// ---------------------------------------------------------------------------
// 9. 边界
// ---------------------------------------------------------------------------
test('empty_input: 无报名 / 无需求不崩溃', () => {
  const period = makePeriod();
  const r1 = generateSchedule({ period, employees: [], slots: [], seed: 1 });
  assert.equal(r1.assignments.length, 0);
  assert.equal(r1.gaps.totalNeeded, 0);
  assert.equal(r1.gaps.fillRate, 1);

  const r2 = generateSchedule({
    period,
    employees: [makeEmployee(1, [WT.FRONT])],
    slots: [],
    seed: 1,
  });
  assert.equal(r2.assignments.length, 0);
});

test('respects_personal_max_shifts: 个人上限优先于周期需求', () => {
  const period = makePeriod();
  const dates = allDates(period.startDate, period.endDate);
  const employees = [1, 2].map((id) => makeEmployee(id, [WT.FRONT], { maxShifts: 2 }));

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({ dates, shiftId: 10, workTypeId: WT.FRONT, needCount: 1 }),
    seed: 42,
  });

  assert.equal(result.assignments.length, 4, '2人×上限2 = 4');
  for (const e of result.employees) {
    assert.ok(e.total <= 2, `${e.name} 排了 ${e.total} 班，超过个人上限 2`);
  }
});

test('availability_allowlist: 只排在有标记的可用时段内', () => {
  const period = makePeriod();
  const employees = [
    makeEmployee(1, [WT.FRONT], {
      availability: ['2025-01-06|10', '2025-01-08|10'], // 只这两个格子可用
    }),
  ];
  const dates = allDates(period.startDate, period.endDate);

  const result = generateSchedule({
    period,
    employees,
    slots: makeSlots({ dates, shiftId: 10, workTypeId: WT.FRONT, needCount: 1 }),
    seed: 42,
  });

  assert.equal(result.assignments.length, 2);
  const assignedDates = result.assignments.map((a) => a.workDate).sort();
  assert.deepEqual(assignedDates, ['2025-01-06', '2025-01-08']);
});

test('空位最后允许兼任不同工作，同一班次计1班，并通过完整草稿校验', () => {
  const { evaluateAssignments } = require('../src/scheduler');
  const input = { period: makePeriod({ maxShiftsPerDay: 1, maxShiftsPerWeek: 1 }), seed: 42,
    employees: [makeEmployee(1, [WT.FRONT, WT.KITCHEN], { maxShifts: 1 })],
    slots: [WT.FRONT, WT.KITCHEN].flatMap((workTypeId) => makeSlots({ dates: ['2025-01-06', '2025-01-07'], shiftId: 10, workTypeId, needCount: 1 })),
  };
  const result = generateSchedule(input);
  assert.equal(result.assignments.length, 2);
  assert.deepEqual(new Set(result.assignments.map((a) => a.workDate)), new Set(['2025-01-06']));
  assert.equal(result.employees[0].total, 1);
  assert.equal(result.metrics.workload.distribution[0].assigned, 1);
  assert.equal(result.gaps.byEmployee[0].assigned, 1);
  assert.equal(evaluateAssignments(input, result.assignments).problems.length, 0);
  const { EmployeeState, checkSlot } = require('../src/scheduler/constraints');
  const state = new EmployeeState(input.employees[0], input.period);
  for (const a of result.assignments) state.addAssignment({ date: a.workDate, shiftSeq: a.shiftSeq, workTypeId: a.workTypeId });
  assert.equal(checkSlot(state, { ...result.assignments[0], allowConcurrent: true }, input.period).code, 'slot_taken');
  const cloned = state.clone();
  cloned.removeAssignment({ date: '2025-01-06', shiftSeq: 1, workTypeId: WT.FRONT });
  assert.equal(cloned.total, 1); assert.equal(cloned.weekCount('2025-01-06'), 1);
  cloned.removeAssignment({ date: '2025-01-06', shiftSeq: 1, workTypeId: WT.KITCHEN });
  assert.equal(cloned.total, 0); assert.equal(cloned.weekCount('2025-01-06'), 0); assert.equal(state.total, 1);
});

test('有足够人时优先分给不同人员；兼任不突破请假和相邻班次限制', () => {
  const slots = [WT.FRONT, WT.KITCHEN].flatMap((workTypeId) => makeSlots({ dates: ['2025-01-06'], shiftId: 10, workTypeId, needCount: 1 }));
  const input = { period: makePeriod(), seed: 42, slots, employees: [1, 2].map((id) => makeEmployee(id, [WT.FRONT, WT.KITCHEN])) };
  assert.equal(new Set(generateSchedule(input).assignments.map((a) => a.userId)).size, 2);
  input.employees = [makeEmployee(1, [WT.FRONT, WT.KITCHEN], { unavailableDates: ['2025-01-06'] })];
  assert.equal(generateSchedule(input).assignments.length, 0);
});

test('允许 A主+B副、C主+D副、A主+D副 重叠搭档；只整组生成并跳过不可用搭档', () => {
  const { evaluateAssignments } = require('../src/scheduler');
  const employees = [1, 2, 3, 4].map((id) => makeEmployee(id, [WT.FRONT], { workTypes: [{ workTypeId: WT.FRONT, priority: 1, dutyRole: [1, 3].includes(id) ? 'primary' : 'deputy' }] }));
  const pairs = [{ primaryUserId: 1, deputyUserId: 2 }, { primaryUserId: 3, deputyUserId: 4 }, { primaryUserId: 1, deputyUserId: 4 }];
  const input = { period: makePeriod({ maxShiftsPerWeek: 7 }), seed: 12, employees,
    slots: makeSlots({ dates: allDates('2025-01-06', '2025-01-12'), shiftId: 10, workTypeId: WT.FRONT, needCount: 2 }).map((s) => ({ ...s, requiresRoles: true, dutyPairs: pairs })),
  };
  const result = generateSchedule(input);
  assert.equal(result.assignments.length, 14);
  for (const date of allDates('2025-01-06', '2025-01-12')) {
    const people = result.assignments.filter((a) => a.workDate === date);
    assert.ok(pairs.some((p) => p.primaryUserId === people.find((a) => a.dutyRole === 'primary').userId && p.deputyUserId === people.find((a) => a.dutyRole === 'deputy').userId));
  }
  assert.equal(evaluateAssignments(input, result.assignments).problems.length, 0);
  const invalid = result.assignments.filter((a) => a.workDate !== '2025-01-06');
  invalid.push({ workDate: '2025-01-06', shiftId: 10, workTypeId: WT.FRONT, userId: 3, dutyRole: 'primary' }, { workDate: '2025-01-06', shiftId: 10, workTypeId: WT.FRONT, userId: 2, dutyRole: 'deputy' });
  assert.equal(evaluateAssignments(input, invalid).problems[0].code, 'DUTY_PAIR_MISMATCH');
  employees[0].unavailableDates = ['2025-01-06']; employees[3].unavailableDates = ['2025-01-06'];
  const absent = generateSchedule(input);
  assert.equal(absent.assignments.filter((a) => a.workDate === '2025-01-06').length, 0, '不能只排半组，也不能擅自组成 C主+B副');
});

test('同一主负责人可按人数选多个副负责人，跳过请假并轮换副负责人', () => {
  const dates = ['2025-01-06', '2025-01-07', '2025-01-08'];
  const employees = [1, 2, 3, 4, 5].map(id => makeEmployee(id, [WT.FRONT], {
    workTypes: [{ workTypeId: WT.FRONT, priority: 1, dutyRole: id <= 2 ? 'primary' : 'deputy' }],
    unavailableDates: id === 3 ? [dates[0]] : [],
    historyByWorkType: id === 1 ? new Map([[WT.FRONT, 10]]) : new Map(),
    historyTotal: id === 1 ? 10 : 0,
  }));
  const pairs = [3, 4, 5].map(deputyUserId => ({ primaryUserId: 1, deputyUserId }));
  pairs.push({ primaryUserId: 2, deputyUserId: 4 });
  const slots = dates.flatMap((date, i) => makeSlots({ dates: [date], shiftId: 10, workTypeId: WT.FRONT, needCount: i === 0 ? 3 : 2 }))
    .map(slot => ({ ...slot, requiresRoles: true, dutyPairs: pairs }));
  const input = { period: makePeriod({ referenceHistory: true }), employees, slots, seed: 12 };
  const firstDay = generateSchedule({ ...input, slots: [slots[0]] }).assignments;
  assert.deepEqual(firstDay.filter(a => a.dutyRole === 'primary').map(a => a.userId), [1]);
  employees[1].maxShifts = 0;
  const { assignments } = generateSchedule(input);
  assert.deepEqual(assignments.filter(a => a.dutyRole === 'primary').map(a => a.userId), [1, 1, 1]);
  const deputies = date => assignments.filter(a => a.workDate === date && a.dutyRole === 'deputy').map(a => a.userId).sort();
  assert.deepEqual(deputies(dates[0]), [4, 5]);
  assert.deepEqual(deputies(dates[1]), [3]);
  assert.equal(deputies(dates[2]).length, 1);
  assert.notEqual(deputies(dates[2])[0], 3);
});

test('同工作优先避开上次人员，周期内继续轮转；没人可替时保留补位能力', () => {
  const dates = allDates('2025-01-06', '2025-01-12');
  const employees = [1, 2, 3].map((id) => makeEmployee(id, [WT.KITCHEN], {
    historyByWorkType: new Map([[WT.KITCHEN, 10]]), historyTotal: 10,
    lastDateByWorkType: new Map([[WT.KITCHEN, id === 1 ? '2025-01-05' : '2025-01-01']]),
  }));
  const input = { period: makePeriod({ maxShiftsPerWeek: 7 }), employees, seed: 42,
    slots: makeSlots({ dates, shiftId: 10, workTypeId: WT.KITCHEN, needCount: 1 }),
  };
  const result = generateSchedule(input);
  assert.notEqual(result.assignments[0].userId, 1, '上次已做的人不应再次优先');
  for (let i = 1; i < result.assignments.length; i++) assert.notEqual(result.assignments[i].userId, result.assignments[i - 1].userId, '有替代人员时避免连续做同一工作');
  employees[1].unavailableDates = dates; employees[2].unavailableDates = dates;
  const fallback = generateSchedule(input);
  assert.equal(fallback.assignments.length, 7); assert.ok(fallback.assignments.every((a) => a.userId === 1));
});

test('每周工作按实际轮次轮换，并兼顾多个工作的总班次', () => {
  const dates = ['2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02'];
  const previousDates = ['2025-01-05', '2024-12-29', '2024-12-22', '2024-12-15'];
  const workTypes = [WT.FRONT, WT.KITCHEN];
  const employees = previousDates.map((date, index) => makeEmployee(index + 1, workTypes, {
    historyByWorkType: new Map(workTypes.map(id => [id, 3])),
    historyTotal: 6,
    lastDateByWorkType: new Map(workTypes.map(id => [id, date])),
  }));
  const result = generateSchedule({
    period: makePeriod({ startDate: dates[0], endDate: dates.at(-1), referenceHistory: true }),
    seed: 42, employees, slots: workTypes.flatMap(workTypeId => makeSlots({ dates, shiftId: 10, workTypeId, needCount: 1 })),
  });
  for (const id of workTypes) {
    const turns = result.assignments.filter(assignment => assignment.workTypeId === id);
    assert.equal(turns.length, dates.length);
    assert.notEqual(turns[0].userId, 1);
    assert.equal(new Set(turns.map(turn => turn.userId)).size, employees.length);
  }
  assert.ok(result.employees.every(employee => employee.total === 2));
});

test('固定搭档按两人的历史与本期记录轮转，尽量避开上次搭档', () => {
  const pairs = [{ primaryUserId: 1, deputyUserId: 2 }, { primaryUserId: 3, deputyUserId: 4 }, { primaryUserId: 1, deputyUserId: 4 }];
  const employees = [1, 2, 3, 4].map((id) => makeEmployee(id, [WT.FRONT], {
    workTypes: [{ workTypeId: WT.FRONT, priority: 1, dutyRole: id % 2 ? 'primary' : 'deputy' }],
    historyByWorkType: new Map([[WT.FRONT, 5]]), historyTotal: 5,
    lastDateByWorkType: new Map([[WT.FRONT, id <= 2 ? '2025-01-05' : '2025-01-01']]),
  }));
  const dates = allDates('2025-01-06', '2025-01-12');
  const result = generateSchedule({ period: makePeriod({ maxShiftsPerWeek: 7 }), seed: 2, employees,
    slots: makeSlots({ dates, shiftId: 10, workTypeId: WT.FRONT, needCount: 2 }).map((s) => ({ ...s, requiresRoles: true, dutyPairs: pairs })),
  });
  for (let i = 0; i < dates.length; i++) {
    const ids = result.assignments.filter((a) => a.workDate === dates[i]).map((a) => a.userId).sort();
    assert.deepEqual(ids, i % 2 ? [1, 2] : [3, 4]);
  }
});

test('新鲜度按距离该工作上次安排的天数递增，未来安排不作为过去记录', () => {
  const { EmployeeState } = require('../src/scheduler/constraints');
  const { explainScore } = require('../src/scheduler/scoring');
  const e = new EmployeeState(makeEmployee(1, [WT.FRONT], { lastDateByWorkType: new Map([[WT.FRONT, '2025-01-01']]) }), makePeriod());
  e.addAssignment({ date: '2025-01-20', shiftSeq: 1, workTypeId: WT.FRONT });
  assert.equal(e.lastWorkDateBefore(WT.FRONT, '2025-01-06'), '2025-01-01');
  const score = (date) => explainScore(e, { workDate: date, shiftId: 10, workTypeId: WT.FRONT }, { seed: 1 }).breakdown.freshness;
  assert.ok(score('2025-01-10') > score('2025-01-02'));
});
