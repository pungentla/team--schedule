'use strict';

/** 鉴权路由 */

const express = require('express');
const authService = require('../services/authService');
const userRepo = require('../repositories/userRepo');
const { requireAuth } = require('../middleware/auth');
const { optionalString, requireBoolean, requireString } = require('../utils/validate');
const { badRequest } = require('../utils/errors');

const router = express.Router();

router.post('/register', (req, res) => {
  const body = req.body || {};
  const result = authService.register(
    {
      employeeNo: requireString(body.employeeNo, '工号', { max: 32 }),
      name: requireString(body.name, '姓名', { max: 32 }),
      password: requireString(body.password, '密码', { min: 6, max: 128 }),
      inviteCode: requireString(body.inviteCode, '邀请码', { max: 32 }),
      phone: body.phone || null,
    },
    { requestId: req.requestId }
  );
  res.status(201).json({ data: result });
});

router.post('/login', (req, res) => {
  const body = req.body || {};
  const result = authService.login(
    {
      employeeNo: requireString(body.employeeNo, '工号', { max: 32 }),
      password: requireString(body.password, '密码', { max: 128 }),
    },
    { requestId: req.requestId }
  );
  res.json({ data: result });
});

router.post('/logout', requireAuth, (req, res) => {
  const pushEndpoint = optionalString(req.body?.pushEndpoint, '设备订阅地址', { max: 4096 });
  const deviceReminderWasEnabled = authService.logout(req.tokenHash, req.user.id, { requestId: req.requestId, pushEndpoint });
  res.json({ data: { ok: true, deviceReminderWasEnabled } });
});

router.get('/me', requireAuth, (req, res) => {
  const user = userRepo.findById(req.user.id);
  res.json({ data: userRepo.publicUser(user) });
});

router.put('/me/nickname', requireAuth, (req, res) => {
  const nickname = requireString(req.body?.nickname, '花名', { max: 32 }).normalize('NFC');
  if (/[\p{Cc}\u2028-\u202e\u2066-\u2069]/u.test(nickname)) throw badRequest('请输入单行花名');
  const enabled = req.body.enabled === undefined ? undefined : requireBoolean(req.body.enabled, '花名启用状态');
  res.set('Cache-Control', 'no-store').json({ data: userRepo.updateNickname(req.user.id, nickname, enabled) });
});

router.put('/me/nickname/status', requireAuth, (req, res) => {
  const enabled = requireBoolean(req.body?.enabled, '花名启用状态');
  res.set('Cache-Control', 'no-store').json({ data: userRepo.setNicknameEnabled(req.user.id, enabled) });
});

router.post('/password', requireAuth, (req, res) => {
  const body = req.body || {};
  authService.changePassword(req.user.id, {
    oldPassword: body.oldPassword,
    newPassword: body.newPassword,
  }, { requestId: req.requestId });
  res.json({ data: { ok: true } });
});

module.exports = router;
