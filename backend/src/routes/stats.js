'use strict';

/** 统计路由 */

const express = require('express');
const statsService = require('../services/statsService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { intParam } = require('../utils/validate');

const router = express.Router();

/** 某周期公平度 */
router.get('/periods/:periodId', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: statsService.getPeriodStats(intParam(req.params.periodId, 'periodId')) });
});

/** 个人跨周期工作分布（本人或管理员） */
router.get('/employees/:userId', requireAuth, (req, res) => {
  const userId = intParam(req.params.userId, 'userId');
  if (!['admin', 'super_admin'].includes(req.user.role) && req.user.id !== userId) {
    const { forbidden } = require('../utils/errors');
    throw forbidden('只能查看自己的工作分布');
  }
  res.json({ data: statsService.getEmployeeHistory(userId) });
});

/** 我自己 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ data: statsService.getEmployeeHistory(req.user.id) });
});

module.exports = router;
