'use strict';

/** 排班路由 */

const express = require('express');
const scheduleService = require('../services/scheduleService');
const swapService = require('../services/swapService');
const periodRepo = require('../repositories/periodRepo');
const db = require('../db/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireInt, optionalInt, intParam, requireEnum } = require('../utils/validate');
const { notFound } = require('../utils/errors');
const { isDateString } = require('../utils/date');
const { badRequest } = require('../utils/errors');

const router = express.Router();
const ctx = (req) => ({ user: req.user, requestId: req.requestId });

router.post('/reassign', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const type = requireEnum(b.type, '调配方式', ['transfer', 'exchange']);
  res.json({ data: swapService.reassignByAdmin({ type, fromAssignmentId: requireInt(b.fromAssignmentId, '原排班', { min: 1 }), toUserId: requireInt(b.toUserId, '接班员工', { min: 1 }), toAssignmentId: type === 'exchange' ? requireInt(b.toAssignmentId, '对方班次', { min: 1 }) : null, message: typeof b.message === 'string' ? b.message.slice(0, 1000) : null }, ctx(req)) });
});

function parseDraftTarget(b) {
  if (b.assignmentId !== undefined) return { assignmentId: requireInt(b.assignmentId, '草稿安排', { min: 1 }) };
  if (!isDateString(b.workDate)) throw badRequest('日期格式必须为 YYYY-MM-DD');
  return { workDate: b.workDate, shiftId: requireInt(b.shiftId, '班次', { min: 1 }), workTypeId: requireInt(b.workTypeId, '工作', { min: 1 }), dutyRole: requireEnum(b.dutyRole, '岗位角色', ['member', 'primary', 'deputy']) };
}

router.get('/runs/:runId/candidates', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: scheduleService.getDraftCandidates(intParam(req.params.runId, 'runId'), parseDraftTarget(req.query)) });
});

router.post('/runs/:runId/adjust', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const action = requireEnum(b.action, '调配方式', ['add', 'replace', 'remove']);
  const target = parseDraftTarget(b);
  if (action !== 'add' && !target.assignmentId) throw badRequest('替换或移除必须指定草稿安排');
  if (action === 'add' && target.assignmentId) throw badRequest('补人请指定日期、班次和工作');
  const change = { ...target, action, userId: action === 'remove' ? null : requireInt(b.userId, '员工', { min: 1 }), revision: optionalInt(b.revision, '草稿调配版本', { min: 0 }) ?? undefined };
  res.json({ data: scheduleService.adjustDraft(intParam(req.params.runId, 'runId'), change, ctx(req)) });
});

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
  const expectedRevision = optionalInt(req.body?.revision, '草稿调配版本', { min: 0 });
  res.json({ data: scheduleService.publish(periodId, runId ?? undefined, ctx(req), { expectedRevision: expectedRevision ?? undefined, publishedRunId: optionalInt(req.body?.publishedRunId, '生效版本', { min: 0 }) ?? undefined, publishedRevision: optionalInt(req.body?.publishedRevision, '生效版本修订', { min: 0 }) ?? 0 }) });
});

/** 排班表（矩阵 + 缺口 + 指标） */
router.get('/periods/:periodId', requireAuth, (req, res) => {
  const periodId = intParam(req.params.periodId, 'periodId');
  const runId = optionalInt(req.query.runId, 'runId', { min: 1 });
  const version = req.query.version === undefined ? undefined : requireEnum(req.query.version, '排班版本', ['draft', 'published']);
  res.json({ data: scheduleService.getSchedule(periodId, req.user, { runId: runId ?? undefined, version }) });
});

function recentRange(req) {
  return {
    startDate: req.query.startDate, endDate: req.query.endDate,
    days: optionalInt(req.query.days, '天数', { min: 1, max: 366 }) ?? 7,
  };
}

/** 本人近期安排与同班同事；忽略外部 userId，身份来自登录态。 */
router.get('/mine/recent', requireAuth, (req, res) => {
  res.json({ data: scheduleService.getRecentSchedule(req.user.id, recentRange(req)) });
});

router.get('/team/recent', requireAuth, (req, res) => {
  res.json({ data: scheduleService.getTeamSchedule(recentRange(req)) });
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
    `SELECT a.*, s.seq, u.display_name AS name, u.employee_no FROM assignments a
       JOIN shifts s ON s.id = a.shift_id
       JOIN users u ON u.id = a.user_id
      WHERE a.id = ?`,
    id
  );
  if (!row) throw notFound('排班记录不存在');

  const { buildEmployeeState } = require('../services/swapService');
  const period = periodRepo.findPeriod(row.period_id);
  if (!period) throw notFound('排班周期不存在');
  const { emp } = buildEmployeeState(period, row.user_id);
  const employees = require('../services/enrollmentService').getEffectiveEnrollments(period.id).map((e) => buildEmployeeState(period, e.userId).emp);
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
        { seed: 42, refDate: period.start_date, workTypeRarity: null, employees }
      ),
      note: '评分为「当前状态下」的重新计算值，与排班当时的中间状态可能不同，仅供理解算法逻辑',
    },
  });
});

module.exports = router;
