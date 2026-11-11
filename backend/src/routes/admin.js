'use strict';

/** 管理后台路由：员工 / 邀请码 / 审计日志 */

const express = require('express');
const userRepo = require('../repositories/userRepo');
const auditRepo = require('../repositories/auditRepo');
const swapRepo = require('../repositories/swapRepo');
const authService = require('../services/authService');
const { requireInt, optionalInt, intParam } = require('../utils/validate');

const router = express.Router();

// ---------------------------- 员工 ----------------------------

router.get('/users', (req, res) => {
  const includeDisabled = req.query.includeDisabled !== '0';
  const keyword = req.query.keyword || null;
  const rows = userRepo.listUsers({ keyword, includeDisabled });
  res.json({ data: rows.map(userRepo.accountUser) });
});

const accounts = require('../services/accountService');
router.post('/users', (req, res) => {
  res.status(201).json({ data: accounts.create(req.body || {}, { user: req.user, requestId: req.requestId }) });
});
router.patch('/users/:id', (req, res) => {
  res.json({ data: accounts.update(intParam(req.params.id, 'id'), req.body || {}, { user: req.user, requestId: req.requestId }) });
});
router.post('/users/:id/password', (req, res) => {
  accounts.resetPassword(intParam(req.params.id, 'id'), req.body?.newPassword, { user: req.user, requestId: req.requestId });
  res.json({ data: { ok: true } });
});

// ---------------------------- 邀请码 ----------------------------

router.get('/invites', (req, res) => {
  res.json({
    data: userRepo.listInvites().map((i) => ({
      id: i.id,
      code: i.code,
      maxUses: i.max_uses,
      usedCount: i.used_count,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
      createdByName: i.created_by_name,
      exhausted: i.used_count >= i.max_uses,
    })),
  });
});

router.post('/invites', (req, res) => {
  const b = req.body || {};
  const maxUses = optionalInt(b.maxUses, '可用次数', { min: 1, max: 500 }) ?? 20;
  const expiresInDays = optionalInt(b.expiresInDays, '有效天数', { min: 1, max: 365 }) ?? 30;
  const data = authService.createInvite({ maxUses, expiresInDays }, req.user.id, { requestId: req.requestId });
  res.status(201).json({ data });
});

// ---------------------------- 审计日志 ----------------------------

router.get('/audit-logs', (req, res) => {
  const page = optionalInt(req.query.page, 'page', { min: 1 }) ?? 1;
  const pageSize = Math.min(optionalInt(req.query.pageSize, 'pageSize', { min: 1 }) ?? 50, 200);
  const data = auditRepo.list({
    page,
    pageSize,
    periodId: req.query.periodId ? requireInt(req.query.periodId, 'periodId', { min: 1 }) : null,
    action: req.query.action || null,
    actorId: req.query.actorId ? requireInt(req.query.actorId, 'actorId', { min: 1 }) : null,
  });
  res.json({ data });
});

// ---------------------------- 换班总览 ----------------------------

router.get('/swaps', (req, res) => {
  const periodId = requireInt(req.query.periodId, 'periodId', { min: 1 });
  const rows = swapRepo.listSwapsByPeriod(periodId, req.query.status || null);
  res.json({
    data: rows.map((s) => ({
      id: s.id,
      type: s.type,
      status: s.status,
      requesterName: s.requester_name,
      toUserName: s.to_user_name,
      fromWorkDate: s.from_work_date,
      fromShiftName: s.from_shift_name,
      fromWorkTypeName: s.from_work_type_name,
      toWorkDate: s.to_work_date,
      toShiftName: s.to_shift_name,
      toWorkTypeName: s.to_work_type_name,
      createdAt: s.created_at,
      appliedAt: s.applied_at,
    })),
  });
});

module.exports = router;
