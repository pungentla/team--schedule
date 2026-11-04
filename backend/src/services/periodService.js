'use strict';

/** 排班周期服务：周期管理 / 需求格子生成 / 需求人数配置 */

const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { PERIOD_STATUS, PERIOD_DEFAULTS } = require('../config');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { dateRange, isDateString, diffDays, today } = require('../utils/date');

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

function createPeriod({ name, startDate, endDate, maxShiftsPerDay, maxShiftsPerWeek, forbidConsecutive, enrollmentDeadline }, ctx) {
  if (!isDateString(startDate) || !isDateString(endDate)) throw badRequest('日期格式必须是 YYYY-MM-DD');
  if (endDate < startDate) throw badRequest('结束日期不能早于开始日期');
  if (diffDays(startDate, endDate) > 92) throw badRequest('单个周期最长 92 天');

  const id = periodRepo.insertPeriod({
    name,
    startDate,
    endDate,
    maxShiftsPerDay: maxShiftsPerDay ?? PERIOD_DEFAULTS.maxShiftsPerDay,
    maxShiftsPerWeek: maxShiftsPerWeek ?? PERIOD_DEFAULTS.maxShiftsPerWeek,
    forbidConsecutive: forbidConsecutive ?? true,
    status: PERIOD_STATUS.DRAFT,
    enrollmentDeadline: enrollmentDeadline || null,
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

  return periodRepo.toPeriodDto(periodRepo.findPeriod(id));
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

  const shifts = configRepo.listShifts({ includeInactive: false });
  const targetShifts = shiftIds && shiftIds.length ? shifts.filter((s) => shiftIds.includes(s.id)) : shifts;
  if (!targetShifts.length) throw badRequest('没有可用的班次，请先配置班次');
  if (shiftIds && shiftIds.length && targetShifts.length !== shiftIds.length) {
    throw badRequest('包含不存在或已停用的班次');
  }

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
      const workTypes = configRepo.listWorkTypes({ includeInactive: false });
      const slotRows = db.all('SELECT * FROM period_slots WHERE period_id = ?', periodId);
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
            periodRepo.upsertRequirement(periodId, slot.work_date, slot.shift_id, wt.id, defaultNeed);
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

  // 先全量校验，避免部分写入
  for (const it of items) {
    if (!isDateString(it.workDate)) throw badRequest(`日期格式错误: ${it.workDate}`);
    if (it.workDate < p.start_date || it.workDate > p.end_date) {
      throw badRequest(`日期 ${it.workDate} 不在周期内`);
    }
    if (!shifts.has(it.shiftId)) throw badRequest(`班次 ${it.shiftId} 不存在`);
    if (!workTypes.has(it.workTypeId)) throw badRequest(`工作类型 ${it.workTypeId} 不存在`);
    if (!Number.isInteger(it.needCount) || it.needCount < 0 || it.needCount > 99) {
      throw badRequest('需求人数必须是 0-99 的整数');
    }
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
  const slots = periodRepo.listSlots(periodId);
  const allWorkTypes = configRepo.listWorkTypes({ includeInactive: false }).map(configRepo.toWorkTypeDto);
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
        needCount: reqMap.get(`${s.work_date}|${s.shift_id}|${wt.id}`) || 0,
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
    totalNeeded: periodRepo.totalNeeded(periodId),
  };
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
    const enrolled = db.pluck(
      `SELECT COUNT(*) FROM enrollments WHERE period_id = ? AND status = 'submitted'`,
      p.id
    );
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
    enrolledCount: db.pluck(
      `SELECT COUNT(*) FROM enrollments WHERE period_id = ? AND status = 'submitted'`,
      id
    ),
  };
}

module.exports = {
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
