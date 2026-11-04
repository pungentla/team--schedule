'use strict';

/** 排班路由 */

const express = require('express');
const scheduleService = require('../services/scheduleService');
const periodRepo = require('../repositories/periodRepo');
const db = require('../db/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireInt, optionalInt, intParam } = require('../utils/validate');
const { notFound } = require('../utils/errors');

const router = express.Router();
const ctx = (req) => ({ user: req.user, requestId: req.requestId });

/** 生成排班（draft） */
router.post('/periods/:periodId/generate', requireAuth, requireAdmin, (req, res) => {
  const periodId = intParam(req.params.periodId, 'periodId');
  const seed = optionalInt(req.body?.seed, 'seed', { min: 0, max: 2147483647 });
  const data = scheduleService.generate(periodId, { seed: seed ?? undefined }, ctx(req));
  res.json({ data });
});

/** 发布 */
router.post('/periods/:periodId/publish', requireAuth, requireAdmin, (req, res) => {
  const periodId = intParam(req.params.periodId, 'periodId');
  const runId = optionalInt(req.body?.runId, 'runId', { min: 1 });
  res.json({ data: scheduleService.publish(periodId, runId ?? undefined, ctx(req)) });
});

/** 排班表（矩阵 + 缺口 + 指标） */
router.get('/periods/:periodId', requireAuth, (req, res) => {
  const periodId = intParam(req.params.periodId, 'periodId');
  const runId = optionalInt(req.query.runId, 'runId', { min: 1 });
  res.json({ data: scheduleService.getSchedule(periodId, req.user, { runId: runId ?? undefined }) });
});

/** 我的排班（跨周期） */
router.get('/mine', requireAuth, (req, res) => {
  const upcomingOnly = req.query.upcoming === '1' || req.query.upcoming === 'true';
  res.json({ data: scheduleService.getMyAssignments(req.user.id, { upcomingOnly }) });
});

/** 管理员总览 */
router.get('/dashboard', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: scheduleService.getDashboard() });
});

/** 预览算法输入（调试/解释用） */
router.get('/periods/:periodId/input-preview', requireAuth, requireAdmin, (req, res) => {
  const periodId = intParam(req.params.periodId, 'periodId');
  const input = scheduleService.buildScheduleInput(periodId, {
    seed: optionalInt(req.query.seed, 'seed', { min: 0 }) ?? undefined,
  });
  res.json({
    data: {
      period: input.period,
      slotCount: input.slots.length,
      totalNeeded: input.slots.reduce((acc, s) => acc + s.needCount, 0),
      employeeCount: input.employees.length,
      employees: input.employees.map((e) => ({
        userId: e.userId,
        name: e.name,
        employeeNo: e.employeeNo,
        maxShifts: e.maxShifts,
        workTypes: e.workTypes,
        unavailableDates: e.unavailableDates,
        availabilityCount: e.availability.length,
        historyTotal: e.historyTotal,
      })),
      seed: input.seed,
    },
  });
});

/** 某条分配的解释（为什么排给他） */
router.get('/assignments/:id/explain', requireAuth, requireAdmin, (req, res) => {
  const id = intParam(req.params.id, 'id');
  const row = db.get(
    `SELECT a.*, s.seq, u.name, u.employee_no FROM assignments a
       JOIN shifts s ON s.id = a.shift_id
       JOIN users u ON u.id = a.user_id
      WHERE a.id = ?`,
    id
  );
  if (!row) throw notFound('排班记录不存在');

  const { buildEmployeeState } = require('../services/swapService');
  const period = periodRepo.findPeriod(row.period_id);
  const { emp } = buildEmployeeState(period, row.user_id);
  const { explainScore } = require('../scheduler/scoring');

  res.json({
    data: {
      assignmentId: id,
      employee: { userId: row.user_id, name: row.name, employeeNo: row.employee_no },
      slot: {
        workDate: row.work_date,
        shiftId: row.shift_id,
        shiftSeq: row.seq,
        workTypeId: row.work_type_id,
      },
      explanation: explainScore(
        emp,
        { workDate: row.work_date, shiftId: row.shift_id, shiftSeq: row.seq, workTypeId: row.work_type_id },
        { seed: 42, refDate: period.start_date, workTypeRarity: null }
      ),
      note: '评分为「当前状态下」的重新计算值，与排班当时的中间状态可能不同，仅供理解算法逻辑',
    },
  });
});

module.exports = router;
