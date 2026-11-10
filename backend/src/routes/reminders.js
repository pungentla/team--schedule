'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { AppError, notFound } = require('../utils/errors');
const reminders = require('../services/reminderService');

const router = express.Router();
router.use(requireAuth);

router.post('/status', (req, res) => {
  const endpoint = req.body?.endpoint == null ? null : reminders.validateEndpoint(req.body.endpoint);
  res.json({ data: { publicKey: reminders.publicKey, enabled: !!endpoint && !!reminders.findSubscription(req.user.id, endpoint) } });
});

router.put('/subscription', (req, res) => {
  if (!reminders.publicKey) throw new AppError(503, 'PUSH_UNAVAILABLE', '服务器尚未开启推送');
  reminders.saveSubscription(req.user.id, req.body || {});
  res.json({ data: { enabled: true } });
});

router.delete('/subscription', (req, res) => {
  reminders.removeSubscription(req.user.id, reminders.validateEndpoint(req.body?.endpoint));
  res.json({ data: { enabled: false } });
});

const limitTest = createRateLimiter({ windowMs: 30_000, max: 1, keyGenerator: req => req.user.id, message: '请稍后再发送测试通知' });
router.post('/test', limitTest, async (req, res, next) => {
  try {
    if (!reminders.publicKey) throw new AppError(503, 'PUSH_UNAVAILABLE', '服务器尚未开启推送');
    const device = reminders.findSubscription(req.user.id, reminders.validateEndpoint(req.body?.endpoint));
    if (!device) throw notFound('请先开启本机提醒');
    let accepted;
    try { accepted = await reminders.sendTest(device); }
    catch { throw new AppError(502, 'PUSH_FAILED', '测试通知发送失败，请稍后重试'); }
    if (!accepted) throw notFound('通知订阅已失效，请重新开启');
    res.json({ data: { accepted } });
  } catch (error) { next(error); }
});

module.exports = router;
