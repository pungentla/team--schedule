'use strict';

/** 周期路由 */

const express = require('express');
const periodService = require('../services/periodService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  requireString,
  requireInt,
  optionalInt,
  requireArray,
  intParam,
  requireBoolean,
} = require('../utils/validate');
const { isDateString, today } = require('../utils/date');
const { badRequest } = require('../utils/errors');

const router = express.Router();
const ctx = (req) => ({ user: req.user, requestId: req.requestId });

function parseDate(v, field) {
  if (!isDateString(v)) throw badRequest(`${field} 格式必须是 YYYY-MM-DD`);
  return v;
}

router.get('/', requireAuth, (req, res) => {
  res.json({ data: periodService.listPeriods() });
});

router.get('/current', requireAuth, (req, res) => {
  const list = periodService.listPeriods();
  res.json({ data: periodService.findCurrentPeriod(list, today()) });
});

router.get('/:id', requireAuth, (req, res) => {
  res.json({ data: periodService.getPeriod(intParam(req.params.id, 'id')) });
});

router.post('/', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const data = periodService.createPeriod(
    {
      name: requireString(b.name, '周期名称', { max: 64 }),
      startDate: parseDate(b.startDate, '开始日期'),
      endDate: parseDate(b.endDate, '结束日期'),
      maxShiftsPerDay: optionalInt(b.maxShiftsPerDay, '每日最多班次', { min: 1, max: 5 }),
      maxShiftsPerWeek: optionalInt(b.maxShiftsPerWeek, '每周最多班次', { min: 1, max: 21 }),
      forbidConsecutive: b.forbidConsecutive === undefined ? undefined : requireBoolean(b.forbidConsecutive, '禁止连续班次'),
      enrollmentDeadline: b.enrollmentDeadline || null,
    },
    ctx(req)
  );
  res.status(201).json({ data });
});

router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = requireString(b.name, '周期名称', { max: 64 });
  if (b.startDate !== undefined) fields.startDate = parseDate(b.startDate, '开始日期');
  if (b.endDate !== undefined) fields.endDate = parseDate(b.endDate, '结束日期');
  if (b.maxShiftsPerDay !== undefined) fields.maxShiftsPerDay = requireInt(b.maxShiftsPerDay, '每日最多班次', { min: 1, max: 5 });
  if (b.maxShiftsPerWeek !== undefined) fields.maxShiftsPerWeek = requireInt(b.maxShiftsPerWeek, '每周最多班次', { min: 1, max: 21 });
  if (b.forbidConsecutive !== undefined) fields.forbidConsecutive = requireBoolean(b.forbidConsecutive, '禁止连续班次');
  if (b.enrollmentDeadline !== undefined) fields.enrollmentDeadline = b.enrollmentDeadline || null;
  if (b.status !== undefined) {
    res.json({ data: periodService.changeStatus(id, b.status, ctx(req)) });
    return;
  }
  res.json({ data: periodService.updatePeriod(id, fields, ctx(req)) });
});

router.post('/:id/status', requireAuth, requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const status = requireString(req.body?.status, '状态', { max: 16 });
  res.json({ data: periodService.changeStatus(id, status, ctx(req)) });
});

/** 生成需求格子 */
router.post('/:id/slots/generate', requireAuth, requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const b = req.body || {};
  const data = periodService.generateSlots(
    id,
    {
      dates: Array.isArray(b.dates) ? b.dates : null,
      shiftIds: Array.isArray(b.shiftIds) ? b.shiftIds.map(Number) : null,
      defaultNeed: b.defaultNeed === undefined ? 0 : requireInt(b.defaultNeed, '默认需求人数', { min: 0, max: 99 }),
    },
    ctx(req)
  );
  res.json({ data });
});

/** 需求矩阵（日期 × 班次 × 工作） */
router.get('/:id/requirements', requireAuth, (req, res) => {
  res.json({ data: periodService.getRequirementMatrix(intParam(req.params.id, 'id')) });
});

/** 批量设置需求人数 */
router.put('/:id/requirements', requireAuth, requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const items = requireArray(req.body?.items, 'items', { min: 1, max: 2000 });
  const normalized = items.map((it) => ({
    workDate: parseDate(it.workDate, '日期'),
    shiftId: requireInt(it.shiftId, '班次', { min: 1 }),
    workTypeId: requireInt(it.workTypeId, '工作类型', { min: 1 }),
    needCount: requireInt(it.needCount, '需求人数', { min: 0, max: 99 }),
  }));
  res.json({ data: periodService.setRequirements(id, normalized, ctx(req)) });
});

module.exports = router;
