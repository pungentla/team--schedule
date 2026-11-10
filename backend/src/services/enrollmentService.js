'use strict';

/** 报名服务：提交意愿、可用时段、请假 */

const enrollmentRepo = require('../repositories/enrollmentRepo');
const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const userRepo = require('../repositories/userRepo');
const { requireArray } = require('../utils/validate');
const db = require('../db/db');
const { PERIOD_STATUS, ENROLLMENT_STATUS } = require('../config');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');
const { isDateString } = require('../utils/date');

function submittedWorkIds(enrollment) {
  if (!enrollment) return [];
  if (enrollment.submitted_work_type_ids_json !== null) return JSON.parse(enrollment.submitted_work_type_ids_json);
  return enrollment.status === 'submitted' ? enrollmentRepo.listEnrollmentWorkTypes(enrollment.id).map((w) => w.work_type_id) : [];
}

/** 周期报名与管理员长期报名合并；固定资格仅适用于指定星期、班次和角色。 */
function getEffectiveEnrollments(periodId) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  const scope = periodRepo.getScope(period);
  const withdrawals = new Map(db.all('SELECT user_id,withdrawn_work_type_ids_json FROM enrollments WHERE period_id=?', periodId).map((e) => [e.user_id, new Set(JSON.parse(e.withdrawn_work_type_ids_json))]));
  const entries = new Map(enrollmentRepo.loadSubmittedEnrollments(periodId).map((e) => [e.userId, { ...e, hasSubmitted: true }]));
  const users = new Map(db.all("SELECT id,name,employee_no FROM users WHERE status='active'").map((u) => [u.id, u]));
  const activeShifts = new Set(configRepo.listShifts({ includeInactive: false }).filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.id)).map((s) => s.id));
  for (const work of configRepo.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id))) {
    for (const rule of JSON.parse(work.weekly_assignments_json)) {
      const user = users.get(rule.userId);
      if (withdrawals.get(rule.userId)?.has(work.id)) continue;
      if (!user || !activeShifts.has(rule.shiftId) || !JSON.parse(work.weekdays_json).includes(rule.weekday)) continue;
      if (!entries.has(user.id)) entries.set(user.id, { userId: user.id, name: user.name, employeeNo: user.employee_no, maxShifts: null, workTypes: [], hasSubmitted: false });
      const entry = entries.get(user.id);
      let wt = entry.workTypes.find((w) => w.workTypeId === work.id);
      if (!wt) { wt = { workTypeId: work.id, priority: 1, dutyRole: 'member', fixedOnly: true }; entry.workTypes.push(wt); }
      if (!wt.fixedRules) wt.fixedRules = [];
      wt.fixedRules.push(rule);
    }
  }
  for (const e of entries.values()) e.workTypes = e.workTypes.filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.workTypeId));
  return [...entries.values()].filter((e) => e.workTypes.length).sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
}

function assertEditable(period, { allowDraft = false } = {}) {
  if (!period) throw notFound('排班周期不存在');
  if (period.status === PERIOD_STATUS.ARCHIVED) {
    throw conflict('PERIOD_LOCKED', '该周期已归档，不能再修改报名');
  }
  if (period.status === PERIOD_STATUS.DRAFT && !allowDraft) {
    throw conflict('PERIOD_NOT_OPEN', '该周期尚未开放报名');
  }
}

/**
 * 提交/更新报名（幂等 upsert）。
 * @param {object} payload
 *   { workTypes: [{ workTypeId, priority }], maxShifts, availability: [{workDate, shiftId}],
 *     unavailability: [{workDate, reason}], note, submit: boolean }
 */
function saveEnrollment(periodId, userId, payload, ctx, { byAdmin = false } = {}) {
  const period = periodRepo.findPeriod(periodId);
  if (byAdmin) requireEnrollmentAdmin(ctx);
  assertEditable(period, { allowDraft: byAdmin });

  const previous = enrollmentRepo.findEnrollment(periodId, userId);
  const submittedWorkTypeIds = submittedWorkIds(previous);
  const submit = payload.submit !== false; // 默认提交
  const workTypes = payload.workTypes || [];

  // ---- 校验 ----
  const scope = periodRepo.getScope(period);
  const validWorkTypes = new Map(configRepo.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id)).map((w) => [w.id, w]));
  const seen = new Set();
  const normalizedWt = [];
  for (const item of workTypes) {
    const wtId = Number(item.workTypeId);
    if (!validWorkTypes.has(wtId)) throw badRequest(`工作类型 ${item.workTypeId} 不存在或不在本周期选择范围内`);
    if (seen.has(wtId)) throw badRequest('工作类型不能重复选择');
    seen.add(wtId);
    const priority = Number(item.priority ?? 1);
    if (![1, 2, 3].includes(priority)) throw badRequest('意愿优先级必须是 1、2 或 3');
    const requiresRoles = validWorkTypes.get(wtId).requires_roles === 1;
    const dutyRole = requiresRoles ? (item.dutyRole ?? 'member') : 'member';
    if (!['member', 'primary', 'deputy', 'both'].includes(dutyRole)) throw badRequest('报名角色必须是主负责人、副负责人或两者皆可');
    if (submit && requiresRoles && dutyRole === 'member') throw badRequest(`请为「${validWorkTypes.get(wtId).name}」选择主负责人、副负责人或两者皆可`);
    normalizedWt.push({ workTypeId: wtId, priority, dutyRole });
  }
  if (submit && normalizedWt.length === 0 && !submittedWorkTypeIds.length && !JSON.parse(previous?.withdrawn_work_type_ids_json || '[]').length && !getEffectiveEnrollments(periodId).some((e) => e.userId === userId && e.workTypes.some((w) => w.fixedRules?.length))) throw badRequest('至少选择一种工作类型才能提交报名');

  const maxShifts = payload.maxShifts === undefined || payload.maxShifts === null || payload.maxShifts === ''
    ? null
    : Number(payload.maxShifts);
  if (maxShifts !== null && (!Number.isInteger(maxShifts) || maxShifts < 0)) {
    throw badRequest('个人班次上限必须是 0 或正整数');
  }

  const availSlots = payload.availability || [];
  for (const s of availSlots) {
    if (scope.shiftIds !== null && !scope.shiftIds.includes(Number(s.shiftId))) throw badRequest('可用班次不在本周期选择范围内');
    if (!isDateString(s.workDate)) throw badRequest(`可用日期格式错误: ${s.workDate}`);
    if (s.workDate < period.start_date || s.workDate > period.end_date) {
      throw badRequest(`可用日期 ${s.workDate} 不在周期内`);
    }
  }

  const unavail = payload.unavailability || [];
  for (const d of unavail) {
    const wd = typeof d === 'string' ? d : d.workDate;
    if (!isDateString(wd)) throw badRequest(`请假日期格式错误: ${wd}`);
    if (wd < period.start_date || wd > period.end_date) {
      throw badRequest(`请假日期 ${wd} 不在周期内`);
    }
  }

  // ---- 写入（单事务，先删后插保证幂等） ----
  let enrollmentId;
  let scheduleChanges = null;
  db.tx(() => {
    const existing = enrollmentRepo.findEnrollment(periodId, userId);
    if (existing) {
      enrollmentId = existing.id;
      enrollmentRepo.updateEnrollmentMeta(enrollmentId, {
        maxShifts,
        status: submit ? ENROLLMENT_STATUS.SUBMITTED : ENROLLMENT_STATUS.DRAFT,
        note: payload.note ?? null,
      });
    } else {
      enrollmentId = enrollmentRepo.createEnrollment({
        periodId,
        userId,
        maxShifts,
        status: submit ? ENROLLMENT_STATUS.SUBMITTED : ENROLLMENT_STATUS.DRAFT,
        note: payload.note ?? null,
      });
    }

    enrollmentRepo.replaceEnrollmentWorkTypes(enrollmentId, normalizedWt);
    enrollmentRepo.replaceAvailability(periodId, userId, availSlots);
    enrollmentRepo.replaceUnavailability(periodId, userId, unavail);
    if (submit) {
      const selectedIds = normalizedWt.map((w) => w.workTypeId);
      const removedIds = submittedWorkTypeIds.filter((id) => !selectedIds.includes(id));
      const withdrawn = new Set(previous ? JSON.parse(previous.withdrawn_work_type_ids_json) : []);
      removedIds.forEach((id) => withdrawn.add(id));
      selectedIds.forEach((id) => withdrawn.delete(id));
      db.run('UPDATE enrollments SET submitted_work_type_ids_json=?,withdrawn_work_type_ids_json=? WHERE id=?', JSON.stringify(selectedIds), JSON.stringify([...withdrawn]), enrollmentId);
      if (period.status === PERIOD_STATUS.PUBLISHED) {
        scheduleChanges = require('./enrollmentScheduleService').applyPublishedEnrollment(periodId, userId, removedIds, ctx);
      }
    }
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.ENROLL_SUBMIT,
    entityType: 'enrollment',
    entityId: enrollmentId,
    periodId,
    actorId: ctx.user.id,
    detail: {
      targetUserId: userId,
      submittedByAdmin: byAdmin,
      scheduleChanges,
      workTypes: normalizedWt,
      maxShifts,
      availabilityCount: availSlots.length,
      unavailabilityCount: unavail.length,
      submitted: submit,
    },
    requestId: ctx.requestId,
  });

  return { ...getMyEnrollment(periodId, userId), ...(scheduleChanges ? { scheduleChanges } : {}) };
}

function requireEnrollmentAdmin(ctx) {
  if (!['admin', 'super_admin'].includes(ctx.user?.role)) throw forbidden('仅管理员可以代报名');
}
function getProxyTarget(userId) {
  const user = userRepo.findById(userId);
  if (!user) throw notFound('人员不存在');
  if (user.status !== 'active') throw badRequest('该账号已停用，不能代报名');
  return user;
}
function getAdminEnrollment(periodId, userId, ctx) {
  requireEnrollmentAdmin(ctx);
  const user = getProxyTarget(userId);
  return { user: userRepo.publicUser(user), context: getEnrollContext(periodId, userId), enrollment: getMyEnrollment(periodId, userId) };
}
function saveAdminEnrollment(periodId, userId, payload, ctx) {
  requireEnrollmentAdmin(ctx);
  const workTypes = requireArray(payload.workTypes, '工作类型', { min: 0, max: 50 });
  return db.tx(() => {
    getProxyTarget(userId);
    const previous = getMyEnrollment(periodId, userId);
    return saveEnrollment(periodId, userId, {
      workTypes, maxShifts: previous.maxShifts, availability: previous.availability,
      unavailability: previous.unavailability, note: previous.note, submit: true,
    }, ctx, { byAdmin: true });
  });
}

/** 我的报名详情 */
function getMyEnrollment(periodId, userId) {
  if (!periodRepo.findPeriod(periodId)) throw notFound('排班周期不存在');
  const e = enrollmentRepo.findEnrollment(periodId, userId);
  if (!e) {
    return {
      exists: false,
      submittedWorkTypeIds: [],
      withdrawnWorkTypeIds: [],
      periodId,
      workTypes: [],
      maxShifts: null,
      availability: [],
      unavailability: [],
      status: null,
    };
  }
  return {
    exists: true,
    submittedWorkTypeIds: submittedWorkIds(e),
    withdrawnWorkTypeIds: JSON.parse(e.withdrawn_work_type_ids_json),
    enrollmentId: e.id,
    periodId,
    status: e.status,
    maxShifts: e.max_shifts,
    note: e.note,
    submittedAt: e.submitted_at,
    submittedByName: auditRepo.enrollmentProxyName(e),
    workTypes: enrollmentRepo.listEnrollmentWorkTypes(e.id).map((w) => ({
      workTypeId: w.work_type_id,
      name: w.name,
      color: w.color,
      priority: w.priority,
      dutyRole: w.duty_role,
    })),
    availability: enrollmentRepo.listAvailability(periodId, userId).map((a) => ({
      workDate: a.work_date,
      shiftId: a.shift_id,
    })),
    unavailability: enrollmentRepo.listUnavailability(periodId, userId).map((u) => ({
      workDate: u.work_date,
      reason: u.reason,
    })),
  };
}

/** 管理员查看报名汇总 */
function listEnrollments(periodId) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  const items = enrollmentRepo.listEnrollmentsWithDetails(periodId);
  const totalEmployees = db.pluck(`SELECT COUNT(*) FROM users WHERE status = 'active'`);
  return {
    periodId,
    totalEmployees,
    submittedCount: enrollmentRepo.countSubmittedEnrollments(periodId),
    effectiveCount: getEffectiveEnrollments(periodId).length,
    items,
  };
}

/** 报名配置页所需的上下文：可选工作类型、班次、日期 */
function getEnrollContext(periodId, userId) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  const scope = periodRepo.getScope(period);
  return {
    period: periodRepo.toPeriodDto(period),
    workTypes: configRepo.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id)).map(configRepo.toWorkTypeDto),
    shifts: configRepo.listShifts({ includeInactive: false }).filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.id)).map(configRepo.toShiftDto),
    dates: periodRepo.listSlots(periodId).map((s) => s.work_date).filter((v, i, a) => a.indexOf(v) === i),
    fixedAssignments: getEffectiveEnrollments(periodId).find((e) => e.userId === userId)?.workTypes.flatMap((w) => (w.fixedRules || []).map((r) => ({ ...r, workTypeId: w.workTypeId, workTypeName: configRepo.findWorkType(w.workTypeId).name, shiftName: configRepo.findShift(r.shiftId).name }))) || [],
  };
}

module.exports = {
  getAdminEnrollment,
  saveAdminEnrollment,
  getEffectiveEnrollments,
  saveEnrollment,
  getMyEnrollment,
  listEnrollments,
  getEnrollContext,
};
