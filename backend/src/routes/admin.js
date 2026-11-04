'use strict';

/** 管理后台路由：员工 / 邀请码 / 审计日志 */

const express = require('express');
const userRepo = require('../repositories/userRepo');
const auditRepo = require('../repositories/auditRepo');
const swapRepo = require('../repositories/swapRepo');
const authService = require('../services/authService');
const db = require('../db/db');
const { requireInt, optionalInt, requireString, optionalString, requireEnum, intParam } = require('../utils/validate');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { ROLES } = require('../config');

const router = express.Router();

// ---------------------------- 员工 ----------------------------

router.get('/users', (req, res) => {
  const includeDisabled = req.query.includeDisabled !== '0';
  const keyword = req.query.keyword || null;
  const rows = userRepo.listUsers({ keyword, includeDisabled });
  res.json({
    data: rows.map((u) => ({
      id: u.id,
      employeeNo: u.employee_no,
      name: u.name,
      role: u.role,
      phone: u.phone,
      status: u.status,
      createdAt: u.created_at,
    })),
  });
});

router.patch('/users/:id', (req, res) => {
  const id = intParam(req.params.id, 'id');
  const user = userRepo.findById(id);
  if (!user) throw notFound('员工不存在');
  const b = req.body || {};

  const fields = {};
  if (b.name !== undefined) fields.name = requireString(b.name, '姓名', { max: 32 });
  if (b.role !== undefined) fields.role = requireEnum(b.role, '角色', [ROLES.ADMIN, ROLES.EMPLOYEE]);
  if (b.status !== undefined) fields.status = requireEnum(b.status, '状态', ['active', 'disabled']);
  if (b.phone !== undefined) fields.phone = optionalString(b.phone, '手机号', { max: 32 });

  // 不允许把最后一个管理员降级/停用
  if (user.role === ROLES.ADMIN && (fields.role === ROLES.EMPLOYEE || fields.status === 'disabled')) {
    const adminCount = db.pluck(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active'`);
    if (adminCount <= 1) throw conflict('LAST_ADMIN', '至少需要保留一个启用状态的管理员');
  }

  userRepo.updateUser(id, fields);
  if (fields.status === 'disabled') userRepo.deleteUserSessions(id);

  auditRepo.log({
    action: auditRepo.ACTIONS.USER_UPDATE,
    entityType: 'user',
    entityId: id,
    actorId: req.user.id,
    detail: fields,
    requestId: req.requestId,
  });

  res.json({ data: userRepo.publicUser(userRepo.findById(id)) });
});

/** 重置密码（管理员） */
router.post('/users/:id/password', (req, res) => {
  const id = intParam(req.params.id, 'id');
  const user = userRepo.findById(id);
  if (!user) throw notFound('员工不存在');
  const newPassword = requireString(req.body?.newPassword, '新密码', { min: 6, max: 128 });
  const { hashPasswordSync } = require('../utils/security');
  userRepo.updateUser(id, { passwordHash: hashPasswordSync(newPassword) });
  userRepo.deleteUserSessions(id);
  auditRepo.log({
    action: auditRepo.ACTIONS.USER_UPDATE,
    entityType: 'user',
    entityId: id,
    actorId: req.user.id,
    detail: { action: 'reset_password' },
    requestId: req.requestId,
  });
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
