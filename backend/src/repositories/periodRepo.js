'use strict';

/** 排班周期 / 需求格子 / 需求人数 仓储 */

const db = require('../db/db');
const { nowIso, today } = require('../utils/date');
const { PERIOD_DEFAULTS } = require('../config');

function insertPeriod({
  name,
  startDate,
  endDate,
  maxShiftsPerDay = PERIOD_DEFAULTS.maxShiftsPerDay,
  maxShiftsPerWeek = PERIOD_DEFAULTS.maxShiftsPerWeek,
  forbidConsecutive = true,
  status = 'draft',
  enrollmentDeadline = null,
}) {
  const now = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO periods
       (name, start_date, end_date, max_shifts_per_day, max_shifts_per_week,
        forbid_consecutive, status, enrollment_deadline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name,
    startDate,
    endDate,
    maxShiftsPerDay,
    maxShiftsPerWeek,
    forbidConsecutive ? 1 : 0,
    status,
    enrollmentDeadline,
    now,
    now
  );
  return lastInsertRowid;
}

function findPeriod(id) {
  return db.get('SELECT * FROM periods WHERE id = ?', id);
}

function listPeriods({ status = null } = {}) {
  if (status) {
    return db.all('SELECT * FROM periods WHERE status = ? ORDER BY start_date DESC', status);
  }
  return db.all('SELECT * FROM periods ORDER BY start_date DESC');
}

function updatePeriod(id, fields) {
  const map = {
    name: 'name',
    startDate: 'start_date',
    endDate: 'end_date',
    maxShiftsPerDay: 'max_shifts_per_day',
    maxShiftsPerWeek: 'max_shifts_per_week',
    forbidConsecutive: 'forbid_consecutive',
    status: 'status',
    enrollmentDeadline: 'enrollment_deadline',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key]);
    }
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  return db.run(`UPDATE periods SET ${sets.join(', ')} WHERE id = ?`, ...params).changes;
}

/**
 * 找当前周期 —— 按日期范围判定，不按状态。
 *
 * 为什么不用 status：历史周期也是 published，按状态挑会命中更早的旧周期，
 * 让首页/总览展示上一周的数据。正确口径是"哪一周覆盖今天"。
 */
function findCurrentPeriod() {
  const t = today();
  return (
    // 1. 今天在这个周期范围内
    db.get(
      `SELECT * FROM periods
        WHERE status != 'archived' AND start_date <= ? AND end_date >= ?
        ORDER BY start_date ASC LIMIT 1`,
      t, t
    ) ||
    // 2. 最近一个还没开始的
    db.get(
      `SELECT * FROM periods
        WHERE status != 'archived' AND start_date > ?
        ORDER BY start_date ASC LIMIT 1`,
      t
    ) ||
    // 3. 都已过期 → 最近结束的
    db.get(
      `SELECT * FROM periods
        WHERE status != 'archived'
        ORDER BY end_date DESC LIMIT 1`
    ) ||
    // 4. 全部归档 → 退到最新一条，至少别返回 null
    db.get(`SELECT * FROM periods ORDER BY start_date DESC LIMIT 1`)
  );
}

// ---------------------------- period_slots ----------------------------

function insertSlot(periodId, workDate, shiftId) {
  db.run(
    `INSERT OR IGNORE INTO period_slots (period_id, work_date, shift_id) VALUES (?, ?, ?)`,
    periodId,
    workDate,
    shiftId
  );
}

function listSlots(periodId) {
  return db.all(
    `SELECT ps.*, s.name AS shift_name, s.start_time, s.end_time, s.seq, s.color AS shift_color
       FROM period_slots ps
       JOIN shifts s ON s.id = ps.shift_id
      WHERE ps.period_id = ?
      ORDER BY ps.work_date ASC, s.seq ASC`,
    periodId
  );
}

function findSlot(periodId, workDate, shiftId) {
  return db.get(
    'SELECT * FROM period_slots WHERE period_id = ? AND work_date = ? AND shift_id = ?',
    periodId,
    workDate,
    shiftId
  );
}

function deleteSlots(periodId) {
  db.run('DELETE FROM period_slots WHERE period_id = ?', periodId);
}

// ---------------------------- slot_requirements ----------------------------

/** upsert 需求人数；needCount = 0 时视为删除该需求 */
function upsertRequirement(periodId, workDate, shiftId, workTypeId, needCount) {
  if (needCount <= 0) {
    db.run(
      `DELETE FROM slot_requirements
        WHERE period_id = ? AND work_date = ? AND shift_id = ? AND work_type_id = ?`,
      periodId,
      workDate,
      shiftId,
      workTypeId
    );
    return;
  }
  db.run(
    `INSERT INTO slot_requirements (period_id, work_date, shift_id, work_type_id, need_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (period_id, work_date, shift_id, work_type_id)
     DO UPDATE SET need_count = excluded.need_count`,
    periodId,
    workDate,
    shiftId,
    workTypeId,
    needCount
  );
}

/** 带工作类型与班次信息的完整需求列表 */
function listRequirements(periodId) {
  return db.all(
    `SELECT r.*, wt.name AS work_type_name, wt.color AS work_type_color, wt.code AS work_type_code,
            s.name AS shift_name, s.seq, s.start_time, s.end_time
       FROM slot_requirements r
       JOIN work_types wt ON wt.id = r.work_type_id
       JOIN shifts s ON s.id = r.shift_id
      WHERE r.period_id = ? AND r.need_count > 0
      ORDER BY r.work_date ASC, s.seq ASC, wt.sort_order ASC, wt.id ASC`,
    periodId
  );
}

function totalNeeded(periodId) {
  return db.pluck(
    'SELECT COALESCE(SUM(need_count), 0) FROM slot_requirements WHERE period_id = ?',
    periodId
  );
}

// ---------------------------- DTO ----------------------------

function toPeriodDto(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    maxShiftsPerDay: r.max_shifts_per_day,
    maxShiftsPerWeek: r.max_shifts_per_week,
    forbidConsecutive: r.forbid_consecutive === 1,
    status: r.status,
    enrollmentDeadline: r.enrollment_deadline,
    createdAt: r.created_at,
  };
}

module.exports = {
  insertPeriod,
  findPeriod,
  listPeriods,
  updatePeriod,
  findCurrentPeriod,
  insertSlot,
  listSlots,
  findSlot,
  deleteSlots,
  upsertRequirement,
  listRequirements,
  totalNeeded,
  toPeriodDto,
};
