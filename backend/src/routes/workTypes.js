'use strict';

/** 工作类型路由 */

const express = require('express');
const configService = require('../services/configService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireString, optionalString, optionalInt, intParam, requireBoolean, requireArray, requireInt } = require('../utils/validate');

const router = express.Router();
const parseWeekdays = (value) => [...new Set(requireArray(value, '工作日', { max: 7 }).map((d) => requireInt(d, '星期', { min: 0, max: 6 })))].sort();

router.get('/', requireAuth, (req, res) => {
  res.json({ data: configService.listWorkTypes({ user: req.user, requestId: req.requestId }) });
});

router.post('/', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const data = configService.createWorkType(
    {
      code: requireString(b.code, '编码', { max: 32 }),
      name: requireString(b.name, '名称', { max: 32 }),
      description: optionalString(b.description, '描述', { max: 200 }),
      color: optionalString(b.color, '颜色', { max: 16 }),
      sortOrder: optionalInt(b.sortOrder, '排序', { min: 0, max: 999 }) ?? 0,
      requiresRoles: b.requiresRoles === undefined ? false : requireBoolean(b.requiresRoles, '区分主副负责人'),
      weekdays: b.weekdays === undefined ? undefined : parseWeekdays(b.weekdays),
      defaultNeed: optionalInt(b.defaultNeed, '默认人数', { min: 0, max: 99 }) ?? undefined,
      weeklyAssignments: b.weeklyAssignments,
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
  if (b.description !== undefined) fields.description = optionalString(b.description, '描述', { max: 200 });
  if (b.color !== undefined) fields.color = requireString(b.color, '颜色', { max: 16 });
  if (b.sortOrder !== undefined) fields.sortOrder = optionalInt(b.sortOrder, '排序', { min: 0, max: 999 });
  if (b.active !== undefined) fields.active = b.active ? 1 : 0;
  if (b.requiresRoles !== undefined) fields.requiresRoles = requireBoolean(b.requiresRoles, '区分主副负责人');
  if (b.weekdays !== undefined) fields.weekdays = parseWeekdays(b.weekdays);
  if (b.defaultNeed !== undefined) fields.defaultNeed = requireInt(b.defaultNeed, '默认人数', { min: 0, max: 99 });
  if (b.weeklyAssignments !== undefined) fields.weeklyAssignments = b.weeklyAssignments;

  const data = configService.updateWorkType(id, fields, { user: req.user, requestId: req.requestId });
  res.json({ data });
});

module.exports = router;
