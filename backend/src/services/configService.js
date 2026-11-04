'use strict';

/** 基础数据服务：工作类型 / 班次 */

const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { badRequest, conflict } = require('../utils/errors');

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

function createWorkType({ code, name, description, color, sortOrder }, ctx) {
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
