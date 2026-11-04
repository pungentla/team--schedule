'use strict';

/** 排班周期服务：周期管理 / 需求格子生成 / 需求人数配置 */

const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const enrollmentRepo = require('../repositories/enrollmentRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { PERIOD_STATUS, PERIOD_DEFAULTS } = require('../config');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');
const { requireArray, requireInt } = require('../utils/validate');
const { nowIso, dateRange, isDateString, diffDays, today, weekday } = require('../utils/date');

const ALLOWED_TRANSITIONS = {
  draft: ['enrolling', 'archived'],
  enrolling: ['scheduling', 'draft', 'archived'],
  scheduling: ['published', 'enrolling', 'archived'],
  published: ['archived'],
  archived: [],
};

function assertPeriod(id) {
  const p = periodRepo.findPeriod(id);
  if (!p) throw notFound('排班周期不存在');
  return p;
}

function validateScope(ids, rows, label) {
  if (ids === undefined) return null;
  const selected = requireArray(ids, label, { min: 1, max: 1000 }).map((id) => requireInt(id, label, { min: 1 }));
  if (new Set(selected).size !== selected.length) throw badRequest(`${label}不能重复`);
  if (selected.some((id) => !rows.some((r) => r.id === id && r.active))) throw badRequest(`${label}包含不存在或已停用的项目`);
  return selected.sort((a, b) => a - b);
}

function createPeriod({ name, startDate, endDate, maxShiftsPerDay, maxShiftsPerWeek, forbidConsecutive, enrollmentDeadline, initializeRequirements = false, workTypeIds, shiftIds }, ctx) {
  if (!isDateString(startDate) || !isDateString(endDate)) throw badRequest('日期格式必须是 YYYY-MM-DD');
  if (endDate < startDate) throw badRequest('结束日期不能早于开始日期');
  if (diffDays(startDate, endDate) > 365) throw badRequest('单个周期最长一年（含首尾最多 366 天）');

  workTypeIds = validateScope(workTypeIds, configRepo.listWorkTypes(), '本次工作');
  shiftIds = validateScope(shiftIds, configRepo.listShifts(), '本次班次');
  return db.tx(() => {
    if (initializeRequirements && (!configRepo.listShifts({ includeInactive: false }).length || !configRepo.listWorkTypes({ includeInactive: false }).length)) throw badRequest('请先在基础设置中启用至少一个工作和班次，再创建排班');
    const id = periodRepo.insertPeriod({
      name,
      startDate,
      endDate,
      maxShiftsPerDay: maxShiftsPerDay ?? PERIOD_DEFAULTS.maxShiftsPerDay,
      maxShiftsPerWeek: maxShiftsPerWeek ?? PERIOD_DEFAULTS.maxShiftsPerWeek,
      forbidConsecutive: forbidConsecutive ?? true,
      status: PERIOD_STATUS.DRAFT,
      enrollmentDeadline: enrollmentDeadline || null,
      workTypeIds, shiftIds,
    });

    auditRepo.log({
      action: auditRepo.ACTIONS.PERIOD_CREATE,
      entityType: 'period',
      entityId: id,
      periodId: id,
      actorId: ctx.user.id,
      detail: { name, startDate, endDate },
      requestId: ctx.requestId,
    });

    if (initializeRequirements) prepareRequirements(id, ctx);
    return periodRepo.toPeriodDto(periodRepo.findPeriod(id));
  });
}

function updatePeriod(id, fields, ctx) {
  const p = assertPeriod(id);
  if (p.status === PERIOD_STATUS.PUBLISHED && fields.status === undefined) {
    // 已发布的周期仍允许改约束（影响的是下次生成），但改名/改日期要谨慎
    const dateChanged =
      (fields.startDate && fields.startDate !== p.start_date) ||
      (fields.endDate && fields.endDate !== p.end_date);
    if (dateChanged) throw conflict('PERIOD_PUBLISHED', '已发布的周期不能修改起止日期');
  }
  if (fields.startDate && !isDateString(fields.startDate)) throw badRequest('日期格式错误');
  if (fields.endDate && !isDateString(fields.endDate)) throw badRequest('日期格式错误');
  const startDate = fields.startDate ?? p.start_date;
  const endDate = fields.endDate ?? p.end_date;
  if (endDate < startDate) throw badRequest('结束日期不能早于开始日期');
  if (diffDays(startDate, endDate) > 365) throw badRequest('单个周期最长一年（含首尾最多 366 天）');
  const outside = db.pluck('SELECT COUNT(*) FROM period_slots WHERE period_id=? AND (work_date<? OR work_date>?)', id, startDate, endDate);
  if (outside) throw conflict('PERIOD_HAS_SLOTS', '新的日期范围不能排除已配置的班次日期，请保留原范围或创建新周期');

  periodRepo.updatePeriod(id, fields);
  auditRepo.log({
    action: auditRepo.ACTIONS.PERIOD_UPDATE,
    entityType: 'period',
    entityId: id,
    periodId: id,
    actorId: ctx.user.id,
    detail: fields,
    requestId: ctx.requestId,
  });
  return periodRepo.toPeriodDto(periodRepo.findPeriod(id));
}

/** 状态流转，带合法性校验 */
function changeStatus(id, nextStatus, ctx) {
  const p = assertPeriod(id);
  const allowed = ALLOWED_TRANSITIONS[p.status] || [];
  if (p.status === nextStatus) return periodRepo.toPeriodDto(p);
  if (!allowed.includes(nextStatus)) {
    throw conflict(
      'INVALID_STATUS_TRANSITION',
      `周期状态不能从 ${p.status} 变为 ${nextStatus}（允许：${allowed.join(', ') || '无'}）`
    );
  }
  periodRepo.updatePeriod(id, { status: nextStatus });
  auditRepo.log({
    action: auditRepo.ACTIONS.PERIOD_UPDATE,
    entityType: 'period',
    entityId: id,
    periodId: id,
    actorId: ctx.user.id,
    detail: { from: p.status, to: nextStatus },
    requestId: ctx.requestId,
  });
  return periodRepo.toPeriodDto(periodRepo.findPeriod(id));
}

/**
 * 按班次模板批量生成需求格子。
 * 对周期内每一天 × 每个启用班次，插入 period_slots。
 */
function generateSlots(periodId, { dates = null, shiftIds = null, defaultNeed = 0 }, ctx) {
  const p = assertPeriod(periodId);
  if (p.status === PERIOD_STATUS.PUBLISHED || p.status === PERIOD_STATUS.ARCHIVED) {
    throw conflict('PERIOD_LOCKED', '已发布/已归档的周期不能重新生成需求格子');
  }

  const allDates = dates && dates.length ? dates : dateRange(p.start_date, p.end_date);
  for (const d of allDates) {
    if (!isDateString(d)) throw badRequest(`日期格式错误: ${d}`);
    if (d < p.start_date || d > p.end_date) throw badRequest(`日期 ${d} 不在周期范围内`);
  }

  const scope = periodRepo.getScope(p);
  const shifts = configRepo.listShifts({ includeInactive: false }).filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.id));
  const targetShifts = shiftIds && shiftIds.length ? shifts.filter((s) => shiftIds.includes(s.id)) : shifts;
  if (shiftIds && shiftIds.length && targetShifts.length !== shiftIds.length) {
    throw badRequest('包含不存在、已停用或不在本周期选择范围内的班次');
  }
  if (!targetShifts.length) throw badRequest('没有可用的班次，请先配置班次');

  let created = 0;
  db.tx(() => {
    for (const d of allDates) {
      for (const s of targetShifts) {
        const before = periodRepo.findSlot(periodId, d, s.id);
        periodRepo.insertSlot(periodId, d, s.id);
        if (!before) created += 1;
      }
    }

    // 可选：给新建格子批量填默认需求人数（对所有启用工作类型）
    if (defaultNeed > 0) {
      const workTypes = configRepo.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id));
      const slotRows = db.all('SELECT * FROM period_slots WHERE period_id = ?', periodId).filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.shift_id));
      for (const slot of slotRows) {
        for (const wt of workTypes) {
          const exists = db.get(
            `SELECT 1 FROM slot_requirements
              WHERE period_id = ? AND work_date = ? AND shift_id = ? AND work_type_id = ?`,
            periodId,
            slot.work_date,
            slot.shift_id,
            wt.id
          );
          if (!exists) {
            const allowed = JSON.parse(wt.weekdays_json).includes(weekday(slot.work_date));
            const fixedCount = JSON.parse(wt.weekly_assignments_json).filter((r) => r.weekday === weekday(slot.work_date) && r.shiftId === slot.shift_id).length;
            const need = Math.max(defaultNeed, fixedCount, wt.requires_roles ? 2 : 0);
            periodRepo.upsertRequirement(periodId, slot.work_date, slot.shift_id, wt.id, allowed ? need : 0);
          }
        }
      }
    }
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.SLOTS_GENERATE,
    entityType: 'period',
    entityId: periodId,
    periodId,
    actorId: ctx.user.id,
    detail: { dates: allDates.length, shifts: targetShifts.length, created, defaultNeed },
    requestId: ctx.requestId,
  });

  return { created, dates: allDates.length, shifts: targetShifts.length };
}

/** 批量设置需求人数 */
function setRequirements(periodId, items, ctx) {
  const p = assertPeriod(periodId);
  if (p.status === PERIOD_STATUS.PUBLISHED || p.status === PERIOD_STATUS.ARCHIVED) {
    // 已发布周期允许调整未来日期的需求？这里保守禁止，需先回退状态
    throw conflict('PERIOD_LOCKED', '已发布/已归档的周期不能修改需求人数');
  }

  const shifts = new Map(configRepo.listShifts().map((s) => [s.id, s]));
  const workTypes = new Map(configRepo.listWorkTypes().map((w) => [w.id, w]));

  const scope = periodRepo.getScope(p);
  // 先全量校验，避免部分写入
  for (const it of items) {
    if (!isDateString(it.workDate)) throw badRequest(`日期格式错误: ${it.workDate}`);
    if (it.workDate < p.start_date || it.workDate > p.end_date) {
      throw badRequest(`日期 ${it.workDate} 不在周期内`);
    }
    if (!shifts.has(it.shiftId)) throw badRequest(`班次 ${it.shiftId} 不存在`);
    if ((scope.workTypeIds !== null && !scope.workTypeIds.includes(it.workTypeId)) || (scope.shiftIds !== null && !scope.shiftIds.includes(it.shiftId))) throw badRequest('该工作或班次不在本周期选择范围内');
    if (!workTypes.has(it.workTypeId)) throw badRequest(`工作类型 ${it.workTypeId} 不存在`);
    if (!Number.isInteger(it.needCount) || it.needCount < 0 || it.needCount > 99) {
      throw badRequest('需求人数必须是 0-99 的整数');
    }
    if (workTypes.get(it.workTypeId).requires_roles && it.needCount === 1) throw badRequest('需要主副负责人的工作，总需求人数必须为 0（不安排）或至少 2 人');
    if (it.needCount > 0 && !JSON.parse(workTypes.get(it.workTypeId).weekdays_json).includes(weekday(it.workDate))) throw badRequest(`${workTypes.get(it.workTypeId).name} 在 ${it.workDate} 不开放，请先修改工作类型的工作日设置`);
    if (!periodRepo.findSlot(periodId, it.workDate, it.shiftId)) {
      throw badRequest(`${it.workDate} 的该班次尚未开班，请先生成需求格子`);
    }
  }

  let updated = 0;
  db.tx(() => {
    for (const it of items) {
      periodRepo.upsertRequirement(periodId, it.workDate, it.shiftId, it.workTypeId, it.needCount);
      updated += 1;
    }
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.REQUIREMENT_UPDATE,
    entityType: 'period',
    entityId: periodId,
    periodId,
    actorId: ctx.user.id,
    detail: { count: updated },
    requestId: ctx.requestId,
  });

  return { updated, totalNeeded: periodRepo.totalNeeded(periodId) };
}

/**
 * 读取完整需求矩阵：日期 × 班次 × 工作类型
 * 返回结构便于前端直接渲染表格
 */
function getRequirementMatrix(periodId) {
  const p = assertPeriod(periodId);
  const scope = periodRepo.getScope(p);
  const activeShifts = new Set(configRepo.listShifts({ includeInactive: false }).map((s) => s.id));
  const locked = ['published', 'archived'].includes(p.status);
  const slots = periodRepo.listSlots(periodId).filter((s) => (locked || activeShifts.has(s.shift_id)) && (scope.shiftIds === null || scope.shiftIds.includes(s.shift_id)));
  const allWorkTypes = configRepo.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id)).map(configRepo.toWorkTypeDto);
  const shiftMap = new Map();
  for (const s of slots) {
    shiftMap.set(s.shift_id, {
      shiftId: s.shift_id,
      shiftName: s.shift_name,
      shiftSeq: s.seq,
      startTime: s.start_time.slice(0, 5),
      endTime: s.end_time.slice(0, 5),
      shiftColor: s.shift_color,
    });
  }

  const reqRows = db.all(
    'SELECT work_date, shift_id, work_type_id, need_count FROM slot_requirements WHERE period_id = ? AND need_count > 0',
    periodId
  );
  const reqMap = new Map();
  for (const r of reqRows) {
    reqMap.set(`${r.work_date}|${r.shift_id}|${r.work_type_id}`, r.need_count);
  }

  const dates = [];
  const byDate = new Map();
  for (const s of slots) {
    if (!byDate.has(s.work_date)) {
      byDate.set(s.work_date, {
        workDate: s.work_date,
        shifts: [],
      });
      dates.push(s.work_date);
    }
    const entry = byDate.get(s.work_date);
    if (entry.shifts.some((x) => x.shiftId === s.shift_id)) continue;
    entry.shifts.push({
      shiftId: s.shift_id,
      shiftName: s.shift_name,
      shiftSeq: s.seq,
      startTime: s.start_time.slice(0, 5),
      endTime: s.end_time.slice(0, 5),
      shiftColor: s.shift_color,
      requirements: allWorkTypes.map((wt) => ({
        workTypeId: wt.id,
        workTypeName: wt.name,
        workTypeColor: wt.color,
        allowed: wt.weekdays.includes(weekday(s.work_date)),
        needCount: wt.weekdays.includes(weekday(s.work_date)) ? (reqMap.get(`${s.work_date}|${s.shift_id}|${wt.id}`) || 0) : 0,
      })),
    });
  }

  dates.sort();
  for (const d of byDate.values()) d.shifts.sort((a, b) => a.shiftSeq - b.shiftSeq);

  return {
    period: periodRepo.toPeriodDto(p),
    workTypes: allWorkTypes,
    shifts: [...shiftMap.values()].sort((a, b) => a.shiftSeq - b.shiftSeq),
    dates: dates.map((d) => byDate.get(d)),
    totalNeeded: [...byDate.values()].reduce((total, day) => total + day.shifts.reduce((n, shift) => n + shift.requirements.reduce((m, r) => m + r.needCount, 0), 0), 0),
  };
}

function applyWorkRules(periodId, ctx, { skipSlots = null } = {}) {
  const p = assertPeriod(periodId);
  if (['published', 'archived'].includes(p.status)) throw conflict('PERIOD_LOCKED', '已发布或归档的周期不能覆盖需求');
  const slots = periodRepo.listSlots(periodId);
  if (!slots.length) throw badRequest('请先生成日期和班次格子');
  const scope = periodRepo.getScope(p);
  const workTypes = configRepo.listWorkTypes({ includeInactive: false }).filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id));
  const shifts = new Set(configRepo.listShifts({ includeInactive: false }).filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.id)).map((s) => s.id));
  let updated = 0;
  db.tx(() => {
    for (const slot of slots) {
      if (scope.shiftIds !== null && !scope.shiftIds.includes(slot.shift_id)) continue;
      if (skipSlots?.has(`${slot.work_date}|${slot.shift_id}`)) continue;
      for (const work of workTypes) {
        const allowed = shifts.has(slot.shift_id) && JSON.parse(work.weekdays_json).includes(weekday(slot.work_date));
        const fixedCount = JSON.parse(work.weekly_assignments_json).filter((r) => r.weekday === weekday(slot.work_date) && r.shiftId === slot.shift_id).length;
        const need = Math.max(work.default_need, fixedCount, work.requires_roles && fixedCount > 0 ? 2 : 0);
        periodRepo.upsertRequirement(periodId, slot.work_date, slot.shift_id, work.id, allowed ? need : 0);
        updated += 1;
      }
    }
    auditRepo.log({ action: auditRepo.ACTIONS.REQUIREMENT_UPDATE, entityType: 'period', entityId: periodId, periodId, actorId: ctx.user.id, detail: { updated, source: 'work_rules' }, requestId: ctx.requestId });
  });
  return { updated };
}

/** 初始化缺少的日期、班次和默认需求，保留管理员已经填写的数值（包括 0）。 */
function prepareRequirements(periodId, ctx) {
  return db.tx(() => {
    // 历史的 0 人需求以无记录表示，整格保留才能避免把明确关闭的工作重新开放。
    const skipSlots = new Set(periodRepo.listSlots(periodId).map((s) => `${s.work_date}|${s.shift_id}`));
    generateSlots(periodId, { defaultNeed: 0 }, ctx);
    return applyWorkRules(periodId, ctx, { skipSlots });
  });
}

/**
 * 选出「当前周期」—— 与 periodRepo.findCurrentPeriod 同一口径（按日期范围）。
 * 这里保留一层包装，便于路由层拿到带报名数/需求的完整 DTO。
 */
function findCurrentPeriod(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const t = today();
  const active = list.filter((p) => p.status !== 'archived');

  const covering = active
    .filter((p) => p.startDate <= t && p.endDate >= t)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (covering) return covering;

  const upcoming = active
    .filter((p) => p.startDate > t)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (upcoming) return upcoming;

  return active.slice().sort((a, b) => b.endDate.localeCompare(a.endDate))[0] || list[0] || null;
}

function listPeriods() {
  return periodRepo.listPeriods().map((p) => {
    const dto = periodRepo.toPeriodDto(p);
    const enrolled = enrollmentRepo.countSubmittedEnrollments(p.id);
    const totalEmployees = db.pluck(`SELECT COUNT(*) FROM users WHERE status = 'active'`);
    const publishedRun = db.get(
      `SELECT id, total_needed, total_filled, fill_rate FROM schedule_runs WHERE period_id = ? AND status = 'published'`,
      p.id
    );
    return {
      ...dto,
      enrolledCount: enrolled,
      totalEmployees,
      totalNeeded: periodRepo.totalNeeded(p.id),
      publishedRun: publishedRun
        ? {
            id: publishedRun.id,
            totalNeeded: publishedRun.total_needed,
            totalFilled: publishedRun.total_filled,
            fillRate: publishedRun.fill_rate,
          }
        : null,
    };
  });
}

function getPeriod(id) {
  const p = assertPeriod(id);
  const dto = periodRepo.toPeriodDto(p);
  const shiftCount = db.pluck('SELECT COUNT(*) FROM period_slots WHERE period_id = ?', id);
  return {
    ...dto,
    slotCount: shiftCount,
    totalNeeded: periodRepo.totalNeeded(id),
    enrolledCount: enrollmentRepo.countSubmittedEnrollments(id),
  };
}

function requirePeriodManager(ctx, superOnly = false) {
  if (!ctx?.user || (superOnly ? ctx.user.role !== 'super_admin' : !['admin', 'super_admin'].includes(ctx.user.role))) {
    throw forbidden(superOnly ? '仅超级管理员可以查看回收站或恢复周期' : '仅管理员可以删除周期');
  }
}

function deletePeriod(id, ctx) {
  requirePeriodManager(ctx);
  return db.tx(() => {
    const period = periodRepo.findPeriod(id, { includeDeleted: true });
    if (!period) throw notFound('排班周期不存在');
    if (!period.deleted_at) {
      db.run('UPDATE periods SET deleted_at=?, deleted_by=?, updated_at=? WHERE id=?', nowIso(), ctx.user.id, nowIso(), id);
      auditRepo.log({ action: auditRepo.ACTIONS.PERIOD_DELETE, entityType: 'period', entityId: id, periodId: id, actorId: ctx.user.id, detail: { name: period.name, status: period.status }, requestId: ctx.requestId });
    }
    return { id, deleted: true };
  });
}

function listDeletedPeriods(ctx) {
  requirePeriodManager(ctx, true);
  return db.all(`SELECT p.*, u.name AS deleted_by_name FROM periods p LEFT JOIN users u ON u.id=p.deleted_by
    WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC,p.id DESC`).map((p) => ({ ...periodRepo.toPeriodDto(p), deletedAt: p.deleted_at, deletedBy: p.deleted_by, deletedByName: p.deleted_by_name }));
}

function restorePeriod(id, ctx) {
  requirePeriodManager(ctx, true);
  return db.tx(() => {
    const period = periodRepo.findPeriod(id, { includeDeleted: true });
    if (!period) throw notFound('排班周期不存在');
    if (period.deleted_at) {
      db.run('UPDATE periods SET deleted_at=NULL, deleted_by=NULL, updated_at=? WHERE id=?', nowIso(), id);
      auditRepo.log({ action: auditRepo.ACTIONS.PERIOD_RESTORE, entityType: 'period', entityId: id, periodId: id, actorId: ctx.user.id, detail: { name: period.name, status: period.status }, requestId: ctx.requestId });
    }
    return getPeriod(id);
  });
}

module.exports = {
  deletePeriod, listDeletedPeriods, restorePeriod,
  prepareRequirements,
  applyWorkRules,
  findCurrentPeriod,
  createPeriod,
  updatePeriod,
  changeStatus,
  generateSlots,
  setRequirements,
  getRequirementMatrix,
  listPeriods,
  getPeriod,
  assertPeriod,
};
