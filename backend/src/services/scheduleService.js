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
const enrollmentService = require('./enrollmentService');
const { EmployeeState } = require('../scheduler/constraints');
const configRepo = require('../repositories/configRepo');
const auditRepo = require('../repositories/auditRepo');
const db = require('../db/db');
const { weekday, today, addDays, isDateString, diffDays } = require('../utils/date');
const { generateSchedule, computeInputHash, evaluateAssignments } = require('../scheduler');
const { config, PERIOD_STATUS, RUN_STATUS, ASSIGNMENT_SOURCE } = require('../config');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');

/**
 * 汇总历史：某员工在某工作类型上被排过多少次、上次是什么时候
 * @returns {Map<userId, {byWorkType: Map, total, lastDateByWorkType: Map}>}
 */
function loadHistory(periodStartDate, historyPeriods = config.historyPeriods) {
  const rows = db.all(
    `SELECT a.user_id, a.work_type_id, a.work_date
       FROM assignments a
       JOIN periods p ON p.id = a.period_id AND p.deleted_at IS NULL
       JOIN schedule_runs r ON r.id = a.run_id AND r.status = 'published'
      WHERE a.status = 'active'
        AND p.start_date < ? AND a.work_date < ?
      ORDER BY a.work_date ASC`,
    periodStartDate, periodStartDate
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

  const scope = periodRepo.getScope(period);
  const shiftMap = new Map(configRepo.listShifts().filter((s) => scope.shiftIds === null || scope.shiftIds.includes(s.id)).map((s) => [s.id, s]));
  const workTypeMap = new Map(configRepo.listWorkTypes().filter((w) => scope.workTypeIds === null || scope.workTypeIds.includes(w.id)).map((w) => [w.id, w]));
  const requirements = periodRepo.listRequirements(periodId).filter((r) => shiftMap.get(r.shift_id)?.active && workTypeMap.get(r.work_type_id)?.active && JSON.parse(workTypeMap.get(r.work_type_id).weekdays_json).includes(weekday(r.work_date)));
  if (!requirements.length) {
    throw badRequest('该周期还没有配置需求人数，请先在「需求配置」里填写');
  }

  const slots = requirements.map((r) => {
    const shift = shiftMap.get(r.shift_id);
    const requiresRoles = workTypeMap.get(r.work_type_id)?.requires_roles === 1;
    if (requiresRoles && r.need_count < 2) throw badRequest(`「${r.work_type_name}」需要主副负责人，${r.work_date} ${r.shift_name} 的总需求人数至少为 2`);
    return {
      workDate: r.work_date,
      shiftId: r.shift_id,
      shiftSeq: shift ? shift.seq : 999,
      workTypeId: r.work_type_id,
      needCount: r.need_count,
      requiresRoles,
      dutyPairs: JSON.parse(workTypeMap.get(r.work_type_id).duty_pairs_json),
      workTypeName: r.work_type_name,
      workTypeColor: r.work_type_color,
      shiftName: r.shift_name,
    };
  });

  const enrollments = enrollmentService.getEffectiveEnrollments(periodId);
  if (!enrollments.length) {
    throw badRequest('还没有员工报名或配置长期固定人员，无法排班');
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
      availability: e.hasSubmitted && avail ? [...avail] : [],
      unavailableDates: e.hasSubmitted ? [...(unavailabilityMap.get(e.userId) || [])] : [],
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
    fixedAssignments: slots.flatMap((slot) => JSON.parse(workTypeMap.get(slot.workTypeId).weekly_assignments_json)
      .filter((r) => r.weekday === weekday(slot.workDate) && r.shiftId === slot.shiftId)
      .map((r) => ({ ...r, ...slot, dutyRole: r.dutyRole, userId: r.userId }))),
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
        dutyRole: a.dutyRole,
        source: a.isFixed ? ASSIGNMENT_SOURCE.MANUAL : ASSIGNMENT_SOURCE.ALGO,
        isFixed: a.isFixed,
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
function publish(periodId, runId, ctx, { expectedRevision, publishedRunId, publishedRevision } = {}) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');

  const run = runId
    ? scheduleRepo.findRun(runId)
    : scheduleRepo.findLatestDraftRun(periodId);
  if (!run) throw notFound('没有可发布的排班草稿');
  if (run.period_id !== periodId) throw badRequest('排班草稿不属于该周期');
  if (run.status === RUN_STATUS.PUBLISHED) return { runId: run.id, alreadyPublished: true };
  if (run.status !== RUN_STATUS.DRAFT) throw conflict('RUN_DISCARDED', '该草稿已作废，请重新生成排班');
  if (expectedRevision !== undefined && run.revision !== expectedRevision) throw conflict('DRAFT_CHANGED', '草稿已被其他管理员调配，请重新检查后再发布');
  if (run.gaps_json && safeParse(run.gaps_json)?.fixedConflicts?.length) throw conflict('FIXED_ASSIGNMENTS_UNRESOLVED', '部分固定人员尚未安排成功，请先在草稿中处理固定名单冲突');
  if (run.input_hash && computeInputHash(buildScheduleInput(periodId, { seed: run.seed })) !== run.input_hash) {
    throw conflict('SCHEDULE_INPUT_CHANGED', '工作配置、需求或员工报名已变化，请重新生成排班再发布');
  }

  // 负责人岗位不能以缺主或缺副的状态发布；总人数的其他缺口仍按原规则展示。
  const scope = periodRepo.getScope(period);
  const roleRequirements = db.all(`SELECT r.*, w.name, w.weekdays_json, w.duty_pairs_json FROM slot_requirements r JOIN work_types w ON w.id=r.work_type_id
    JOIN shifts s ON s.id=r.shift_id
    WHERE r.period_id=? AND r.need_count>0 AND w.requires_roles=1 AND w.active=1 AND s.active=1`, periodId).filter((r) => (scope.workTypeIds === null || scope.workTypeIds.includes(r.work_type_id)) && (scope.shiftIds === null || scope.shiftIds.includes(r.shift_id)) && JSON.parse(r.weekdays_json).includes(weekday(r.work_date)));
  const assignments = scheduleRepo.listAssignmentsWithUser(run.id);
  const eligible = new Map(enrollmentService.getEffectiveEnrollments(periodId).map((e) => [e.userId, new EmployeeState(e, periodRepo.toPeriodDto(period))]));
  const roleQualified = (a) => eligible.get(a.user_id)?.matchesWork({ workTypeId: a.work_type_id, workDate: a.work_date, shiftId: a.shift_id, dutyRole: a.duty_role, manualOverride: a.source === 'manual' && !a.is_fixed });
  const missingRoles = [];
  for (const req of roleRequirements) {
    if (req.need_count < 2) throw badRequest(`「${req.name}」总需求人数至少为 2，请修改需求并重新生成`);
    const people = assignments.filter((a) => a.work_date === req.work_date && a.shift_id === req.shift_id && a.work_type_id === req.work_type_id);
    for (const [role, label] of [['primary', '主负责人'], ['deputy', '副负责人']]) {
      if (!people.some((a) => a.duty_role === role && roleQualified(a))) missingRoles.push(`${req.work_date} ${req.name} 缺合格${label}`);
    }
  }
  if (assignments.some((a) => ['primary', 'deputy'].includes(a.duty_role) && !roleQualified(a))) {
    throw conflict('ROLE_QUALIFICATION_CHANGED', '草稿中有员工未报名相应负责人角色，请更新报名后重新生成排班');
  }
  if (missingRoles.length) throw conflict('ROLE_COVERAGE_MISSING', `主副负责人未配齐，不能发布：${missingRoles.slice(0, 5).join('；')}`, { missingRoles });
  const pairProblems = require('../scheduler/dutyPairs').validatePairs(roleRequirements.map((r) => ({ workDate: r.work_date, shiftId: r.shift_id, workTypeId: r.work_type_id, dutyPairs: JSON.parse(r.duty_pairs_json) })), assignments.map((a) => ({ workDate: a.work_date, shiftId: a.shift_id, workTypeId: a.work_type_id, dutyRole: a.duty_role, userId: a.user_id })));
  if (pairProblems.length) throw conflict('DUTY_PAIR_MISMATCH', '主副搭档不匹配，不能发布', { problems: pairProblems });

  const live = scheduleRepo.findPublishedRun(periodId);
  if (publishedRunId !== undefined && ((live?.id || 0) !== publishedRunId || (live?.revision || 0) !== publishedRevision)) throw conflict('PUBLISHED_CHANGED', '生效排班已被换班或重新发布，请重新检查发布差异');
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

function readEditableDraft(runId) {
  const run = scheduleRepo.findRun(runId);
  if (!run) throw notFound('排班草稿不存在');
  if (run.status !== RUN_STATUS.DRAFT) throw conflict('DRAFT_LOCKED', '只能调配尚未发布的草稿，请重新生成草稿后调整');
  const period = periodRepo.findPeriod(run.period_id);
  if (!period) throw notFound('排班周期不存在');
  if (period.status === PERIOD_STATUS.ARCHIVED) throw conflict('PERIOD_ARCHIVED', '已归档周期不能调配');
  const input = buildScheduleInput(run.period_id, { seed: run.seed });
  if (computeInputHash(input) !== run.input_hash) throw conflict('SCHEDULE_INPUT_CHANGED', '工作配置、需求或报名已变化，请先重新生成草稿');
  const assignments = scheduleRepo.listAssignmentsWithUser(run.id).map((a) => ({ id: a.id, workDate: a.work_date, shiftId: a.shift_id, workTypeId: a.work_type_id, dutyRole: a.duty_role, userId: a.user_id, source: a.source, isFixed: a.is_fixed === 1 }));
  return { run, input, assignments };
}

function draftTarget(draft, target) {
  if (target.assignmentId) {
    const current = draft.assignments.find((a) => a.id === target.assignmentId);
    if (!current) throw conflict('ASSIGNMENT_CHANGED', '这条草稿安排已变化，请刷新后重试');
    return current;
  }
  const slot = draft.input.slots.find((s) => s.workDate === target.workDate && s.shiftId === target.shiftId && s.workTypeId === target.workTypeId);
  if (!slot) throw badRequest('所选日期、班次或工作没有配置需求');
  if ((slot.requiresRoles && !['primary', 'deputy'].includes(target.dutyRole)) || (!slot.requiresRoles && target.dutyRole !== 'member')) throw badRequest('请选择与工作要求一致的岗位角色');
  return { workDate: slot.workDate, shiftId: slot.shiftId, workTypeId: slot.workTypeId, dutyRole: target.dutyRole };
}

function getDraftCandidates(runId, target) {
  const draft = readEditableDraft(runId);
  const current = draftTarget(draft, target);
  const others = draft.assignments.filter((a) => a.id !== target.assignmentId);
  return { revision: draft.run.revision, candidates: scheduleRepo.listActiveParticipants().map((u) => {
    const result = evaluateAssignments(draft.input, [...others, { ...current, id: null, userId: u.id, source: 'manual', isFixed: false }]);
    return { userId: u.id, name: u.name, employeeNo: u.employee_no, canAssign: result.problems.length === 0, problems: result.problems };
  }) };
}

function adjustDraft(runId, change, ctx) {
  if (!['admin', 'super_admin'].includes(ctx.user?.role)) throw forbidden('仅管理员可以调配草稿');
  if (!['add', 'replace', 'remove'].includes(change.action)) throw badRequest('无效的草稿调配方式');
  if ((change.action !== 'add') !== Boolean(change.assignmentId)) throw badRequest('调配目标与操作方式不一致');
  let periodId;
  db.tx(() => {
    const draft = readEditableDraft(runId);
    if (change.revision !== undefined && draft.run.revision !== change.revision) throw conflict('DRAFT_CHANGED', '草稿已被调配，请刷新后再修改');
    const current = draftTarget(draft, change);
    const keep = change.action === 'add' ? draft.assignments : draft.assignments.filter((a) => a.id !== change.assignmentId);
    const added = change.action === 'remove' ? null : { ...current, id: null, userId: change.userId, source: 'manual', isFixed: false };
    const result = evaluateAssignments(draft.input, added ? [...keep, added] : keep);
    if (result.problems.length) throw conflict('DRAFT_CONSTRAINT_VIOLATION', '该调配不满足排班约束', { problems: result.problems });
    if (change.action !== 'add') scheduleRepo.releaseAssignment(current.id);
    if (added) scheduleRepo.bulkInsertAssignments(runId, draft.run.period_id, [added]);
    const cell = `${current.workDate}|${current.shiftId}|${current.workTypeId}`;
    const oldGaps = safeParse(draft.run.gaps_json) || {};
    result.gaps.fixedConflicts = (oldGaps.fixedConflicts || []).filter((a) => `${a.workDate}|${a.shiftId}|${a.workTypeId}` !== cell);
    result.gaps.fixedOverrides = [...new Set([...(oldGaps.fixedOverrides || []), cell])];
    db.run(`UPDATE schedule_runs SET total_filled=?,fill_rate=?,gaps_json=?,metrics_json=?,revision=revision+1 WHERE id=?`, result.gaps.totalFilled, result.gaps.fillRate, JSON.stringify(result.gaps), JSON.stringify(result.metrics), runId);
    auditRepo.log({ action: auditRepo.ACTIONS.ASSIGNMENT_MANUAL, entityType: 'schedule_run', entityId: runId, periodId: draft.run.period_id, actorId: ctx.user.id, detail: { action: change.action, previous: change.action === 'add' ? null : current, next: added, revision: draft.run.revision + 1 }, requestId: ctx.requestId });
    periodId = draft.run.period_id;
  });
  return getSchedule(periodId, ctx.user, { runId });
}

/**
 * 读取排班表（矩阵视图 + 缺口 + 指标）
 * @param {object} viewer { id, role }
 */
function getSchedule(periodId, viewer, { runId, version } = {}) {
  const period = periodRepo.findPeriod(periodId);
  if (!period) throw notFound('排班周期不存在');
  const employees = ['admin', 'super_admin'].includes(viewer.role) ? scheduleRepo.listActiveParticipants().map((u) => ({ id: u.id, name: u.name, employeeNo: u.employee_no })) : [];

  // run 选择策略（关键）：
  //   指定 runId → 用它（管理员预览草稿）
  //   管理员 → 优先最新草稿（刚生成的结果要能立刻看到），无草稿则看已发布
  //   员工 → 只看已发布（草稿未生效，不能展示给员工）
  let run;
  if ((runId || version === 'draft') && !['admin', 'super_admin'].includes(viewer.role)) throw forbidden('仅管理员可以预览排班草稿');
  if (runId) {
    run = scheduleRepo.findRun(runId);
    if (run && run.period_id !== periodId) throw badRequest('排班记录不属于该周期');
  } else if (version === 'published') {
    run = scheduleRepo.findPublishedRun(periodId);
  } else if (version === 'draft') {
    run = scheduleRepo.findLatestDraftRun(periodId);
  } else if (['admin', 'super_admin'].includes(viewer.role)) {
    run = scheduleRepo.findLatestDraftRun(periodId) || scheduleRepo.findPublishedRun(periodId);
  } else {
    run = scheduleRepo.findPublishedRun(periodId);
  }
  if (!run) {
    return {
      period: periodRepo.toPeriodDto(period),
      run: null,
      assignments: [],
      employees,
      matrix: [],
      gaps: null,
      metrics: null,
      message: '该周期还没有生成排班',
    };
  }

  const rows = scheduleRepo.listAssignmentsWithUser(run.id);
  const savedGaps = run.gaps_json ? safeParse(run.gaps_json) : null;
  const roleWorkTypes = new Set((savedGaps?.byWorkType || []).filter((w) => w.requiresRoles).map((w) => w.workTypeId));
  const allEmployees = scheduleRepo.listActiveParticipantCount();

  const assignments = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    // 员工之间互相可见姓名，工号仅管理员可见
    name: r.name,
    employeeNo: ['admin', 'super_admin'].includes(viewer.role) ? r.employee_no : maskEmployeeNo(r.employee_no),
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
    dutyRole: r.duty_role,
    isFixed: r.is_fixed === 1,
  }));

  // 矩阵：按日期分组，每天每班次每个工作类型 → 人员列表 + 需求数
  const runWorkTypes = new Set((savedGaps?.byWorkType || []).map((w) => w.workTypeId));
  const requirementRows = savedGaps?.requirements || periodRepo.listRequirements(periodId).filter((r) => !runWorkTypes.size || runWorkTypes.has(r.work_type_id)).map((r) => ({
    workDate: r.work_date, shiftId: r.shift_id, workTypeId: r.work_type_id, needCount: r.need_count,
    requiresRoles: roleWorkTypes.has(r.work_type_id), workTypeName: r.work_type_name, workTypeColor: r.work_type_color, shiftName: r.shift_name, shiftSeq: r.seq,
  }));
  const reqMap = new Map();
  for (const r of requirementRows) {
    reqMap.set(`${r.workDate}|${r.shiftId}|${r.workTypeId}`, r);
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
      requiresRoles: req.requiresRoles,
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
    matrixMap.get(key).assigned.push({ id: a.id, userId: a.userId, name: a.name, employeeNo: a.employeeNo, source: a.source, dutyRole: a.dutyRole, isFixed: a.isFixed });
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
      roleGaps: cell.requiresRoles ? ['primary', 'deputy'].filter((role) => !cell.assigned.some((a) => a.dutyRole === role)) : [],
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
      revision: run.revision,
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
    employees,
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
       JOIN periods p ON p.id = a.period_id AND p.deleted_at IS NULL
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
    dutyRole: r.duty_role,
  }));
}

/** 跨周期的本人近期安排，同行人员按生效版本、日期、班次和工作精确匹配。 */
function getRecentSchedule(userId, { startDate = today(), endDate, days = 7 } = {}) {
  if (!isDateString(startDate)) throw badRequest('开始日期格式错误');
  if (!Number.isInteger(days) || days < 1 || days > 366) throw badRequest('天数必须为 1–366');
  endDate = endDate ?? addDays(startDate, days - 1);
  if (!isDateString(endDate) || endDate < startDate) throw badRequest('结束日期必须有效且不早于开始日期');
  if (diffDays(startDate, endDate) > 365) throw badRequest('一次最多查看 366 天');
  const rows = db.all(`SELECT a.*, p.name AS period_name, s.name AS shift_name, s.start_time, s.end_time,
      w.name AS work_type_name, w.color AS work_type_color,
      peer.user_id AS peer_id, u.name AS peer_name, peer.duty_role AS peer_role
    FROM assignments a
    JOIN schedule_runs r ON r.id=a.run_id AND r.status='published'
    JOIN periods p ON p.id=a.period_id AND p.deleted_at IS NULL
    JOIN shifts s ON s.id=a.shift_id
    JOIN work_types w ON w.id=a.work_type_id
    LEFT JOIN assignments peer ON peer.run_id=a.run_id AND peer.work_date=a.work_date
      AND peer.shift_id=a.shift_id AND peer.work_type_id=a.work_type_id AND peer.status='active' AND peer.user_id<>a.user_id
    LEFT JOIN users u ON u.id=peer.user_id
    WHERE a.user_id=? AND a.status='active' AND a.work_date BETWEEN ? AND ?
    ORDER BY a.work_date,s.seq,w.sort_order,a.id,peer.user_id`, userId, startDate, endDate);
  const assignments = new Map();
  for (const row of rows) {
    if (!assignments.has(row.id)) assignments.set(row.id, {
      id: row.id, periodId: row.period_id, periodName: row.period_name, workDate: row.work_date,
      shiftId: row.shift_id, shiftName: row.shift_name, startTime: row.start_time.slice(0, 5), endTime: row.end_time.slice(0, 5),
      workTypeId: row.work_type_id, workTypeName: row.work_type_name, workTypeColor: row.work_type_color,
      dutyRole: row.duty_role, source: row.source, coworkers: [],
    });
    if (row.peer_id) assignments.get(row.id).coworkers.push({ userId: row.peer_id, name: row.peer_name, dutyRole: row.peer_role });
  }
  return { startDate, endDate, assignments: [...assignments.values()] };
}

/** 管理员总览 */
function getDashboard() {
  const current = periodRepo.findCurrentPeriod();
  const period = current ? periodRepo.toPeriodDto(current) : null;

  const employeeCount = db.pluck(`SELECT COUNT(*) FROM users WHERE status = 'active'`);
  let enrollment = { submitted: 0, total: employeeCount };
  let publishedRun = null;
  let pendingSwaps = 0;

  if (current) {
    enrollment.submitted = enrollmentRepo.countSubmittedEnrollments(current.id);
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
       JOIN periods p ON p.id=sr.period_id AND p.deleted_at IS NULL
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
  getRecentSchedule,
  getDraftCandidates,
  adjustDraft,
  buildScheduleInput,
  loadHistory,
  generate,
  publish,
  getSchedule,
  getMyAssignments,
  getDashboard,
};
