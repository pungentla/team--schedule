'use strict';

/** 基础数据服务：工作类型 / 班次 */

const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { badRequest, conflict } = require('../utils/errors');
const { requireArray, requireInt, requireEnum } = require('../utils/validate');

function validateDutyPairs(items, requiresRoles) {
  const pairs = requireArray(items, '主副搭档', { max: 100 });
  if (pairs.length && !requiresRoles) throw badRequest('请先开启区分主副负责人');
  const seen = new Set();
  return pairs.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('每组搭档需填写主负责人和副负责人');
    const primaryUserId = requireInt(item.primaryUserId, '主负责人', { min: 1 });
    const deputyUserId = requireInt(item.deputyUserId, '副负责人', { min: 1 });
    if (primaryUserId === deputyUserId) throw badRequest('主副负责人必须是不同的人');
    if ([primaryUserId, deputyUserId].some((id) => db.get('SELECT status FROM users WHERE id=?', id)?.status !== 'active')) throw badRequest('搭档必须是已启用的账号');
    const key = `${primaryUserId}|${deputyUserId}`;
    if (seen.has(key)) throw badRequest('该主副搭配已存在');
    seen.add(key);
    return { primaryUserId, deputyUserId };
  });
}

function validateWeeklyAssignments(items, requiresRoles, weekdays) {
  const seen = new Set();
  const counts = new Map();
  return requireArray(items, '每周固定名单', { max: 1000 }).map((item) => {
    const weekday = requireInt(item.weekday, '固定星期', { min: 0, max: 6 });
    const shiftId = requireInt(item.shiftId, '固定班次', { min: 1 });
    const userId = requireInt(item.userId, '固定员工', { min: 1 });
    const dutyRole = requireEnum(item.dutyRole || 'member', '固定岗位角色', requiresRoles ? ['primary', 'deputy'] : ['member']);
    if (!weekdays.includes(weekday)) throw badRequest('固定名单的星期必须在该工作的开放工作日内');
    if (!configRepo.findShift(shiftId)?.active) throw badRequest('固定班次不存在或已停用');
    const user = db.get('SELECT role,status FROM users WHERE id=?', userId);
    if (!user || user.status !== 'active') throw badRequest('固定人员必须是已启用的账号');
    const key = `${weekday}|${shiftId}|${userId}`;
    if (seen.has(key)) throw badRequest('同一员工在同一个星期和班次的固定名单中不能重复');
    seen.add(key);
    const cell = `${weekday}|${shiftId}`;
    counts.set(cell, (counts.get(cell) || 0) + 1);
    if (counts.get(cell) > 99) throw badRequest('同一个星期和班次的固定人数不能超过 99 人');
    return { weekday, shiftId, userId, dutyRole };
  });
}

// ---------------------------- 工作类型 ----------------------------

function listWorkTypes(ctx) {
  const rows = configRepo.listWorkTypes({ includeInactive: true });
  const counts = db.all(
    'SELECT work_type_id, COUNT(*) AS cnt FROM enrollment_work_types GROUP BY work_type_id'
  );
  const countMap = new Map(counts.map((c) => [c.work_type_id, c.cnt]));
  return rows.map((r) => ({
    ...configRepo.toWorkTypeDto(r),
    enrolledCount: countMap.get(r.id) || 0,
  }));
}

function createWorkType({ code, name, description, color, sortOrder, requiresRoles, weekdays, defaultNeed, weeklyAssignments = [], dutyPairs = [] }, ctx) {
  weeklyAssignments = validateWeeklyAssignments(weeklyAssignments, requiresRoles, weekdays || [0, 1, 2, 3, 4, 5, 6]);
  dutyPairs = validateDutyPairs(dutyPairs, requiresRoles);
  if (requiresRoles && defaultNeed === 1) throw badRequest('主副工作默认人数必须为 0 或至少 2 人');
  if (configRepo.findWorkTypeByCode(code)) {
    throw conflict('WORK_TYPE_CODE_TAKEN', `工作类型编码 ${code} 已存在`);
  }
  const id = configRepo.insertWorkType({
    code,
    name,
    description: description ?? null,
    color: color || '#4A90D9',
    sortOrder: sortOrder ?? 0,
    active: 1,
    requiresRoles,
    weekdays,
    defaultNeed,
    weeklyAssignments,
    dutyPairs,
  });
  auditRepo.log({
    action: auditRepo.ACTIONS.WORK_TYPE_CREATE,
    entityType: 'work_type',
    entityId: id,
    actorId: ctx.user.id,
    detail: { code, name },
    requestId: ctx.requestId,
  });
  return configRepo.toWorkTypeDto(configRepo.findWorkType(id));
}

function updateWorkType(id, fields, ctx) {
  const existing = configRepo.findWorkType(id);
  if (!existing) throw badRequest('工作类型不存在');
  if (fields.dutyPairs !== undefined || fields.requiresRoles !== undefined) {
    fields.dutyPairs = validateDutyPairs(fields.dutyPairs ?? JSON.parse(existing.duty_pairs_json), fields.requiresRoles ?? existing.requires_roles === 1);
  }
  if (fields.weeklyAssignments !== undefined || fields.requiresRoles !== undefined || fields.weekdays !== undefined) {
    fields.weeklyAssignments = validateWeeklyAssignments(fields.weeklyAssignments ?? JSON.parse(existing.weekly_assignments_json), fields.requiresRoles ?? existing.requires_roles === 1, fields.weekdays ?? JSON.parse(existing.weekdays_json));
  }
  if ((fields.requiresRoles ?? existing.requires_roles) && (fields.defaultNeed ?? existing.default_need) === 1) {
    if (fields.defaultNeed === undefined) fields.defaultNeed = 2;
    else throw badRequest('主副工作默认人数必须为 0 或至少 2 人');
  }
  configRepo.updateWorkType(id, fields);
  auditRepo.log({
    action: auditRepo.ACTIONS.WORK_TYPE_UPDATE,
    entityType: 'work_type',
    entityId: id,
    actorId: ctx.user.id,
    detail: fields,
    requestId: ctx.requestId,
  });
  return configRepo.toWorkTypeDto(configRepo.findWorkType(id));
}

// ---------------------------- 班次 ----------------------------

function listShifts() {
  return configRepo.listShifts({ includeInactive: true }).map(configRepo.toShiftDto);
}

function createShift({ code, name, startTime, endTime, seq, color }, ctx) {
  if (configRepo.findShiftByCode(code)) {
    throw conflict('SHIFT_CODE_TAKEN', `班次编码 ${code} 已存在`);
  }
  const existingSeq = db.get('SELECT id FROM shifts WHERE seq = ?', seq);
  if (existingSeq) throw conflict('SHIFT_SEQ_TAKEN', `班次顺序号 ${seq} 已被占用`);

  const id = configRepo.insertShift({
    code,
    name,
    startTime,
    endTime,
    seq,
    color: color || '#7B8794',
    active: 1,
  });
  auditRepo.log({
    action: auditRepo.ACTIONS.SHIFT_CREATE,
    entityType: 'shift',
    entityId: id,
    actorId: ctx.user.id,
    detail: { code, name, startTime, endTime, seq },
    requestId: ctx.requestId,
  });
  return configRepo.toShiftDto(configRepo.findShift(id));
}

function updateShift(id, fields, ctx) {
  const existing = configRepo.findShift(id);
  if (!existing) throw badRequest('班次不存在');
  if (fields.seq !== undefined && fields.seq !== existing.seq) {
    const dup = db.get('SELECT id FROM shifts WHERE seq = ? AND id <> ?', fields.seq, id);
    if (dup) throw conflict('SHIFT_SEQ_TAKEN', `班次顺序号 ${fields.seq} 已被占用`);
  }
  configRepo.updateShift(id, fields);
  auditRepo.log({
    action: auditRepo.ACTIONS.SHIFT_UPDATE,
    entityType: 'shift',
    entityId: id,
    actorId: ctx.user.id,
    detail: fields,
    requestId: ctx.requestId,
  });
  return configRepo.toShiftDto(configRepo.findShift(id));
}

module.exports = { listWorkTypes, createWorkType, updateWorkType, listShifts, createShift, updateShift };
