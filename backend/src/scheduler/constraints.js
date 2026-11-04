'use strict';

/**
 * 硬约束（违反即不可排）—— 纯函数，不碰数据库。
 *
 * H1 周期内已提交报名且状态 submitted   → 在 buildInput 阶段过滤，不进候选池
 * H2 工作类型必须在报名范围内            → canAssign 检查
 * H3 不可用日期（整日请假）              → canAssign 检查
 * H4 精细可用 allow-list                 → canAssign 检查
 * H5 同日已排班次数 < maxShiftsPerDay    → canAssign 检查
 * H6 周期总数 < min(个人上限, 周期上限)   → canAssign 检查
 * H7 每周班次数 < maxShiftsPerWeek       → canAssign 检查
 * H8 禁止连续班次（同日 |Δseq| == 1）     → canAssign 检查
 * H9 同一人同一 (date, shift) 只能一个岗位 → 由 H5(默认1) + 数据库部分唯一索引兜底
 *
 * 约束编号会出现在缺口归因里，便于前端解释"为什么没人能补"。
 */

const { isoWeekKey } = require('../utils/date');

const REASON = Object.freeze({
  NOT_ENROLLED: 'not_enrolled',           // H2 未报名该工作类型
  UNAVAILABLE_DATE: 'unavailable_date',   // H3 当日请假
  NOT_AVAILABLE_SLOT: 'not_available_slot', // H4 不在可用时段内
  DAILY_LIMIT: 'daily_limit',             // H5 超过每日上限
  PERIOD_LIMIT: 'period_limit',           // H6 超过周期/个人上限
  WEEKLY_LIMIT: 'weekly_limit',           // H7 超过每周上限
  CONSECUTIVE: 'consecutive',             // H8 连续班次
  SLOT_TAKEN: 'slot_taken',               // H9 该班次已排
});

const REASON_LABELS = Object.freeze({
  [REASON.NOT_ENROLLED]: '未报名该工作',
  [REASON.UNAVAILABLE_DATE]: '当日请假',
  [REASON.NOT_AVAILABLE_SLOT]: '不在可用时段',
  [REASON.DAILY_LIMIT]: '已达当日班次上限',
  [REASON.PERIOD_LIMIT]: '已达周期班次上限',
  [REASON.WEEKLY_LIMIT]: '已达每周班次上限',
  [REASON.CONSECUTIVE]: '与已排班次连续',
  [REASON.SLOT_TAKEN]: '该班次已排班',
});

/**
 * 员工工作状态（mutable，算法过程中持续更新）。
 * 用 Map 索引避免每次都扫数组。
 */
class EmployeeState {
  constructor(emp, period) {
    this.id = emp.userId;
    this.name = emp.name;
    this.employeeNo = emp.employeeNo;
    this.maxShifts = emp.maxShifts;                       // 个人上限（可为 null）
    this.periodCap = period.maxShiftsPerWeek * 99;        // 周期上限兜底（实际用 min）
    this.effectiveCap = emp.maxShifts === null || emp.maxShifts === undefined
      ? Infinity
      : Math.max(0, emp.maxShifts);

    /** 工作类型 → 意愿优先级（1 最高） */
    this.workTypes = new Map(emp.workTypes.map((w) => [w.workTypeId, w.priority]));
    /** Set<'date'> 整日不可用 */
    this.unavailableDates = emp.unavailableDates ? new Set(emp.unavailableDates) : new Set();
    /** Set<'date|shiftId'> 精细可用；空集合表示"不限" */
    this.availability = emp.availability ? new Set(emp.availability) : new Set();

    /** Map<'date', Array<shiftSeq>> 当日已排班次的 seq */
    this.byDate = new Map();
    /** Map<'isoweek', count> */
    this.byWeek = new Map();
    /** Map<workTypeId, count> 本周期已排 */
    this.byWorkType = new Map();
    this.total = 0;

    /** Map<workTypeId, count> 历史累计（跨周期） */
    this.historyByWorkType = emp.historyByWorkType || new Map();
    this.historyTotal = emp.historyTotal || 0;
    /** Map<workTypeId, dateStr> 上次做该工作的日期 */
    this.lastDateByWorkType = emp.lastDateByWorkType || new Map();
  }

  /** 该工作类型的历史次数 */
  historyCount(workTypeId) {
    return this.historyByWorkType.get(workTypeId) || 0;
  }

  assignedCount(workTypeId) {
    return this.byWorkType.get(workTypeId) || 0;
  }

  dayShifts(date) {
    return this.byDate.get(date) || [];
  }

  weekCount(date) {
    return this.byWeek.get(isoWeekKey(date)) || 0;
  }

  /** 记录一次分配 */
  addAssignment({ date, shiftSeq, workTypeId }) {
    if (!this.byDate.has(date)) this.byDate.set(date, []);
    this.byDate.get(date).push(shiftSeq);
    const wk = isoWeekKey(date);
    this.byWeek.set(wk, (this.byWeek.get(wk) || 0) + 1);
    this.byWorkType.set(workTypeId, (this.byWorkType.get(workTypeId) || 0) + 1);
    this.total += 1;
  }

  /** 撤销一次分配（用于回填/交换时临时释放） */
  removeAssignment({ date, shiftSeq, workTypeId }) {
    const arr = this.byDate.get(date);
    if (arr) {
      const i = arr.indexOf(shiftSeq);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.byDate.delete(date);
    }
    const wk = isoWeekKey(date);
    const wc = (this.byWeek.get(wk) || 0) - 1;
    if (wc > 0) this.byWeek.set(wk, wc);
    else this.byWeek.delete(wk);

    const tc = (this.byWorkType.get(workTypeId) || 0) - 1;
    if (tc > 0) this.byWorkType.set(workTypeId, tc);
    else this.byWorkType.delete(workTypeId);

    this.total = Math.max(0, this.total - 1);
  }

  clone() {
    const c = Object.create(EmployeeState.prototype);
    c.id = this.id;
    c.name = this.name;
    c.employeeNo = this.employeeNo;
    c.maxShifts = this.maxShifts;
    c.periodCap = this.periodCap;
    c.effectiveCap = this.effectiveCap;
    c.workTypes = new Map(this.workTypes);
    c.unavailableDates = new Set(this.unavailableDates);
    c.availability = new Set(this.availability);
    c.byDate = new Map([...this.byDate].map(([k, v]) => [k, [...v]]));
    c.byWeek = new Map(this.byWeek);
    c.byWorkType = new Map(this.byWorkType);
    c.total = this.total;
    c.historyByWorkType = new Map(this.historyByWorkType);
    c.historyTotal = this.historyTotal;
    c.lastDateByWorkType = new Map(this.lastDateByWorkType);
    return c;
  }
}

/**
 * 检查某员工能否被排到某槽位。
 * @returns {null|{code: string, message: string}} null 表示可以排
 */
function checkSlot(emp, slot, period) {
  const { workDate, shiftSeq, shiftId, workTypeId } = slot;

  // H2 工作类型必须在报名范围内
  if (!emp.workTypes.has(workTypeId)) {
    return { code: REASON.NOT_ENROLLED, message: REASON_LABELS[REASON.NOT_ENROLLED] };
  }

  // H3 整日请假
  if (emp.unavailableDates.has(workDate)) {
    return { code: REASON.UNAVAILABLE_DATE, message: REASON_LABELS[REASON.UNAVAILABLE_DATE] };
  }

  // H4 精细可用时段（空集合 = 不限）
  if (emp.availability.size > 0 && !emp.availability.has(`${workDate}|${shiftId}`)) {
    return { code: REASON.NOT_AVAILABLE_SLOT, message: REASON_LABELS[REASON.NOT_AVAILABLE_SLOT] };
  }

  const dayShifts = emp.dayShifts(workDate);

  // H9 同一班次只能一个岗位（这里是显式检查，DB 索引兜底）
  if (dayShifts.includes(shiftSeq)) {
    return { code: REASON.SLOT_TAKEN, message: REASON_LABELS[REASON.SLOT_TAKEN] };
  }

  // H5 每日上限
  if (dayShifts.length >= period.maxShiftsPerDay) {
    return { code: REASON.DAILY_LIMIT, message: REASON_LABELS[REASON.DAILY_LIMIT] };
  }

  // H8 禁止连续班次
  if (period.forbidConsecutive) {
    for (const s of dayShifts) {
      if (Math.abs(s - shiftSeq) === 1) {
        return { code: REASON.CONSECUTIVE, message: REASON_LABELS[REASON.CONSECUTIVE] };
      }
    }
  }

  // H6 周期上限（个人上限优先）
  if (emp.total >= emp.effectiveCap) {
    return { code: REASON.PERIOD_LIMIT, message: REASON_LABELS[REASON.PERIOD_LIMIT] };
  }

  // H7 每周上限
  if (emp.weekCount(workDate) >= period.maxShiftsPerWeek) {
    return { code: REASON.WEEKLY_LIMIT, message: REASON_LABELS[REASON.WEEKLY_LIMIT] };
  }

  return null;
}

/** 简化布尔判断 */
function canAssign(emp, slot, period) {
  return checkSlot(emp, slot, period) === null;
}

module.exports = {
  REASON,
  REASON_LABELS,
  EmployeeState,
  checkSlot,
  canAssign,
};
