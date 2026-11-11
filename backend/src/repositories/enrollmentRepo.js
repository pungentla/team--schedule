'use strict';

/** 报名（工作类型意愿 / 可用时段 / 请假）仓储 */

const db = require('../db/db');
const { nowIso } = require('../utils/date');

// ---------------------------- enrollments ----------------------------

function findEnrollment(periodId, userId) {
  return db.get('SELECT * FROM enrollments WHERE period_id = ? AND user_id = ?', periodId, userId);
}

function findEnrollmentById(id) {
  return db.get('SELECT * FROM enrollments WHERE id = ?', id);
}

function createEnrollment({ periodId, userId, maxShifts = null, status = 'draft', note = null }) {
  const now = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO enrollments (period_id, user_id, max_shifts, status, note, submitted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    periodId,
    userId,
    maxShifts,
    status,
    note,
    status === 'submitted' ? now : null,
    now,
    now
  );
  return lastInsertRowid;
}

function updateEnrollmentMeta(id, { maxShifts, status, note }) {
  const sets = [];
  const params = [];
  if (maxShifts !== undefined) {
    sets.push('max_shifts = ?');
    params.push(maxShifts);
  }
  if (status !== undefined) {
    sets.push('status = ?');
    params.push(status);
    sets.push('submitted_at = ?');
    params.push(status === 'submitted' ? nowIso() : null);
  }
  if (note !== undefined) {
    sets.push('note = ?');
    params.push(note);
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  return db.run(`UPDATE enrollments SET ${sets.join(', ')} WHERE id = ?`, ...params).changes;
}

/** 全周期已提交报名的员工 + 其工作类型（算法输入） */
function loadSubmittedEnrollments(periodId) {
  const rows = db.all(
    `SELECT e.id AS enrollment_id, e.user_id, e.max_shifts, e.note, e.submitted_at,
            u.display_name AS name, u.employee_no
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
      WHERE e.period_id = ? AND e.status = 'submitted' AND u.status = 'active'
      ORDER BY u.employee_no ASC`,
    periodId
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.enrollment_id);
  const placeholders = ids.map(() => '?').join(',');
  const wtRows = db.all(
    `SELECT enrollment_id, work_type_id, priority, duty_role, weekdays_json
       FROM enrollment_work_types WHERE enrollment_id IN (${placeholders})`,
    ...ids
  );

  const byEnrollment = new Map();
  for (const r of wtRows) {
    if (!byEnrollment.has(r.enrollment_id)) byEnrollment.set(r.enrollment_id, []);
    byEnrollment.get(r.enrollment_id).push({
      workTypeId: r.work_type_id,
      priority: r.priority,
      dutyRole: r.duty_role,
      weekdays: JSON.parse(r.weekdays_json),
    });
  }

  return rows.map((r) => ({
    enrollmentId: r.enrollment_id,
    userId: r.user_id,
    name: r.name,
    employeeNo: r.employee_no,
    maxShifts: r.max_shifts,
    note: r.note,
    submittedAt: r.submitted_at,
    workTypes: byEnrollment.get(r.enrollment_id) || [],
  }));
}

function countSubmittedEnrollments(periodId) {
  return db.pluck(`SELECT COUNT(*) FROM enrollments e JOIN users u ON u.id=e.user_id
    WHERE e.period_id=? AND e.status='submitted' AND u.status='active'`, periodId);
}

/** 报名汇总（管理员视角） */
function listEnrollmentsWithDetails(periodId) {
  const rows = db.all(
    `SELECT e.*, u.display_name AS name, u.employee_no, u.role, u.status AS user_status
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
      WHERE e.period_id = ?
      ORDER BY e.status DESC, u.employee_no ASC`,
    periodId
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const wtRows = db.all(
    `SELECT ewt.enrollment_id, ewt.work_type_id, ewt.priority, ewt.duty_role, ewt.weekdays_json, wt.name, wt.color
       FROM enrollment_work_types ewt
       JOIN work_types wt ON wt.id = ewt.work_type_id
      WHERE ewt.enrollment_id IN (${placeholders})
      ORDER BY ewt.priority ASC`,
    ...ids
  );
  const unavailRows = db.all(
    `SELECT user_id, work_date, reason FROM unavailability_dates WHERE period_id = ?`,
    periodId
  );
  const availCount = db.all(
    `SELECT user_id, COUNT(*) AS cnt FROM availability_slots WHERE period_id = ? GROUP BY user_id`,
    periodId
  );

  const wtMap = new Map();
  for (const r of wtRows) {
    if (!wtMap.has(r.enrollment_id)) wtMap.set(r.enrollment_id, []);
    wtMap.get(r.enrollment_id).push({ workTypeId: r.work_type_id, name: r.name, color: r.color, priority: r.priority, dutyRole: r.duty_role, weekdays: JSON.parse(r.weekdays_json) });
  }
  const unavailMap = new Map();
  for (const r of unavailRows) {
    if (!unavailMap.has(r.user_id)) unavailMap.set(r.user_id, []);
    unavailMap.get(r.user_id).push(r.work_date);
  }
  const availMap = new Map(availCount.map((r) => [r.user_id, r.cnt]));

  return rows.map((r) => ({
    enrollmentId: r.id,
    userId: r.user_id,
    employeeNo: r.employee_no,
    name: r.name,
    maxShifts: r.max_shifts,
    status: r.status,
    note: r.note,
    submittedAt: r.submitted_at,
    workTypes: wtMap.get(r.id) || [],
    unavailabilityDates: unavailMap.get(r.user_id) || [],
    availabilitySlotCount: availMap.get(r.user_id) || 0,
  }));
}

// ---------------------------- enrollment_work_types ----------------------------

function replaceEnrollmentWorkTypes(enrollmentId, items) {
  db.run('DELETE FROM enrollment_work_types WHERE enrollment_id = ?', enrollmentId);
  for (const it of items) {
    db.run(
      'INSERT INTO enrollment_work_types (enrollment_id, work_type_id, priority, duty_role, weekdays_json) VALUES (?, ?, ?, ?, ?)',
      enrollmentId,
      it.workTypeId,
      it.priority,
      it.dutyRole || 'member',
      it.weekdays == null ? null : JSON.stringify(it.weekdays)
    );
  }
}

function listEnrollmentWorkTypes(enrollmentId) {
  return db.all(
    `SELECT ewt.*, wt.name, wt.color FROM enrollment_work_types ewt
       JOIN work_types wt ON wt.id = ewt.work_type_id
      WHERE ewt.enrollment_id = ? ORDER BY ewt.priority ASC`,
    enrollmentId
  );
}

// ---------------------------- availability_slots ----------------------------

function replaceAvailability(periodId, userId, slots) {
  db.run('DELETE FROM availability_slots WHERE period_id = ? AND user_id = ?', periodId, userId);
  for (const s of slots) {
    db.run(
      'INSERT OR IGNORE INTO availability_slots (period_id, user_id, work_date, shift_id) VALUES (?, ?, ?, ?)',
      periodId,
      userId,
      s.workDate,
      s.shiftId
    );
  }
}

function listAvailability(periodId, userId) {
  return db.all(
    `SELECT a.work_date, a.shift_id FROM availability_slots a
      WHERE a.period_id = ? AND a.user_id = ? ORDER BY a.work_date, a.shift_id`,
    periodId,
    userId
  );
}

/** 批量加载某周期的所有可用时段，返回 Map<userId, Set<'date|shiftId'>> */
function loadAvailabilityMap(periodId) {
  const rows = db.all(
    'SELECT user_id, work_date, shift_id FROM availability_slots WHERE period_id = ?',
    periodId
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, new Set());
    map.get(r.user_id).add(`${r.work_date}|${r.shift_id}`);
  }
  return map;
}

// ---------------------------- unavailability_dates ----------------------------

function replaceUnavailability(periodId, userId, dates) {
  db.run('DELETE FROM unavailability_dates WHERE period_id = ? AND user_id = ?', periodId, userId);
  for (const d of dates) {
    const workDate = typeof d === 'string' ? d : d.workDate;
    const reason = typeof d === 'string' ? null : d.reason ?? null;
    db.run(
      'INSERT OR IGNORE INTO unavailability_dates (period_id, user_id, work_date, reason) VALUES (?, ?, ?, ?)',
      periodId,
      userId,
      workDate,
      reason
    );
  }
}

function listUnavailability(periodId, userId) {
  return db.all(
    'SELECT work_date, reason FROM unavailability_dates WHERE period_id = ? AND user_id = ? ORDER BY work_date',
    periodId,
    userId
  );
}

/** 批量加载请假，返回 Map<userId, Set<date>> */
function loadUnavailabilityMap(periodId) {
  const rows = db.all(
    'SELECT user_id, work_date FROM unavailability_dates WHERE period_id = ?',
    periodId
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, new Set());
    map.get(r.user_id).add(r.work_date);
  }
  return map;
}

module.exports = {
  countSubmittedEnrollments,
  findEnrollment,
  findEnrollmentById,
  createEnrollment,
  updateEnrollmentMeta,
  loadSubmittedEnrollments,
  listEnrollmentsWithDetails,
  replaceEnrollmentWorkTypes,
  listEnrollmentWorkTypes,
  replaceAvailability,
  listAvailability,
  loadAvailabilityMap,
  replaceUnavailability,
  listUnavailability,
  loadUnavailabilityMap,
};
