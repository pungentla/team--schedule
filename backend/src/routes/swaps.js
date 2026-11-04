'use strict';

/** 换班路由 */

const express = require('express');
const swapService = require('../services/swapService');
const swapRepo = require('../repositories/swapRepo');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireInt, intParam, requireEnum } = require('../utils/validate');
const { SWAP_TYPE } = require('../config');

const router = express.Router();
const ctx = (req) => ({ user: req.user, requestId: req.requestId });

/** 发起换班 */
router.post('/', requireAuth, (req, res) => {
  const b = req.body || {};
  const type = requireEnum(b.type, 'type', [SWAP_TYPE.TRANSFER, SWAP_TYPE.EXCHANGE]);
  const data = swapService.createSwap(
    {
      type,
      fromAssignmentId: requireInt(b.fromAssignmentId, '原排班', { min: 1 }),
      toUserId: requireInt(b.toUserId, '接收人', { min: 1 }),
      toAssignmentId: type === SWAP_TYPE.EXCHANGE ? requireInt(b.toAssignmentId, '交换的班次', { min: 1 }) : null,
      message: b.message || null,
    },
    ctx(req)
  );
  res.status(201).json({ data });
});

/** 我发起 / 待我确认 */
router.get('/', requireAuth, (req, res) => {
  const scope = req.query.scope === 'inbox' ? 'inbox' : 'mine';
  const status = req.query.status || null;
  res.json({ data: swapService.listSwaps(req.user.id, { scope, status }) });
});

/** 待我确认数量 */
router.get('/pending-count', requireAuth, (req, res) => {
  res.json({ data: { count: swapService.getPendingCount(req.user.id) } });
});

/** 某条排班的可换班候选人（含 exchange 可选班次） */
router.get('/candidates/:assignmentId', requireAuth, (req, res) => {
  res.json({ data: swapService.listCandidates(intParam(req.params.assignmentId, 'assignmentId'), req.user) });
});

/** 详情 */
router.get('/:id', requireAuth, (req, res) => {
  res.json({ data: swapService.getSwapDetail(intParam(req.params.id, 'id'), req.user) });
});

/** 同意 */
router.post('/:id/confirm', requireAuth, (req, res) => {
  res.json({ data: swapService.confirm(intParam(req.params.id, 'id'), ctx(req)) });
});

/** 拒绝 */
router.post('/:id/reject', requireAuth, (req, res) => {
  res.json({ data: swapService.reject(intParam(req.params.id, 'id'), req.body?.reason || null, ctx(req)) });
});

/** 撤回 */
router.post('/:id/cancel', requireAuth, (req, res) => {
  res.json({ data: swapService.cancel(intParam(req.params.id, 'id'), ctx(req)) });
});

module.exports = router;
