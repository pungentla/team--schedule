'use strict';

/**
 * 缺口报告 —— 需求没填满时，解释"缺几人在哪、为什么缺"。
 *
 * 归因逻辑（reason）：
 *   no_candidate       没人报名该工作类型
 *   overloaded         有人愿意，但被班次上限卡住（H5/H6/H7）
 *   constraint_blocked 被请假/可用时段/连续班次卡住（H3/H4/H8）
 *   no_candidates_left 候选人已被排到其他岗位（本轮名额用尽）
 */

const { REASON, REASON_LABELS } = require('./constraints');

const GAP_REASON_LABELS = Object.freeze({
  no_candidate: '无人报名该工作',
  overloaded: '报名人员已达班次上限',
  constraint_blocked: '报名人员受请假/可用时段/连续班次限制',
  no_candidates_left: '报名人员已被安排在同时段其他工作',
});

const BLOCKED_CODES = new Set([REASON.UNAVAILABLE_DATE, REASON.NOT_AVAILABLE_SLOT, REASON.CONSECUTIVE]);
const OVERLOAD_CODES = new Set([REASON.DAILY_LIMIT, REASON.PERIOD_LIMIT, REASON.WEEKLY_LIMIT]);

/**
 * 对单个未填满的槽位做归因。
 * @param {object} args
 * @param {Array<EmployeeState>} args.employees 全部报名员工
 * @param {number} args.workTypeId
 * @param {object} args.slot
 * @param {object} args.period
 * @param {Array} args.blockers 已经因硬约束被剔除的人 [{userId, name, code}]
 */
function diagnoseGap({ employees, workTypeId, slot, period, checkSlot }) {
  const enrolled = employees.filter((e) => e.matchesWork(slot));
  if (enrolled.length === 0) {
    return {
      code: 'no_candidate',
      message: slot.dutyRole && slot.dutyRole !== 'member' ? '无人报名该负责人角色' : GAP_REASON_LABELS.no_candidate,
      candidates: [],
    };
  }

  let overloaded = 0;
  let blocked = 0;
  let taken = 0;
  const details = [];

  for (const e of enrolled) {
    const res = checkSlot(e, slot, period);
    if (!res) {
      // 理论上不该发生（还能排却没排），标记为名额用尽
      taken += 1;
      details.push({ userId: e.id, name: e.name, code: 'free', message: '仍可安排' });
      continue;
    }
    if (OVERLOAD_CODES.has(res.code)) overloaded += 1;
    else if (BLOCKED_CODES.has(res.code)) blocked += 1;
    else taken += 1;
    details.push({ userId: e.id, name: e.name, code: res.code, message: res.message });
  }

  // 优先级：上限卡住 > 时段限制 > 名额用尽
  let code;
  if (overloaded >= blocked && overloaded >= taken && overloaded > 0) code = 'overloaded';
  else if (blocked >= taken && blocked > 0) code = 'constraint_blocked';
  else code = 'no_candidates_left';

  return {
    code,
    message: GAP_REASON_LABELS[code],
    counts: { enrolled: enrolled.length, overloaded, blocked, taken },
    candidates: details.filter((d) => d.code !== 'free').slice(0, 10),
  };
}

/** 汇总为完整报告 */
function buildGapReport({ slots, assignmentsBySlot, employees, period, checkSlot }) {
  const byDateShift = new Map(); // key: date|shiftId
  const byWorkType = new Map();
  let totalNeeded = 0;
  let totalFilled = 0;

  for (const slot of slots) {
    totalNeeded += slot.needCount;
    const filled = assignmentsBySlot.get(slot.key)?.length || 0;
    totalFilled += filled;
    const gap = slot.needCount - filled;

    if (!byWorkType.has(slot.workTypeId)) {
      byWorkType.set(slot.workTypeId, {
        workTypeId: slot.workTypeId,
        workTypeName: slot.workTypeName,
        workTypeColor: slot.workTypeColor,
        requiresRoles: !!slot.dutyRole && slot.dutyRole !== 'member',
        need: 0,
        filled: 0,
        gap: 0,
      });
    }
    const wtAgg = byWorkType.get(slot.workTypeId);
    wtAgg.need += slot.needCount;
    wtAgg.filled += filled;
    wtAgg.gap += gap;

    if (gap <= 0) continue;

    const groupKey = `${slot.workDate}|${slot.shiftId}`;
    if (!byDateShift.has(groupKey)) {
      byDateShift.set(groupKey, {
        workDate: slot.workDate,
        shiftId: slot.shiftId,
        shiftName: slot.shiftName,
        shiftSeq: slot.shiftSeq,
        items: [],
        gapTotal: 0,
      });
    }
    const group = byDateShift.get(groupKey);
    const diag = diagnoseGap({
      employees,
      workTypeId: slot.workTypeId,
      slot,
      period,
      checkSlot,
    });
    group.items.push({
      workTypeId: slot.workTypeId,
      dutyRole: slot.dutyRole || 'member',
      workTypeName: slot.workTypeName,
      workTypeColor: slot.workTypeColor,
      need: slot.needCount,
      filled,
      gap,
      reason: diag.code,
      reasonMessage: diag.message,
      counts: diag.counts || null,
      candidates: diag.candidates,
    });
    group.gapTotal += gap;
  }

  const byEmployee = employees.map((e) => ({
    userId: e.id,
    name: e.name,
    employeeNo: e.employeeNo,
    assigned: e.total,
    maxShifts: e.maxShifts === null || e.maxShifts === undefined ? null : e.maxShifts,
    capped: e.maxShifts !== null && e.maxShifts !== undefined && e.total >= e.maxShifts,
  }));

  return {
    totalNeeded,
    totalFilled,
    totalGap: totalNeeded - totalFilled,
    fillRate: totalNeeded === 0 ? 1 : Number((totalFilled / totalNeeded).toFixed(4)),
    byDateShift: [...byDateShift.values()].sort(
      (a, b) => a.workDate.localeCompare(b.workDate) || a.shiftSeq - b.shiftSeq
    ),
    byWorkType: [...byWorkType.values()].sort((a, b) => b.gap - a.gap),
    byEmployee: byEmployee.sort((a, b) => b.assigned - a.assigned),
  };
}

module.exports = { buildGapReport, diagnoseGap, GAP_REASON_LABELS, REASON_LABELS };
