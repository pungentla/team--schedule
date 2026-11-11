'use strict';

const db = require('../db/db');
const scheduleRepo = require('../repositories/scheduleRepo');
const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const audit = require('../repositories/auditRepo');
const { getSchedule } = require('./scheduleService');
const { buildEmployeeState } = require('./swapService');
const { refreshPublishedRun, cancelPendingAssignmentSwaps } = require('./enrollmentScheduleService');
const { checkSlot } = require('../scheduler/constraints');
const { pairProblem } = require('../scheduler/dutyPairs');
const { weekday } = require('../utils/date');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');

function buildNewWork(period, target, people) {
  const { workDate, shiftId, workTypeId } = target;
  const scope = periodRepo.getScope(period);
  const shift = configRepo.findShift(shiftId);
  const work = configRepo.findWorkType(workTypeId);
  if (!shift?.active || !work?.active ||
    (scope.shiftIds !== null && !scope.shiftIds.includes(shiftId)) ||
    (scope.workTypeIds !== null && !scope.workTypeIds.includes(workTypeId))) {
    throw badRequest('请选择本周期启用的班次和工作');
  }
  if (!periodRepo.findSlot(period.id, workDate, shiftId) || !JSON.parse(work.weekdays_json).includes(weekday(workDate))) {
    throw badRequest('该工作在所选日期或班次不开放');
  }
  const requiresRoles = work.requires_roles === 1;
  const roles = people.map(person => person.dutyRole);
  if (requiresRoles ? roles.length !== 2 || !roles.includes('primary') || !roles.includes('deputy')
    : !roles.length || roles.some(role => role !== 'member')) {
    throw badRequest(requiresRoles ? '请选择一名主负责人和一名副负责人' : '请选择至少一名人员');
  }
  return { ...target, shiftSeq: shift.seq, workTypeName: work.name, workTypeColor: work.color,
    shiftName: shift.name, requiresRoles, needCount: people.length, fillAllEnrolled: work.fill_all_enrolled === 1, dutyPairs: JSON.parse(work.duty_pairs_json) };
}

function validatePeople(period, slot, people, existing = []) {
  const assignments = [...existing, ...people];
  if (new Set(assignments.map(person => person.userId)).size !== assignments.length) throw badRequest('同一工作不能重复选择人员');
  const problems = [];
  for (const person of people) {
    const { emp } = buildEmployeeState(period, person.userId);
    const problem = checkSlot(emp, { ...slot, dutyRole: person.dutyRole, manualOverride: true, allowConcurrent: true }, periodRepo.toPeriodDto(period));
    if (problem) problems.push({ ...problem, label: `${emp.name}：${problem.message}` });
  }
  const pair = pairProblem(slot.dutyPairs, assignments);
  if (pair) problems.push(pair);
  if (problems.length) throw conflict('PUBLISHED_WORK_CONSTRAINT_VIOLATION', '所选人员不符合排班条件', { problems });
}

function validateFill(period, cell, people) {
  if (!cell) throw conflict('PUBLISHED_WORK_MISSING', '该工作已移除，请刷新后重试');
  if (!cell.fillAllEnrolled && people.length > cell.gap) throw conflict('PUBLISHED_WORK_FULL', '该工作没有足够的空位');
  const roles = cell.requiresRoles ? ['primary', 'deputy'] : ['member'];
  if (people.some(person => !roles.includes(person.dutyRole))) throw badRequest('请选择该工作允许的岗位角色');
  const missingRoles = cell.roleGaps.filter(role => !people.some(person => person.dutyRole === role));
  if (!cell.fillAllEnrolled && missingRoles.length > cell.gap - people.length) throw badRequest('请优先补齐缺少的负责人角色');
  const work = configRepo.findWorkType(cell.workTypeId);
  validatePeople(period, { ...cell, dutyPairs: JSON.parse(work.duty_pairs_json) }, people, cell.assigned);
}

function updatePublishedWork(runId, { action, revision, workDate, shiftId, workTypeId, people }, ctx) {
  if (!['admin', 'super_admin'].includes(ctx.user?.role)) throw forbidden('仅管理员可调整生效排班');
  return db.tx(() => {
    const run = scheduleRepo.findRun(runId);
    if (!run) throw notFound('排班版本不存在');
    const period = periodRepo.findPeriod(run.period_id);
    if (run.status !== 'published' || period?.status !== 'published') throw conflict('PERIOD_LOCKED', '只能调整当前生效排班');
    if (run.revision !== revision) throw conflict('PUBLISHED_CHANGED', '排班已变化，请刷新后重试');
    if (workDate < period.start_date || workDate > period.end_date) throw badRequest('所选日期不在本周期内');
    const view = getSchedule(period.id, ctx.user, { runId });
    const matches = cell => cell.workDate === workDate && cell.shiftId === shiftId && cell.workTypeId === workTypeId;
    const cells = view.matrix.flatMap(day => day.shifts.flatMap(shift => shift.workTypes));
    const current = cells.find(matches);
    const requirements = (view.gaps?.requirements ?? cells.filter(cell => cell.needCount > 0).map(({
      workDate, shiftId, shiftSeq, workTypeId, workTypeName, workTypeColor, shiftName, needCount, requiresRoles,
    }) => ({ workDate, shiftId, shiftSeq, workTypeId, workTypeName, workTypeColor, shiftName, needCount, requiresRoles })))
      .filter(cell => !matches(cell));
    let removedIds = [];
    if (action === 'add') {
      if (current) throw conflict('PUBLISHED_WORK_EXISTS', '该日期和班次已包含这项工作');
      const slot = buildNewWork(period, { workDate, shiftId, workTypeId }, people);
      validatePeople(period, slot, people);
      requirements.push(slot);
    } else if (action === 'fill') {
      validateFill(period, current, people);
    } else if (action === 'remove') {
      if (!current) throw conflict('PUBLISHED_WORK_MISSING', '该工作已移除，请刷新后重试');
      removedIds = current.assigned.map(person => person.id);
      for (const id of removedIds) scheduleRepo.releaseAssignment(id);
      cancelPendingAssignmentSwaps(period.id, removedIds, ctx, { reason: 'published_work_removed' });
    } else {
      throw badRequest('无效的工作调整方式');
    }
    if (action !== 'remove') {
      scheduleRepo.bulkInsertAssignments(runId, period.id, people.map(person => ({ ...person, workDate, shiftId, workTypeId, source: 'manual' })));
    }
    if (action !== 'fill') {
      db.run('UPDATE schedule_runs SET total_needed=?,gaps_json=? WHERE id=?',
        requirements.reduce((total, cell) => total + cell.needCount, 0), JSON.stringify({ ...view.gaps, requirements }), runId);
    }
    refreshPublishedRun(runId, ctx.user);
    audit.log({ action: audit.ACTIONS.ASSIGNMENT_MANUAL, entityType: 'schedule_run', entityId: runId, periodId: period.id,
      actorId: ctx.user.id, requestId: ctx.requestId,
      detail: { action: { add: 'published_work_added', fill: 'published_work_filled', remove: 'published_work_removed' }[action],
        workDate, shiftId, workTypeId, people, removedIds },
    });
    return { runId, revision: run.revision + 1 };
  });
}

module.exports = { updatePublishedWork };
