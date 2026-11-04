'use strict';

/**
 * 排班服务 —— 把数据库数据组装成算法输入，跑算法，再落库。
 *
 * 历史统计口径（关键）：
 *   只统计 status='active' 且 周期 start_date < 本周期 start_date 的记录。
 *   被换走的 released 记录不计入，否则换班会污染轮转公平。
 */

const scheduleRepo = require('../repositories/scheduleRepo');
const periodRepo = require('../repositories/periodRepo');
const enrollmentRepo = require('../repositories/enrollmentRepo');
const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { generateSchedule } = require('../scheduler');
const { config, PERIOD_STATUS, RUN_STATUS, ASSIGNMENT_SOURCE } = require('../config');
const { badRequest, notFound, conflict } = require('../utils/errors');

/**
 * 汇总历史：某员工在某工作类型上被排过多少次、上次是什么时候
 * @returns {Map<userId, {byWorkType: Map, total, lastDateByWorkType: Map}>}
 */
function loadHistory(periodStartDate, historyPeriods = config.historyPeriods) {
  const rows = db.all(
    `SELECT a.user_id, a.work_type_id, a.work_date
       FROM assignments a
       JOIN periods p ON p.id = a.period_id
       JOIN schedule_runs r ON r.id = a.run_id AND r.status = 'published'
      WHERE a.status = 'active'
        AND p.start_date < ?
      ORDER BY a.work_date ASC`,
    periodStartDate
  );

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) {
      map.set(r.user_id, { byWorkType: new Map(), total: 0, lastDateByWorkType: new Map() });
    }
    const h = map.get(r.user_id);
    h.byWorkType.set(r.work_type_id, (h.byWorkType.get(r.work_type_id) || 0) + 1);
    h.total += 1;
    h.lastDateByWorkType.set(r.work_type_id, r.work_date);
  }
  return map;
}

/**
 * 组装算法输入。
 * 这一步把"数据库视角"翻译成"算法视角"，是排班正确性的关键环节。
 */
function buildScheduleInput(periodId, { seed } = {}) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');

  const requirements = periodRepo.listRequirements(periodId);
  if (!requirements.length) {
    throw badRequest('该周期还没有配置需求人数，请先在「需求配置」里填写');
  }

  const shiftMap = new Map(configRepo.listShifts().map((s) => [s.id, s]));
  const slots = requirements.map((r) => {
    const shift = shiftMap.get(r.shift_id);
    return {
      workDate: r.work_date,
      shiftId: r.shift_id,
      shiftSeq: shift ? shift.seq : 999,
      workTypeId: r.work_type_id,
      needCount: r.need_count,
      workTypeName: r.work_type_name,
      workTypeColor: r.work_type_color,
      shiftName: r.shift_name,
    };
  });

  const enrollments = enrollmentRepo.loadSubmittedEnrollments(periodId);
  if (!enrollments.length) {
    throw badRequest('还没有员工提交报名，无法排班');
  }

  const availabilityMap = enrollmentRepo.loadAvailabilityMap(periodId);
  const unavailabilityMap = enrollmentRepo.loadUnavailabilityMap(periodId);
  const historyMap = loadHistory(period.start_date);

  const employees = enrollments.map((e) => {
    const hist = historyMap.get(e.userId) || { byWorkType: new Map(), total: 0, lastDateByWorkType: new Map() };
    const avail = availabilityMap.get(e.userId);
    return {
      userId: e.userId,
      name: e.name,
      employeeNo: e.employeeNo,
      maxShifts: e.maxShifts,
      workTypes: e.workTypes,
      availability: avail ? [...avail] : [],
      unavailableDates: [...(unavailabilityMap.get(e.userId) || [])],
      historyByWorkType: hist.byWorkType,
      historyTotal: hist.total,
      lastDateByWorkType: hist.lastDateByWorkType,
    };
  });

  return {
    period: {
      id: period.id,
      name: period.name,
      startDate: period.start_date,
      endDate: period.end_date,
      maxShiftsPerDay: period.max_shifts_per_day,
      maxShiftsPerWeek: period.max_shifts_per_week,
      forbidConsecutive: period.forbid_consecutive === 1,
    },
    employees,
    slots,
    seed: seed ?? config.defaultSeed,
  };
}

/**
 * 生成排班（写入 draft run，不自动发布）
 */
function generate(periodId, { seed, saveDraft = true } = {}, ctx) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  if (period.status === PERIOD_STATUS.ARCHIVED) {
    throw conflict('PERIOD_ARCHIVED', '已归档的周期不能排班');
  }

  const input = buildScheduleInput(periodId, { seed });
  const result = generateSchedule(input, {
    maxRounds: config.maxOptimizeRounds,
    minImprovement: config.minImprovement,
  });

  if (!saveDraft) return { ...result, runId: null, periodId };

  // 丢弃本周期之前的 draft run（只保留最新一次草稿）
  db.tx(() => {
    db.run(
      `UPDATE schedule_runs SET status = 'discarded' WHERE period_id = ? AND status = 'draft'`,
      periodId
    );

    const runId = scheduleRepo.insertRun({
      periodId,
      algoVersion: result.algoVersion,
      seed: result.seed,
      inputHash: result.inputHash,
      status: RUN_STATUS.DRAFT,
      totalNeeded: result.gaps.totalNeeded,
      totalFilled: result.gaps.totalFilled,
      fillRate: result.gaps.fillRate,
      metricsJson: JSON.stringify(result.metrics),
      gapsJson: JSON.stringify(result.gaps),
      rounds: result.stats.rounds,
      durationMs: result.stats.durationMs,
      createdBy: ctx.user.id,
    });

    scheduleRepo.bulkInsertAssignments(
      runId,
      periodId,
      result.assignments.map((a) => ({
        workDate: a.workDate,
        shiftId: a.shiftId,
        workTypeId: a.workTypeId,
        userId: a.userId,
        source: ASSIGNMENT_SOURCE.ALGO,
      }))
    );

    result.runId = runId;
  });

  // 自动把周期推进到 scheduling（如果还在 enrolling）
  if (period.status === PERIOD_STATUS.ENROLLING || period.status === PERIOD_STATUS.DRAFT) {
    periodRepo.updatePeriod(periodId, { status: PERIOD_STATUS.SCHEDULING });
  }

  auditRepo.log({
    action: auditRepo.ACTIONS.SCHEDULE_GENERATE,
    entityType: 'schedule_run',
    entityId: result.runId,
    periodId,
    actorId: ctx.user.id,
    detail: {
      seed: result.seed,
      filled: result.gaps.totalFilled,
      needed: result.gaps.totalNeeded,
      fillRate: result.gaps.fillRate,
      rounds: result.stats.rounds,
      durationMs: result.stats.durationMs,
    },
    requestId: ctx.requestId,
  });

  return { ...result, periodId };
}

/** 发布 draft run */
function publish(periodId, runId, ctx) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');

  const run = runId
    ? scheduleRepo.findRun(runId)
    : scheduleRepo.findLatestDraftRun(periodId);
  if (!run) throw notFound('没有可发布的排班草稿');
  if (run.period_id !== periodId) throw badRequest('排班草稿不属于该周期');
  if (run.status === RUN_STATUS.PUBLISHED) return { runId: run.id, alreadyPublished: true };

  const filled = scheduleRepo.countAssignments(run.id);

  db.tx(() => {
    // 该周期其它 published → discarded（部分唯一索引要求最多一个）
    db.run(
      `UPDATE schedule_runs SET status = 'discarded' WHERE period_id = ? AND status = 'published'`,
      periodId
    );
    scheduleRepo.updateRunStatus(run.id, RUN_STATUS.PUBLISHED);
    periodRepo.updatePeriod(periodId, { status: PERIOD_STATUS.PUBLISHED });
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.SCHEDULE_PUBLISH,
    entityType: 'schedule_run',
    entityId: run.id,
    periodId,
    actorId: ctx.user.id,
    detail: { filled },
    requestId: ctx.requestId,
  });

  return { runId: run.id, filled, published: true };
}

/**
 * 读取排班表（矩阵视图 + 缺口 + 指标）
 * @param {object} viewer { id, role }
 */
function getSchedule(periodId, viewer, { runId } = {}) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');

  // run 选择策略（关键）：
  //   指定 runId → 用它（管理员预览草稿）
  //   管理员 → 优先最新草稿（刚生成的结果要能立刻看到），无草稿则看已发布
  //   员工 → 只看已发布（草稿未生效，不能展示给员工）
  let run;
  if (runId) {
    run = scheduleRepo.findRun(runId);
  } else if (viewer.role === 'admin') {
    run = scheduleRepo.findLatestDraftRun(periodId) || scheduleRepo.findPublishedRun(periodId);
  } else {
    run = scheduleRepo.findPublishedRun(periodId);
  }
  if (!run) {
    return {
      period: periodRepo.toPeriodDto(period),
      run: null,
      assignments: [],
      matrix: [],
      gaps: null,
      metrics: null,
      message: '该周期还没有生成排班',
    };
  }

  const rows = scheduleRepo.listAssignmentsWithUser(run.id);
  const allEmployees = scheduleRepo.listActiveEmployeeCount();

  const assignments = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    // 员工之间互相可见姓名，工号仅管理员可见
    name: r.name,
    employeeNo: viewer.role === 'admin' ? r.employee_no : maskEmployeeNo(r.employee_no),
    workDate: r.work_date,
    shiftId: r.shift_id,
    shiftName: r.shift_name,
    shiftSeq: r.seq,
    startTime: r.start_time.slice(0, 5),
    endTime: r.end_time.slice(0, 5),
    workTypeId: r.work_type_id,
    workTypeName: r.work_type_name,
    workTypeColor: r.work_type_color,
    source: r.source,
  }));

  // 矩阵：按日期分组，每天每班次每个工作类型 → 人员列表 + 需求数
  const requirementRows = periodRepo.listRequirements(periodId);
  const reqMap = new Map();
  for (const r of requirementRows) {
    reqMap.set(`${r.work_date}|${r.shift_id}|${r.work_type_id}`, {
      needCount: r.need_count,
      workTypeName: r.work_type_name,
      workTypeColor: r.work_type_color,
      shiftName: r.shift_name,
      shiftSeq: r.seq,
    });
  }

  const matrixMap = new Map();
  for (const [key, req] of reqMap) {
    const [workDate, shiftId, workTypeId] = key.split('|');
    matrixMap.set(key, {
      workDate,
      shiftId: Number(shiftId),
      workTypeId: Number(workTypeId),
      workTypeName: req.workTypeName,
      workTypeColor: req.workTypeColor,
      shiftName: req.shiftName,
      shiftSeq: req.shiftSeq,
      needCount: req.needCount,
      assigned: [],
    });
  }
  for (const a of assignments) {
    const key = `${a.workDate}|${a.shiftId}|${a.workTypeId}`;
    if (!matrixMap.has(key)) {
      matrixMap.set(key, {
        workDate: a.workDate,
        shiftId: a.shiftId,
        workTypeId: a.workTypeId,
        workTypeName: a.workTypeName,
        workTypeColor: a.workTypeColor,
        shiftName: a.shiftName,
        shiftSeq: a.shiftSeq,
        needCount: 0,
        assigned: [],
      });
    }
    matrixMap.get(key).assigned.push({ id: a.id, userId: a.userId, name: a.name, employeeNo: a.employeeNo, source: a.source });
  }

  // 按日期聚合
  const dateMap = new Map();
  for (const cell of matrixMap.values()) {
    if (!dateMap.has(cell.workDate)) {
      dateMap.set(cell.workDate, { workDate: cell.workDate, shifts: new Map() });
    }
    const day = dateMap.get(cell.workDate);
    if (!day.shifts.has(cell.shiftId)) {
      day.shifts.set(cell.shiftId, {
        shiftId: cell.shiftId,
        shiftName: cell.shiftName,
        shiftSeq: cell.shiftSeq,
        workTypes: [],
      });
    }
    const shift = day.shifts.get(cell.shiftId);
    shift.workTypes.push({
      ...cell,
      gap: Math.max(0, cell.needCount - cell.assigned.length),
      filled: cell.assigned.length,
    });
  }

  const matrix = [...dateMap.values()]
    .sort((a, b) => a.workDate.localeCompare(b.workDate))
    .map((d) => ({
      workDate: d.workDate,
      shifts: [...d.shifts.values()].sort((a, b) => a.shiftSeq - b.shiftSeq),
    }));

  const myAssignments = assignments.filter((a) => a.userId === viewer.id);

  return {
    period: periodRepo.toPeriodDto(period),
    run: {
      id: run.id,
      status: run.status,
      algoVersion: run.algo_version,
      seed: run.seed,
      inputHash: run.input_hash,
      totalNeeded: run.total_needed,
      totalFilled: run.total_filled,
      fillRate: run.fill_rate,
      createdAt: run.created_at,
      durationMs: run.duration_ms,
      rounds: run.rounds,
    },
    assignments,
    myAssignments,
    matrix,
    gaps: run.gaps_json ? safeParse(run.gaps_json) : null,
    metrics: run.metrics_json ? safeParse(run.metrics_json) : null,
    activatedEmployees: allEmployees,
  };
}

function maskEmployeeNo(no) {
  if (!no || no.length <= 2) return no;
  return `${no.slice(0, 1)}***${no.slice(-1)}`;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 我的排班（跨周期） */
function getMyAssignments(userId, { upcomingOnly = false } = {}) {
  const rows = db.all(
    `SELECT a.*, s.name AS shift_name, s.seq, s.start_time, s.end_time,
            wt.name AS work_type_name, wt.color AS work_type_color,
            p.name AS period_name, p.status AS period_status
       FROM assignments a
       JOIN schedule_runs r ON r.id = a.run_id AND r.status = 'published'
       JOIN periods p ON p.id = a.period_id
       JOIN shifts s ON s.id = a.shift_id
       JOIN work_types wt ON wt.id = a.work_type_id
      WHERE a.user_id = ? AND a.status = 'active'
      ${upcomingOnly ? "AND a.work_date >= date('now')" : ''}
      ORDER BY a.work_date ASC, s.seq ASC`,
    userId
  );

  return rows.map((r) => ({
    id: r.id,
    periodId: r.period_id,
    periodName: r.period_name,
    periodStatus: r.period_status,
    workDate: r.work_date,
    shiftId: r.shift_id,
    shiftName: r.shift_name,
    shiftSeq: r.seq,
    startTime: r.start_time.slice(0, 5),
    endTime: r.end_time.slice(0, 5),
    workTypeId: r.work_type_id,
    workTypeName: r.work_type_name,
    workTypeColor: r.work_type_color,
  }));
}

/** 管理员总览 */
function getDashboard() {
  const current = periodRepo.findCurrentPeriod();
  const period = current ? periodRepo.toPeriodDto(current) : null;

  const employeeCount = db.pluck(`SELECT COUNT(*) FROM users WHERE status = 'active' AND role = 'employee'`);
  let enrollment = { submitted: 0, total: employeeCount };
  let publishedRun = null;
  let pendingSwaps = 0;

  if (current) {
    enrollment.submitted = db.pluck(
      `SELECT COUNT(*) FROM enrollments WHERE period_id = ? AND status = 'submitted'`,
      current.id
    );
    const run = scheduleRepo.findPublishedRun(current.id);
    if (run) {
      publishedRun = {
        id: run.id,
        totalNeeded: run.total_needed,
        totalFilled: run.total_filled,
        fillRate: run.fill_rate,
        metrics: run.metrics_json ? safeParse(run.metrics_json) : null,
      };
    }
    pendingSwaps = db.pluck(
      `SELECT COUNT(*) FROM swap_requests WHERE period_id = ? AND status = 'pending'`,
      current.id
    );
  }

  const unreadSwaps = db.pluck(
    `SELECT COUNT(*) FROM swap_participants sp
       JOIN swap_requests sr ON sr.id = sp.swap_id
      WHERE sp.status = 'pending' AND sr.status = 'pending'`
  );

  return {
    currentPeriod: period,
    employeeCount,
    enrollment,
    publishedRun,
    pendingSwaps,
    pendingParticipantConfirmations: unreadSwaps,
  };
}

module.exports = {
  buildScheduleInput,
  loadHistory,
  generate,
  publish,
  getSchedule,
  getMyAssignments,
  getDashboard,
};
