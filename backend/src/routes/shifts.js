'use strict';

/** 班次路由 */

const express = require('express');
const configService = require('../services/configService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireString, optionalString, requireInt, optionalInt, requireTime, intParam } = require('../utils/validate');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json({ data: configService.listShifts() });
});

router.post('/', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const data = configService.createShift(
    {
      code: requireString(b.code, '编码', { max: 32 }),
      name: requireString(b.name, '名称', { max: 32 }),
      startTime: requireTime(b.startTime, '开始时间'),
      endTime: requireTime(b.endTime, '结束时间'),
      seq: requireInt(b.seq, '顺序号', { min: 1, max: 99 }),
      color: optionalString(b.color, '颜色', { max: 16 }),
    },
    { user: req.user, requestId: req.requestId }
  );
  res.status(201).json({ data });
});

router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) fields.name = requireString(b.name, '名称', { max: 32 });
  if (b.startTime !== undefined) fields.startTime = requireTime(b.startTime, '开始时间');
  if (b.endTime !== undefined) fields.endTime = requireTime(b.endTime, '结束时间');
  if (b.seq !== undefined) fields.seq = optionalInt(b.seq, '顺序号', { min: 1, max: 99 });
  if (b.color !== undefined) fields.color = requireString(b.color, '颜色', { max: 16 });
  if (b.active !== undefined) fields.active = b.active ? 1 : 0;

  const data = configService.updateShift(id, fields, { user: req.user, requestId: req.requestId });
  res.json({ data });
});

module.exports = router;
