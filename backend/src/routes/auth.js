'use strict';

/** 鉴权路由 */

const express = require('express');
const authService = require('../services/authService');
const userRepo = require('../repositories/userRepo');
const { requireAuth } = require('../middleware/auth');
const { requireString } = require('../utils/validate');

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
  authService.logout(req.tokenHash, req.user.id, { requestId: req.requestId });
  res.json({ data: { ok: true } });
});

router.get('/me', requireAuth, (req, res) => {
  const user = userRepo.findById(req.user.id);
  res.json({ data: userRepo.publicUser(user) });
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
