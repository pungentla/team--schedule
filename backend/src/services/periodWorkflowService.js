'use strict';
const periods = require('../repositories/periodRepo');
const configs = require('../repositories/configRepo');
const schedules = require('../repositories/scheduleRepo');
const { getEffectiveEnrollments } = require('./enrollmentService');
const { EmployeeState } = require('../scheduler/constraints');
const { weekday } = require('../utils/date');
const { notFound } = require('../utils/errors');

function getPreparation(periodId) {
  const period = periods.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  const scope = periods.getScope(period);
  const workTypes = new Map(configs.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id)).map((w) => [w.id, w]));
  const shifts = new Set(configs.listShifts({ includeInactive: false }).filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.id)).map((s) => s.id));
  const slots = periods.listSlots(periodId).filter((s) => shifts.has(s.shift_id));
  const requirements = periods.listRequirements(periodId).filter((r) => shifts.has(r.shift_id) && workTypes.has(r.work_type_id) && JSON.parse(workTypes.get(r.work_type_id).weekdays_json).includes(weekday(r.work_date)));
  const allCells = requirements.map((r) => ({ workDate: r.work_date, shiftId: r.shift_id, workTypeId: r.work_type_id, dutyRole: workTypes.get(r.work_type_id).requires_roles ? 'either' : 'member' }));
  const cells = [...new Map(allCells.map((c) => [`${weekday(c.workDate)}|${c.shiftId}|${c.workTypeId}|${c.dutyRole}`, c])).values()];
  const participants = getEffectiveEnrollments(periodId).flatMap((e) => {
    const emp = new EmployeeState(e, periods.toPeriodDto(period));
    if (!cells.some((cell) => emp.matchesWork(cell))) return [];
    const hasFixed = e.workTypes.some((w) => (w.fixedRules || []).some((r) => cells.some((c) => c.workTypeId === w.workTypeId && c.shiftId === r.shiftId && weekday(c.workDate) === r.weekday)));
    const works = e.workTypes.flatMap((entry) => {
      const work = workTypes.get(entry.workTypeId);
      return work ? [{ id: work.id, name: work.name, fixedOnly: !!entry.fixedOnly }] : [];
    });
    return [{
      userId: e.userId, name: e.name, employeeNo: e.employeeNo, hasSubmitted: e.hasSubmitted,
      hasFixed, maxShifts: e.maxShifts, submittedAt: e.submittedAt ?? null, workTypes: works,
    }];
  });
  const totalNeeded = requirements.reduce((n, r) => n + r.need_count, 0);
  const blockers = [];
  if (period.status === 'archived') blockers.push({ step: 'generate', message: '周期已归档，仅供查看。' });
  if (!workTypes.size) blockers.push({ step: 'requirements', configTab: 'worktypes', message: '没有可用工作，请先启用。' });
  if (!shifts.size) blockers.push({ step: 'requirements', configTab: 'shifts', message: '没有可用班次，请先启用。' });
  if (workTypes.size && shifts.size && !slots.length) blockers.push({ step: 'requirements', message: '本周期尚未初始化需求。' });
  else if (workTypes.size && shifts.size && !totalNeeded) blockers.push({ step: 'requirements', message: '需求人数为 0，请设置人数。' });
  if (requirements.some((r) => workTypes.get(r.work_type_id).requires_roles && r.need_count < 2)) blockers.push({ step: 'requirements', message: '主副工作每班人数至少为 2，请修改需求。' });
  if (totalNeeded && !participants.length) blockers.push({ step: 'people', message: '暂无参与人员，请先报名。' });
  const draft = schedules.findLatestDraftRun(periodId);
  const published = schedules.findPublishedRun(periodId);
  return {
    period: periods.toPeriodDto(period), slotCount: slots.length, workTypeCount: workTypes.size, shiftCount: shifts.size,
    totalNeeded, participants, submittedCount: participants.filter((e) => e.hasSubmitted).length, fixedCount: participants.filter((e) => e.hasFixed).length,
    canGenerate: blockers.length === 0, blockers,
    nextStep: blockers[0]?.step || (draft || published ? 'generate' : 'people'),
    draftRunId: draft?.id || null, publishedRunId: published?.id || null,
    publishedTotalNeeded: published?.total_needed ?? null,
  };
}
module.exports = { getPreparation };
