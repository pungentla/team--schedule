'use strict';

/** 报名路由 */

const express = require('express');
const enrollmentService = require('../services/enrollmentService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireArray, intParam } = require('../utils/validate');

const router = express.Router();
const ctx = (req) => ({ user: req.user, requestId: req.requestId });

/** 报名页上下文：可选工作类型 / 班次 / 日期 */
router.get('/context/:periodId', requireAuth, (req, res) => {
  res.json({ data: enrollmentService.getEnrollContext(intParam(req.params.periodId, 'periodId'), req.user.id) });
});

/** 我的报名 */
router.get('/mine/:periodId', requireAuth, (req, res) => {
  res.json({ data: enrollmentService.getMyEnrollment(intParam(req.params.periodId, 'periodId'), req.user.id) });
});

/** 提交/更新报名 */
router.post('/:periodId', requireAuth, (req, res) => {
  const periodId = intParam(req.params.periodId, 'periodId');
  const b = req.body || {};
  const payload = {
    workTypes: requireArray(b.workTypes ?? [], 'workTypes', { min: 0, max: 50 }),
    maxShifts: b.maxShifts,
    availability: requireArray(b.availability ?? [], 'availability', { min: 0, max: 40000 }),
    unavailability: requireArray(b.unavailability ?? [], 'unavailability', { min: 0, max: 366 }),
    note: b.note ?? null,
    submit: b.submit !== false,
  };
  res.json({ data: enrollmentService.saveEnrollment(periodId, req.user.id, payload, ctx(req)) });
});

/** 管理员代报名：仅更新工作与岗位角色，保留个人约束。 */
router.get('/:periodId/users/:userId', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: enrollmentService.getAdminEnrollment(intParam(req.params.periodId, 'periodId'), intParam(req.params.userId, 'userId'), ctx(req)) });
});
router.post('/:periodId/users/:userId', requireAuth, requireAdmin, (req, res) => {
  const workTypes = requireArray(req.body?.workTypes, 'workTypes', { min: 1, max: 50 });
  res.json({ data: enrollmentService.saveAdminEnrollment(intParam(req.params.periodId, 'periodId'), intParam(req.params.userId, 'userId'), { workTypes }, ctx(req)) });
});

/** 管理员：报名汇总 */
router.get('/:periodId', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: enrollmentService.listEnrollments(intParam(req.params.periodId, 'periodId')) });
});

module.exports = router;
