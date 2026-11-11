'use strict';

/** 工作类型 / 班次 仓储 */

const db = require('../db/db');
const { nowIso } = require('../utils/date');

// ---------------------------- work_types ----------------------------

function listWorkTypes({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.all(`SELECT * FROM work_types ${where} ORDER BY sort_order ASC, id ASC`);
}

function findWorkType(id) {
  return db.get('SELECT * FROM work_types WHERE id = ?', id);
}

function findWorkTypeByCode(code) {
  return db.get('SELECT * FROM work_types WHERE code = ?', code);
}

function insertWorkType({ code, name, description = null, color = '#4A90D9', sortOrder = 0, active = 1, requiresRoles = false, weekdays = [0, 1, 2, 3, 4, 5, 6], allowWeekdaySelection = false, fillAllEnrolled = false, defaultNeed = requiresRoles ? 2 : 1, weeklyAssignments = [], dutyPairs = [] }) {
  const now = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO work_types (code, name, description, color, sort_order, active, requires_roles, weekdays_json, allow_weekday_selection, fill_all_enrolled, default_need, weekly_assignments_json, duty_pairs_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code,
    name,
    description,
    color,
    sortOrder,
    active,
    requiresRoles ? 1 : 0,
    JSON.stringify(weekdays),
    allowWeekdaySelection,
    fillAllEnrolled,
    defaultNeed,
    JSON.stringify(weeklyAssignments),
    JSON.stringify(dutyPairs),
    now,
    now
  );
  return lastInsertRowid;
}

function updateWorkType(id, fields) {
  const map = {
    name: 'name',
    description: 'description',
    color: 'color',
    sortOrder: 'sort_order',
    active: 'active',
    requiresRoles: 'requires_roles',
    weekdays: 'weekdays_json',
    allowWeekdaySelection: 'allow_weekday_selection',
    fillAllEnrolled: 'fill_all_enrolled',
    defaultNeed: 'default_need',
    weeklyAssignments: 'weekly_assignments_json',
    dutyPairs: 'duty_pairs_json',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(key === 'requiresRoles' ? Number(fields[key]) : ['weekdays', 'weeklyAssignments', 'dutyPairs'].includes(key) ? JSON.stringify(fields[key]) : fields[key]);
    }
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  return db.run(`UPDATE work_types SET ${sets.join(', ')} WHERE id = ?`, ...params).changes;
}

// ---------------------------- shifts ----------------------------

function listShifts({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.all(`SELECT * FROM shifts ${where} ORDER BY seq ASC`);
}

function findShift(id) {
  return db.get('SELECT * FROM shifts WHERE id = ?', id);
}

function findShiftByCode(code) {
  return db.get('SELECT * FROM shifts WHERE code = ?', code);
}

function insertShift({ code, name, startTime, endTime, seq, color = '#7B8794', active = 1 }) {
  const now = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO shifts (code, name, start_time, end_time, seq, color, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code,
    name,
    startTime,
    endTime,
    seq,
    color,
    active,
    now,
    now
  );
  return lastInsertRowid;
}

function updateShift(id, fields) {
  const map = {
    name: 'name',
    startTime: 'start_time',
    endTime: 'end_time',
    seq: 'seq',
    color: 'color',
    active: 'active',
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  return db.run(`UPDATE shifts SET ${sets.join(', ')} WHERE id = ?`, ...params).changes;
}

// ---------------------------- 视图映射 ----------------------------

function toWorkTypeDto(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    color: r.color,
    sortOrder: r.sort_order,
    active: r.active === 1,
    requiresRoles: r.requires_roles === 1,
    weekdays: JSON.parse(r.weekdays_json),
    allowWeekdaySelection: r.allow_weekday_selection === 1,
    fillAllEnrolled: r.fill_all_enrolled === 1,
    defaultNeed: r.default_need,
    weeklyAssignments: JSON.parse(r.weekly_assignments_json),
    dutyPairs: JSON.parse(r.duty_pairs_json),
  };
}

function toShiftDto(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    startTime: r.start_time.slice(0, 5),
    endTime: r.end_time.slice(0, 5),
    seq: r.seq,
    color: r.color,
    active: r.active === 1,
  };
}

module.exports = {
  listWorkTypes,
  findWorkType,
  findWorkTypeByCode,
  insertWorkType,
  updateWorkType,
  listShifts,
  findShift,
  findShiftByCode,
  insertShift,
  updateShift,
  toWorkTypeDto,
  toShiftDto,
};
