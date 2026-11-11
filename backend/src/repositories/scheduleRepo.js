'use strict';

/** 排班结果仓储：schedule_runs / assignments */

const db = require('../db/db');
const { nowIso } = require('../utils/date');

// ---------------------------- schedule_runs ----------------------------

function insertRun({
  periodId,
  algoVersion,
  seed,
  inputHash,
  status,
  totalNeeded,
  totalFilled,
  fillRate,
  metricsJson,
  gapsJson,
  rounds,
  durationMs,
  createdBy,
}) {
  const { lastInsertRowid } = db.run(
    `INSERT INTO schedule_runs
       (period_id, algo_version, seed, input_hash, status, total_needed, total_filled, fill_rate,
        metrics_json, gaps_json, rounds, duration_ms, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    periodId,
    algoVersion,
    seed,
    inputHash,
    status,
    totalNeeded,
    totalFilled,
    fillRate,
    metricsJson,
    gapsJson,
    rounds,
    durationMs,
    createdBy,
    nowIso()
  );
  return lastInsertRowid;
}

function findRun(id) {
  return db.get('SELECT * FROM schedule_runs WHERE id = ?', id);
}

function findPublishedRun(periodId) {
  return db.get(
    `SELECT * FROM schedule_runs WHERE period_id = ? AND status = 'published'`,
    periodId
  );
}

function findLatestDraftRun(periodId) {
  return db.get(
    `SELECT * FROM schedule_runs WHERE period_id = ? AND status = 'draft'
      ORDER BY id DESC LIMIT 1`,
    periodId
  );
}

function listRuns(periodId) {
  return db.all('SELECT * FROM schedule_runs WHERE period_id = ? ORDER BY id DESC', periodId);
}

function updateRunStatus(id, status) {
  db.run('UPDATE schedule_runs SET status = ? WHERE id = ?', status, id);
}

// ---------------------------- assignments ----------------------------

/** 批量插入分配（单条语句 + 复用 prepared，性能足够） */
function bulkInsertAssignments(runId, periodId, items) {
  const now = nowIso();
  const stmt = db.getDb().prepare(
    `INSERT INTO assignments
       (run_id, period_id, work_date, shift_id, work_type_id, user_id, status, source, duty_role, is_fixed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  );
  for (const it of items) {
    stmt.run(
      runId,
      periodId,
      it.workDate,
      it.shiftId,
      it.workTypeId,
      it.userId,
      it.source || 'algo',
      it.dutyRole || 'member',
      it.isFixed ? 1 : 0,
      now
    );
  }
}

function countAssignments(runId) {
  return db.pluck(`SELECT COUNT(*) FROM assignments WHERE run_id = ? AND status = 'active'`, runId);
}

/** 带员工与班次信息的分配列表 */
function listAssignmentsWithUser(runId) {
  return db.all(
    `SELECT a.*, u.display_name AS name, u.employee_no,
            s.name AS shift_name, s.seq, s.start_time, s.end_time,
            wt.name AS work_type_name, wt.color AS work_type_color
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN shifts s ON s.id = a.shift_id
       JOIN work_types wt ON wt.id = a.work_type_id
      WHERE a.run_id = ? AND a.status = 'active'
      ORDER BY a.work_date ASC, s.seq ASC, wt.sort_order ASC, wt.id ASC, u.employee_no ASC`,
    runId
  );
}

function findAssignment(id) {
  return db.get('SELECT * FROM assignments WHERE id = ?', id);
}

function listActiveParticipants() {
  return db.all(
    `SELECT id, display_name AS name, employee_no FROM users WHERE status = 'active' ORDER BY employee_no`
  );
}

function listActiveParticipantCount() {
  return db.pluck(`SELECT COUNT(*) FROM users WHERE status = 'active'`);
}

/** 某人某周期已排（用于换班预检） */
function listUserAssignmentsInPeriod(periodId, userId) {
  return db.all(
    `SELECT a.*, s.seq AS shift_seq, s.name AS shift_name,
            wt.name AS work_type_name, wt.color AS work_type_color
       FROM assignments a
       JOIN shifts s ON s.id = a.shift_id
       JOIN work_types wt ON wt.id = a.work_type_id
       JOIN schedule_runs r ON r.id = a.run_id AND r.status = 'published'
      WHERE a.period_id = ? AND a.user_id = ? AND a.status = 'active'
      ORDER BY a.work_date, s.seq`,
    periodId,
    userId
  );
}

/** 释放一条分配（换班生效时用） */
function releaseAssignment(id) {
  return db.run(
    `UPDATE assignments SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'`,
    nowIso(),
    id
  ).changes;
}

/** 插入一条换班产生的分配 */
function insertSwapAssignment({ runId, periodId, workDate, shiftId, workTypeId, userId, dutyRole = 'member', source = 'swap', isFixed = false }) {
  const { lastInsertRowid } = db.run(
    `INSERT INTO assignments
       (run_id, period_id, work_date, shift_id, work_type_id, user_id, status, source, duty_role, is_fixed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    runId,
    periodId,
    workDate,
    shiftId,
    workTypeId,
    userId,
    source,
    dutyRole,
    isFixed ? 1 : 0,
    nowIso()
  );
  return lastInsertRowid;
}

module.exports = {
  insertRun,
  findRun,
  findPublishedRun,
  findLatestDraftRun,
  listRuns,
  updateRunStatus,
  bulkInsertAssignments,
  countAssignments,
  listAssignmentsWithUser,
  findAssignment,
  listActiveParticipants,
  listActiveParticipantCount,
  listUserAssignmentsInPeriod,
  releaseAssignment,
  insertSwapAssignment,
};
