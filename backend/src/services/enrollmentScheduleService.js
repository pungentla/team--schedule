'use strict';

const db = require('../db/db');
const scheduleRepo = require('../repositories/scheduleRepo');
const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const { checkSlot } = require('../scheduler/constraints');
const audit = require('../repositories/auditRepo');
const { today, nowIso, addDays, weekday } = require('../utils/date');
const { pairProblem } = require('../scheduler/dutyPairs');

// Use the published requirements snapshot, including jobs since disabled in configuration.
function refreshPublishedRun(runId, viewer) {
  const run = scheduleRepo.findRun(runId);
  const view = require('./scheduleService').getSchedule(run.period_id, { ...viewer, role: 'admin' }, { runId });
  const byWork = new Map();
  const byDateShift = [];
  const oldShortages = new Map((view.gaps?.byDateShift || []).flatMap((d) => d.items.map((i) => [`${d.workDate}|${d.shiftId}|${i.workTypeId}|${i.dutyRole || 'member'}`, i])));
  for (const day of view.matrix) for (const shift of day.shifts) {
    const group = { workDate: day.workDate, shiftId: shift.shiftId, shiftName: shift.shiftName, shiftSeq: shift.shiftSeq, items: [], gapTotal: 0 };
    for (const cell of shift.workTypes) {
      if (!byWork.has(cell.workTypeId)) byWork.set(cell.workTypeId, { workTypeId: cell.workTypeId, workTypeName: cell.workTypeName, workTypeColor: cell.workTypeColor, requiresRoles: !!cell.requiresRoles, need: 0, filled: 0, gap: 0 });
      const work = byWork.get(cell.workTypeId);
      work.need += cell.needCount; work.filled += cell.filled; work.gap += cell.gap;
      const roles = cell.roleGaps || [];
      const shortages = roles.map((role) => ({ dutyRole: role, need: 1, filled: 0, gap: 1 }));
      if (cell.gap > roles.length) shortages.push({ dutyRole: cell.requiresRoles ? 'either' : 'member', need: cell.needCount - roles.length, filled: cell.filled, gap: cell.gap - roles.length });
      for (const shortage of shortages) {
        const old = oldShortages.get(`${day.workDate}|${shift.shiftId}|${cell.workTypeId}|${shortage.dutyRole}`);
        const reason = old?.gap === shortage.gap ? { reason: old.reason, reasonMessage: old.reasonMessage, counts: old.counts, candidates: old.candidates } : { reason: 'enrollment_changed', reasonMessage: '报名变更后仍有空位，请管理员补充安排', counts: null, candidates: [] };
        group.items.push({ ...shortage, workTypeId: cell.workTypeId, workTypeName: cell.workTypeName, workTypeColor: cell.workTypeColor, ...reason });
      }
      group.gapTotal += cell.gap;
    }
    if (group.items.length) byDateShift.push(group);
  }
  const assigned = new Map();
  view.assignments.forEach((a) => {
    if (!assigned.has(a.userId)) assigned.set(a.userId, new Set());
    assigned.get(a.userId).add(`${a.workDate}|${a.shiftId}`);
  });
  const totalFilled = view.assignments.length;
  const totalGap = byDateShift.reduce((total, group) => total + group.gapTotal, 0);
  const fillRate = run.total_needed ? Number((1 - totalGap / run.total_needed).toFixed(4)) : 1;
  const people = new Map((view.gaps?.byEmployee || []).map((e) => [e.userId, e]));
  for (const e of require('./enrollmentService').getEffectiveEnrollments(run.period_id)) people.set(e.userId, { userId: e.userId, name: e.name, employeeNo: e.employeeNo, maxShifts: e.maxShifts });
  const gaps = { ...(view.gaps || {}), totalNeeded: run.total_needed, totalFilled, totalGap, fillRate, byDateShift,
    byWorkType: [...byWork.values()].sort((a, b) => b.gap - a.gap),
    byEmployee: [...people.values()].map((e) => ({ ...e, assigned: assigned.get(e.userId)?.size || 0, capped: e.maxShifts != null && (assigned.get(e.userId)?.size || 0) >= e.maxShifts })).sort((a, b) => b.assigned - a.assigned),
  };
  db.run('UPDATE schedule_runs SET total_filled=?,fill_rate=?,gaps_json=?,revision=revision+1 WHERE id=?', totalFilled, fillRate, JSON.stringify(gaps), runId);
  require('./swapService').refreshRunMetrics(runId);
}

function cancelPendingAssignmentSwaps(periodId, assignmentIds, ctx, detail) {
  if (!assignmentIds.length) return 0;
  const ids = new Set(assignmentIds);
  const swaps = db.all("SELECT * FROM swap_requests WHERE period_id=? AND status='pending'", periodId)
    .filter(swap => ids.has(swap.from_assignment_id) || ids.has(swap.to_assignment_id));
  for (const swap of swaps) {
    db.run("UPDATE swap_requests SET status='cancelled',decided_at=? WHERE id=?", nowIso(), swap.id);
    audit.log({ action: audit.ACTIONS.SWAP_CANCEL, entityType: 'swap', entityId: swap.id, periodId,
      actorId: ctx.user.id, requestId: ctx.requestId, detail });
  }
  return swaps.length;
}

/** Runs inside the enrollment transaction; released records remain available for audit. */
function applyPublishedEnrollment(periodId, userId, workTypeIds, workTypes, ctx) {
  const afterDate = today();
  const now = nowIso();
  const selected = new Set(workTypeIds);
  const weekdaysByWork = new Map(workTypes.map((work) => [work.workTypeId, work.weekdays]));
  const assignments = db.all(`SELECT a.* FROM assignments a JOIN schedule_runs r ON r.id=a.run_id AND r.status='published'
    WHERE a.period_id=? AND a.user_id=? AND a.status='active' AND a.work_date>?`, periodId, userId, afterDate).filter((a) => {
    const weekdays = weekdaysByWork.get(a.work_type_id);
    return selected.has(a.work_type_id) || (weekdays && !weekdays.includes(weekday(a.work_date)));
  });
  for (const a of assignments) {
    db.run("UPDATE assignments SET status='released',released_at=? WHERE id=? AND status='active'", now, a.id);
    audit.log({ action: audit.ACTIONS.ASSIGNMENT_MANUAL, entityType: 'assignment', entityId: a.id, periodId, actorId: ctx.user.id, requestId: ctx.requestId,
      detail: { action: 'enrollment_withdrawal', userId, workTypeId: a.work_type_id, workDate: a.work_date, afterDate } });
  }
  const cancelledSwapCount = cancelPendingAssignmentSwaps(periodId, assignments.map(a => a.id), ctx, { reason: 'enrollment_withdrawal', userId });
  const run = scheduleRepo.findPublishedRun(periodId);
  const added = run ? fillUpcomingVacancies(run, userId, afterDate, ctx) : [];
  if (run && (assignments.length || added.length)) refreshPublishedRun(run.id, ctx.user);
  const lastDate = added.at(-1);
  const nearEnd = addDays(afterDate, 6);
  return { afterDate, endDate: lastDate > nearEnd ? lastDate : nearEnd, withdrawnWorkTypeIds: workTypeIds, removedCount: assignments.length, addedCount: added.length, cancelledSwapCount };
}

function fillUpcomingVacancies(run, userId, startDate, ctx) {
  const period = periodRepo.findPeriod(run.period_id);
  const { emp } = require('./swapService').buildEmployeeState(period, userId);
  const view = require('./scheduleService').getSchedule(period.id, { ...ctx.user, role: 'admin' }, { runId: run.id });
  const works = new Map(configRepo.listWorkTypes({ includeInactive: false }).map((w) => [w.id, w]));
  const shifts = new Set(configRepo.listShifts({ includeInactive: false }).map((s) => s.id));
  const endDate = addDays(startDate, 6);
  const limits = periodRepo.toPeriodDto(period);
  const added = [];
  function assign(person, slot) {
    const id = scheduleRepo.insertSwapAssignment({ runId: run.id, periodId: period.id, ...slot, userId: person.id, source: 'algo', isFixed: person.fixedOnly.has(slot.workTypeId) });
    person.addAssignment({ date: slot.workDate, shiftSeq: slot.shiftSeq, workTypeId: slot.workTypeId });
    audit.log({ action: audit.ACTIONS.ASSIGNMENT_MANUAL, entityType: 'assignment', entityId: id, periodId: period.id, actorId: ctx.user.id, requestId: ctx.requestId,
      detail: { action: 'enrollment_autofill', userId: person.id, ...slot } });
    added.push(slot.workDate);
  }
  for (const day of view.matrix) {
    if (day.workDate < startDate) continue;
    for (const shift of day.shifts) {
      if (!shifts.has(shift.shiftId)) continue;
      const cells = [...shift.workTypes].sort((a, b) => (emp.workTypes.get(a.workTypeId) || 99) - (emp.workTypes.get(b.workTypeId) || 99));
      for (const cell of cells) {
        const work = works.get(cell.workTypeId);
        if (!work || !JSON.parse(work.weekdays_json).includes(weekday(day.workDate))) continue;
        if (!cell.fillAllEnrolled && (day.workDate > endDate || cell.filled >= cell.needCount)) continue;
        const pairs = JSON.parse(work.duty_pairs_json);
        const baseSlot = { workDate: day.workDate, shiftId: shift.shiftId, shiftSeq: shift.shiftSeq, workTypeId: cell.workTypeId, allowConcurrent: true };
        const fillPair = () => {
          const candidates = pairs.filter((p) => p.primaryUserId === userId || p.deputyUserId === userId).map((pair) => {
            const partnerId = pair.primaryUserId === userId ? pair.deputyUserId : pair.primaryUserId;
            const partner = require('./swapService').buildEmployeeState(period, partnerId).emp;
            const ownSlot = { ...baseSlot, dutyRole: pair.primaryUserId === userId ? 'primary' : 'deputy' };
            const partnerSlot = { ...baseSlot, dutyRole: ownSlot.dutyRole === 'primary' ? 'deputy' : 'primary' };
            return { partner, ownSlot, partnerSlot };
          }).filter((c) => cell.needCount >= 2 && !checkSlot(emp, c.ownSlot, limits) && !checkSlot(c.partner, c.partnerSlot, limits)
            && !pairProblem(pairs, [...cell.assigned, { userId, dutyRole: c.ownSlot.dutyRole }, { userId: c.partner.id, dutyRole: c.partnerSlot.dutyRole }]));
          const score = require('../scheduler/scoring').scoreEmployee;
          const scoringContext = { seed: run.seed, employees: [emp, ...candidates.map((c) => c.partner)] };
          candidates.sort((a, b) => score(b.partner, b.partnerSlot, scoringContext) - score(a.partner, a.partnerSlot, scoringContext) || a.partner.id - b.partner.id);
          if (candidates.length) { const c = candidates[0]; assign(emp, c.ownSlot); assign(c.partner, c.partnerSlot); }
        };
        if (pairs.length && !cell.assigned.length) {
          fillPair();
          continue;
        }
        const roles = cell.requiresRoles ? [...new Set([...cell.roleGaps, ...(cell.fillAllEnrolled || cell.gap > cell.roleGaps.length ? ['primary', 'deputy'] : [])])] : ['member'];
        let filled = false;
        for (const dutyRole of roles) {
          const slot = { ...baseSlot, dutyRole };
          if (checkSlot(emp, slot, limits)) continue;
          if (pairProblem(pairs, [...cell.assigned, { userId, dutyRole }])) continue;
          assign(emp, slot);
          filled = true;
          break;
        }
        if (!filled && cell.fillAllEnrolled && pairs.length) fillPair();
      }
    }
  }
  return added;
}

module.exports = { applyPublishedEnrollment, cancelPendingAssignmentSwaps, refreshPublishedRun };
