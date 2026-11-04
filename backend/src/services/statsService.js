'use strict';

/** 统计服务：轮转公平度、工作量、个人历史 */

const db = require('../db/db');
const periodRepo = require('../repositories/periodRepo');
const scheduleRepo = require('../repositories/scheduleRepo');
const configRepo = require('../repositories/configRepo');
const { computeMetrics } = require('../scheduler/metrics');
const { notFound } = require('../utils/errors');

/** 某周期已发布排班的公平度统计 */
function getPeriodStats(periodId) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');

  const run = scheduleRepo.findPublishedRun(periodId);
  if (!run) {
    return { period: periodRepo.toPeriodDto(period), run: null, metrics: null, message: '该周期还没有已发布的排班' };
  }

  // 从 assignments 现算（保证换班后的数据是真实的，而不是生成时的快照）
  const rows = db.all(
    `SELECT a.user_id, a.work_type_id, u.name, u.employee_no
       FROM assignments a
       JOIN users u ON u.id = a.user_id
      WHERE a.run_id = ? AND a.status = 'active'`,
    run.id
  );
  const workTypes = configRepo.listWorkTypes().map((w) => ({ id: w.id, name: w.name, color: w.color }));

  const countByUser = new Map();
  const countByUserWt = new Map();
  const userInfo = new Map();
  for (const r of rows) {
    countByUser.set(r.user_id, (countByUser.get(r.user_id) || 0) + 1);
    const k = `${r.user_id}|${r.work_type_id}`;
    countByUserWt.set(k, (countByUserWt.get(k) || 0) + 1);
    userInfo.set(r.user_id, r);
  }

  // 历史累计（本周期之前，仅已发布）
  const historyRows = db.all(
    `SELECT a.user_id, a.work_type_id, COUNT(*) AS cnt
       FROM assignments a
       JOIN periods p ON p.id = a.period_id
       JOIN schedule_runs r ON r.id = a.run_id AND r.status = 'published'
      WHERE a.status = 'active' AND p.start_date < ?
      GROUP BY a.user_id, a.work_type_id`,
    period.start_date
  );
  const histByUserWt = new Map();
  for (const r of historyRows) histByUserWt.set(`${r.user_id}|${r.work_type_id}`, r.cnt);

  // 用轻量的 employee 形状喂给 computeMetrics
  const enrolled = db.all(
    `SELECT e.user_id, u.name, u.employee_no,
            (SELECT COUNT(*) FROM enrollment_work_types ewt WHERE ewt.enrollment_id = e.id) AS wt_count
       FROM enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.period_id = ? AND e.status = 'submitted'`,
    periodId
  );
  const enrolledWt = db.all(
    `SELECT e.user_id, ewt.work_type_id
       FROM enrollments e
       JOIN enrollment_work_types ewt ON ewt.enrollment_id = e.id
      WHERE e.period_id = ? AND e.status = 'submitted'`,
    periodId
  );
  const wtSetByUser = new Map();
  for (const r of enrolledWt) {
    if (!wtSetByUser.has(r.user_id)) wtSetByUser.set(r.user_id, new Set());
    wtSetByUser.get(r.user_id).add(r.work_type_id);
  }

  const fakeEmployees = enrolled.map((e) => {
    const wtSet = wtSetByUser.get(e.user_id) || new Set();
    return {
      id: e.user_id,
      name: e.name,
      employeeNo: e.employee_no,
      workTypes: new Map([...wtSet].map((w) => [w, 1])),
      historyCount: (wtId) => histByUserWt.get(`${e.user_id}|${wtId}`) || 0,
      historyTotal: [...wtSet].reduce((acc, w) => acc + (histByUserWt.get(`${e.user_id}|${w}`) || 0), 0),
    };
  });

  const assignments = rows.map((r) => ({ userId: r.user_id, workTypeId: r.work_type_id }));
  const metrics = computeMetrics({
    employees: fakeEmployees,
    workTypes,
    assignments,
  });

  // 附上历史次数，便于前端展示"历史 vs 本期"
  for (const wt of metrics.perWorkType) {
    for (const d of wt.distribution) {
      d.historyCount = histByUserWt.get(`${d.userId}|${wt.workTypeId}`) || 0;
    }
  }

  return {
    period: periodRepo.toPeriodDto(period),
    run: {
      id: run.id,
      seed: run.seed,
      algoVersion: run.algo_version,
      totalNeeded: run.total_needed,
      totalFilled: run.total_filled,
      fillRate: run.fill_rate,
      createdAt: run.created_at,
    },
    metrics,
  };
}

/** 某员工的跨周期工作类型分布（看轮转历史） */
function getEmployeeHistory(userId) {
  const rows = db.all(
    `SELECT wt.id AS work_type_id, wt.name, wt.color, COUNT(*) AS cnt,
            MIN(a.work_date) AS first_date, MAX(a.work_date) AS last_date
       FROM assignments a
       JOIN work_types wt ON wt.id = a.work_type_id
       JOIN schedule_runs r ON r.id = a.run_id AND r.status = 'published'
      WHERE a.user_id = ? AND a.status = 'active'
      GROUP BY wt.id
      ORDER BY cnt DESC`,
    userId
  );
  const total = rows.reduce((acc, r) => acc + r.cnt, 0);
  return {
    userId,
    total,
    byWorkType: rows.map((r) => ({
      workTypeId: r.work_type_id,
      name: r.name,
      color: r.color,
      count: r.cnt,
      ratio: total ? Number((r.cnt / total).toFixed(3)) : 0,
      firstDate: r.first_date,
      lastDate: r.last_date,
    })),
  };
}

module.exports = { getPeriodStats, getEmployeeHistory };
