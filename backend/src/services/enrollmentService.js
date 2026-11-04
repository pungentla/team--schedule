'use strict';

/** 报名服务：提交意愿、可用时段、请假 */

const enrollmentRepo = require('../repositories/enrollmentRepo');
const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { PERIOD_STATUS, ENROLLMENT_STATUS } = require('../config');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');
const { isDateString } = require('../utils/date');

function assertEditable(period) {
  if (!period) throw notFound('排班周期不存在');
  if (period.status === PERIOD_STATUS.PUBLISHED || period.status === PERIOD_STATUS.ARCHIVED) {
    throw conflict('PERIOD_LOCKED', '该周期排班已发布，不能再修改报名');
  }
  if (period.status === PERIOD_STATUS.DRAFT) {
    throw conflict('PERIOD_NOT_OPEN', '该周期尚未开放报名');
  }
}

/**
 * 提交/更新报名（幂等 upsert）。
 * @param {object} payload
 *   { workTypes: [{ workTypeId, priority }], maxShifts, availability: [{workDate, shiftId}],
 *     unavailability: [{workDate, reason}], note, submit: boolean }
 */
function saveEnrollment(periodId, userId, payload, ctx) {
  const period = periodRepo.findPeriod(periodId);
  assertEditable(period);

  const submit = payload.submit !== false; // 默认提交
  const workTypes = payload.workTypes || [];

  // ---- 校验 ----
  const validWorkTypes = new Map(configRepo.listWorkTypes().map((w) => [w.id, w]));
  const seen = new Set();
  const normalizedWt = [];
  for (const item of workTypes) {
    const wtId = Number(item.workTypeId);
    if (!validWorkTypes.has(wtId)) throw badRequest(`工作类型 ${item.workTypeId} 不存在`);
    if (seen.has(wtId)) throw badRequest('工作类型不能重复选择');
    seen.add(wtId);
    const priority = Number(item.priority ?? 1);
    if (![1, 2, 3].includes(priority)) throw badRequest('意愿优先级必须是 1、2 或 3');
    normalizedWt.push({ workTypeId: wtId, priority });
  }
  if (submit && normalizedWt.length === 0) throw badRequest('至少选择一种工作类型才能提交报名');

  const maxShifts = payload.maxShifts === undefined || payload.maxShifts === null || payload.maxShifts === ''
    ? null
    : Number(payload.maxShifts);
  if (maxShifts !== null && (!Number.isInteger(maxShifts) || maxShifts < 0)) {
    throw badRequest('个人班次上限必须是 0 或正整数');
  }

  const availSlots = payload.availability || [];
  for (const s of availSlots) {
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
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.ENROLL_SUBMIT,
    entityType: 'enrollment',
    entityId: enrollmentId,
    periodId,
    actorId: userId,
    detail: {
      workTypes: normalizedWt,
      maxShifts,
      availabilityCount: availSlots.length,
      unavailabilityCount: unavail.length,
      submitted: submit,
    },
    requestId: ctx.requestId,
  });

  return getMyEnrollment(periodId, userId);
}

/** 我的报名详情 */
function getMyEnrollment(periodId, userId) {
  const e = enrollmentRepo.findEnrollment(periodId, userId);
  if (!e) {
    return {
      exists: false,
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
    enrollmentId: e.id,
    periodId,
    status: e.status,
    maxShifts: e.max_shifts,
    note: e.note,
    submittedAt: e.submitted_at,
    workTypes: enrollmentRepo.listEnrollmentWorkTypes(e.id).map((w) => ({
      workTypeId: w.work_type_id,
      name: w.name,
      color: w.color,
      priority: w.priority,
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
  const totalEmployees = db.pluck(`SELECT COUNT(*) FROM users WHERE status = 'active' AND role = 'employee'`);
  return {
    periodId,
    totalEmployees,
    submittedCount: items.filter((i) => i.status === 'submitted').length,
    items,
  };
}

/** 报名配置页所需的上下文：可选工作类型、班次、日期 */
function getEnrollContext(periodId) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  return {
    period: periodRepo.toPeriodDto(period),
    workTypes: configRepo.listWorkTypes({ includeInactive: false }).map(configRepo.toWorkTypeDto),
    shifts: configRepo.listShifts({ includeInactive: false }).map(configRepo.toShiftDto),
    dates: periodRepo.listSlots(periodId).map((s) => s.work_date).filter((v, i, a) => a.indexOf(v) === i),
  };
}

module.exports = {
  saveEnrollment,
  getMyEnrollment,
  listEnrollments,
  getEnrollContext,
};
