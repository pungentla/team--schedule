'use strict';

/**
 * 换班服务 —— 状态机 + 事务化生效。
 *
 * 状态流转：
 *   pending ──(全部参与者 approved)──► approved ──► 事务内原子生效
 *      ├──(任一 rejected)──► rejected（不改任何 assignments）
 *      ├──(requester cancel)──► cancelled
 *      └──(超过截止日期)──► expired
 *
 * 关键设计：
 *  1. 发起人自身 participant 直接 approved（seq=0），接收人 pending（seq=1）。
 *     这样"逐个确认"天然成立，且未来加多方确认只需追加 participant。
 *  2. 每次确认后检查：无 pending 且无 rejected → 同一事务内生效。
 *  3. 生效前全量硬约束复检（期间别人可能已排班），失败整体 ROLLBACK 返回 409。
 *  4. 幂等：重复确认返回 409 ALREADY_DECIDED，不重复生效。
 *  5. 数据库部分唯一索引 (period_id,user_id,work_date,shift_id) WHERE status='active'
 *     是并发场景下的最后兜底。
 */

const swapRepo = require('../repositories/swapRepo');
const scheduleRepo = require('../repositories/scheduleRepo');
const periodRepo = require('../repositories/periodRepo');
const configRepo = require('../repositories/configRepo');
const enrollmentRepo = require('../repositories/enrollmentRepo');
const enrollmentService = require('./enrollmentService');
const auditRepo = require('../repositories/auditRepo');
const userRepo = require('../repositories/userRepo');
const db = require('../db/db');
const { EmployeeState, checkSlot, REASON_LABELS } = require('../scheduler/constraints');
const {
  PERIOD_STATUS,
  SWAP_TYPE,
  SWAP_STATUS,
  SWAP_PARTICIPANT_ROLE,
  SWAP_PARTICIPANT_STATUS,
  ASSIGNMENT_SOURCE,
} = require('../config');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');
const { computeMetrics } = require('../scheduler/metrics');
const { isoWeekKey } = require('../utils/date');

/**
 * 构建某员工在某周期内的实时状态（含已发布排班），用于换班合法性复检。
 * 复用 scheduler/constraints.js，保证与排班算法使用同一套规则。
 */
function buildEmployeeState(period, userId) {
  const enrolled = enrollmentService.getEffectiveEnrollments(period.id).find((e) => e.userId === userId);
  const availabilityMap = enrollmentRepo.loadAvailabilityMap(period.id);
  const unavailabilityMap = enrollmentRepo.loadUnavailabilityMap(period.id);

  const emp = new EmployeeState(
    {
      userId,
      name: enrolled ? enrolled.name : `用户${userId}`,
      employeeNo: enrolled ? enrolled.employeeNo : String(userId),
      maxShifts: enrolled ? enrolled.maxShifts : 0,
      workTypes: enrolled ? enrolled.workTypes : [],
      availability: enrolled?.hasSubmitted ? [...(availabilityMap.get(userId) || [])] : [],
      unavailableDates: enrolled?.hasSubmitted ? [...(unavailabilityMap.get(userId) || [])] : [],
      historyByWorkType: new Map(),
      historyTotal: 0,
      lastDateByWorkType: new Map(),
    },
    {
      maxShiftsPerDay: period.max_shifts_per_day,
      maxShiftsPerWeek: period.max_shifts_per_week,
      forbidConsecutive: period.forbid_consecutive === 1,
    }
  );

  // 把该员工已生效的排班计入状态
  const existing = scheduleRepo.listUserAssignmentsInPeriod(period.id, userId);
  for (const a of existing) {
    emp.addAssignment({ date: a.work_date, shiftSeq: a.shift_seq, workTypeId: a.work_type_id });
  }

  return { emp, existing };
}

/**
 * 预检某条分配能否交给某人（不写库）。
 * @returns {Array<{code,message}>} 空数组表示可以
 */
function precheckTransfer({ period, assignment, toUserId, excludeAssignmentId = null }) {
  const published = scheduleRepo.findPublishedRun(period.id);
  if (!published || published.id !== assignment.run_id) {
    return [{ code: 'schedule_replaced', message: '该班次所属排班已被新版本替换，请以最新已发布排班为准' }];
  }
  const shift = configRepo.findShift(assignment.shift_id);
  const problems = [];

  const { emp } = buildEmployeeState(period, toUserId);

  // 若待释放的是 toUserId 自己的班次，先从状态里移除（exchange 场景）
  if (excludeAssignmentId) {
    const own = scheduleRepo.findAssignment(excludeAssignmentId);
    if (own && own.user_id === toUserId) {
      const ownShift = configRepo.findShift(own.shift_id);
      emp.removeAssignment({ date: own.work_date, shiftSeq: ownShift.seq, workTypeId: own.work_type_id });
    }
  }

  const slot = {
    workDate: assignment.work_date,
    shiftId: assignment.shift_id,
    shiftSeq: shift ? shift.seq : 999,
    workTypeId: assignment.work_type_id,
    dutyRole: assignment.duty_role || 'member',
    manualOverride: true,
  };

  const res = checkSlot(emp, slot, {
    maxShiftsPerDay: period.max_shifts_per_day,
    maxShiftsPerWeek: period.max_shifts_per_week,
    forbidConsecutive: period.forbid_consecutive === 1,
  });

  if (res) problems.push({ code: res.code, message: res.message });

  return problems;
}

/**
 * 创建换班申请
 * @param {object} payload { type, fromAssignmentId, toUserId, toAssignmentId, message }
 */
function createSwap(payload, ctx) {
  const requesterId = ctx.user.id;
  const fromAssignment = scheduleRepo.findAssignment(payload.fromAssignmentId);
  if (!fromAssignment) throw notFound('要转出的排班不存在');
  if (fromAssignment.user_id !== requesterId) throw forbidden('只能转出自己的班次');
  if (fromAssignment.status !== 'active') throw conflict('ASSIGNMENT_RELEASED', '该班次已不在你名下');

  const period = periodRepo.findPeriod(fromAssignment.period_id);
  if (!period) throw notFound('周期不存在');
  if (period.status !== PERIOD_STATUS.PUBLISHED) {
    throw conflict('PERIOD_NOT_PUBLISHED', '排班尚未发布，不能发起换班');
  }

  const toUserId = Number(payload.toUserId);
  if (!Number.isInteger(toUserId) || toUserId === requesterId) {
    throw badRequest('请选择其他员工作为接收人');
  }
  const toUser = userRepo.findById(toUserId);
  if (!toUser || toUser.status !== 'active') throw badRequest('接收人不存在或已停用');

  const type = payload.type === SWAP_TYPE.EXCHANGE ? SWAP_TYPE.EXCHANGE : SWAP_TYPE.TRANSFER;

  let toAssignmentId = null;
  const problems = [];

  if (type === SWAP_TYPE.EXCHANGE) {
    const target = scheduleRepo.findAssignment(payload.toAssignmentId);
    if (!target) throw badRequest('交换模式下必须选择对方的一个班次');
    if (target.user_id !== toUserId) throw badRequest('目标班次不属于所选接收人');
    if (target.status !== 'active') throw conflict('ASSIGNMENT_RELEASED', '目标班次已不在对方名下');
    if (target.period_id !== period.id || target.run_id !== fromAssignment.run_id) throw badRequest('只能在同一生效周期内交换');
    toAssignmentId = target.id;

    // 双向检查：A 能否接 B 的班，B 能否接 A 的班
    problems.push(
      ...precheckTransfer({ period, assignment: target, toUserId: requesterId, excludeAssignmentId: fromAssignment.id })
        .map((p) => ({ ...p, direction: 'to_requester' }))
    );
    problems.push(
      ...precheckTransfer({ period, assignment: fromAssignment, toUserId, excludeAssignmentId: target.id })
        .map((p) => ({ ...p, direction: 'to_receiver' }))
    );
  } else {
    problems.push(
      ...precheckTransfer({ period, assignment: fromAssignment, toUserId }).map((p) => ({
        ...p,
        direction: 'to_receiver',
      }))
    );
  }

  if (problems.length) {
    throw conflict('SWAP_CONSTRAINT_VIOLATION', '该换班不满足排班约束', {
      problems: problems.map((p) => ({ ...p, label: REASON_LABELS[p.code] || p.message })),
    });
  }

  // 重复申请检查：同一条分配已有 pending 申请
  const dup = swapRepo.findPendingByAssignment(fromAssignment.id);
  if (dup) throw conflict('SWAP_ALREADY_PENDING', '该班次已有待确认的换班申请');

  let swapId;
  db.tx(() => {
    swapId = swapRepo.insertSwap({
      periodId: period.id,
      type,
      fromAssignmentId: fromAssignment.id,
      toUserId,
      toAssignmentId,
      requesterId,
      message: payload.message || null,
    });
    // 发起人直接 approved，接收人 pending
    swapRepo.insertParticipant(swapId, requesterId, SWAP_PARTICIPANT_ROLE.REQUESTER, 0, SWAP_PARTICIPANT_STATUS.APPROVED);
    swapRepo.insertParticipant(swapId, toUserId, SWAP_PARTICIPANT_ROLE.RECEIVER, 1, SWAP_PARTICIPANT_STATUS.PENDING);
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.SWAP_CREATE,
    entityType: 'swap',
    entityId: swapId,
    periodId: period.id,
    actorId: requesterId,
    detail: {
      type,
      fromAssignmentId: fromAssignment.id,
      toUserId,
      toAssignmentId,
      workDate: fromAssignment.work_date,
    },
    requestId: ctx.requestId,
  });

  return getSwapDetail(swapId, ctx.user);
}

/** 详情（含冲突预检，供前端展示"确认会不会失败"） */
function getSwapDetail(swapId, viewer) {
  const swap = swapRepo.findSwap(swapId);
  if (!swap) throw notFound('换班申请不存在');

  const participants = swapRepo.listParticipants(swapId);
  const isParticipant = participants.some((p) => p.user_id === viewer.id);
  if (!isParticipant && !['admin', 'super_admin'].includes(viewer.role)) throw forbidden('无权查看该换班申请');

  const fromAssign = swapRepo.findAssignmentDetail(swap.from_assignment_id);
  const toAssign = swap.to_assignment_id ? swapRepo.findAssignmentDetail(swap.to_assignment_id) : null;
  const period = periodRepo.findPeriod(swap.period_id);

  // 实时冲突预检（pending 状态才需要）
  let liveProblems = [];
  if (swap.status === SWAP_STATUS.PENDING && fromAssign) {
    const from = scheduleRepo.findAssignment(swap.from_assignment_id);
    if (!from || from.status !== 'active') {
      liveProblems.push({ code: 'ASSIGNMENT_RELEASED', label: '原班次已不在发起人名下', message: '原班次已不在发起人名下' });
    } else if (swap.type === SWAP_TYPE.EXCHANGE) {
      const target = scheduleRepo.findAssignment(swap.to_assignment_id);
      if (!target || target.status !== 'active' || target.user_id !== swap.to_user_id) {
        liveProblems.push({ code: 'ASSIGNMENT_RELEASED', label: '目标班次已不在对方名下', message: '目标班次已不在对方名下' });
      } else {
        liveProblems = [
          ...precheckTransfer({ period, assignment: target, toUserId: swap.requester_id, excludeAssignmentId: from.id }),
          ...precheckTransfer({ period, assignment: from, toUserId: swap.to_user_id, excludeAssignmentId: target.id }),
        ].map((p) => ({ ...p, label: REASON_LABELS[p.code] || p.message }));
      }
    } else {
      liveProblems = precheckTransfer({ period, assignment: from, toUserId: swap.to_user_id }).map((p) => ({
        ...p,
        label: REASON_LABELS[p.code] || p.message,
      }));
    }
  }

  return {
    swap: {
      id: swap.id,
      periodId: swap.period_id,
      type: swap.type,
      status: swap.status,
      message: swap.message,
      requesterId: swap.requester_id,
      requesterName: swap.requester_name,
      toUserId: swap.to_user_id,
      toUserName: swap.to_user_name,
      createdAt: swap.created_at,
      decidedAt: swap.decided_at,
      appliedAt: swap.applied_at,
    },
    fromAssignment: fromAssign ? formatAssignment(fromAssign) : null,
    toAssignment: toAssign ? formatAssignment(toAssign) : null,
    participants: participants.map((p) => ({
      userId: p.user_id,
      name: p.name,
      role: p.role,
      seq: p.seq,
      status: p.status,
      decidedAt: p.decided_at,
      isMe: p.user_id === viewer.id,
    })),
    myDecision: participants.find((p) => p.user_id === viewer.id)?.status || null,
    canConfirm: liveProblems.length === 0 && swap.status === SWAP_STATUS.PENDING,
    liveProblems,
    // 审计时间线
    timeline: buildTimeline(swap, participants),
  };
}

function buildTimeline(swap, participants) {
  const events = [{ at: swap.created_at, action: 'created', text: `${swap.requester_name} 发起换班申请` }];
  for (const p of participants) {
    if (p.status === SWAP_PARTICIPANT_STATUS.APPROVED && p.role !== SWAP_PARTICIPANT_ROLE.REQUESTER) {
      events.push({ at: p.decided_at, action: 'approved', text: `${p.name} 已同意` });
    }
    if (p.status === SWAP_PARTICIPANT_STATUS.REJECTED) {
      events.push({ at: p.decided_at, action: 'rejected', text: `${p.name} 已拒绝` });
    }
  }
  if (swap.applied_at) events.push({ at: swap.applied_at, action: 'applied', text: '换班已生效' });
  return events.filter((e) => e.at).sort((a, b) => a.at.localeCompare(b.at));
}

function formatAssignment(a) {
  return {
    id: a.id,
    userId: a.user_id,
    userName: a.user_name,
    employeeNo: a.employee_no,
    workDate: a.work_date,
    shiftId: a.shift_id,
    shiftName: a.shift_name,
    shiftSeq: a.seq,
    startTime: a.start_time ? a.start_time.slice(0, 5) : null,
    endTime: a.end_time ? a.end_time.slice(0, 5) : null,
    workTypeId: a.work_type_id,
    dutyRole: a.duty_role,
    workTypeName: a.work_type_name,
    workTypeColor: a.work_type_color,
    status: a.status,
  };
}

/**
 * 同意换班 —— 核心事务逻辑
 */
function confirm(swapId, ctx) {
  const swap = swapRepo.findSwap(swapId);
  if (!swap) throw notFound('换班申请不存在');

  if (swap.status !== SWAP_STATUS.PENDING) {
    throw conflict('ALREADY_DECIDED', `该申请已结束（当前状态：${swap.status}）`);
  }

  const participants = swapRepo.listParticipants(swapId);
  const mine = participants.find((p) => p.user_id === ctx.user.id);
  if (!mine) throw forbidden('你不是该换班申请的参与者');
  if (mine.status !== SWAP_PARTICIPANT_STATUS.PENDING) {
    throw conflict('ALREADY_DECIDED', '你已经处理过该申请');
  }

  const period = periodRepo.findPeriod(swap.period_id);
  if (!period || period.status === PERIOD_STATUS.ARCHIVED) {
    throw conflict('PERIOD_CLOSED', '该周期已归档，换班无法生效');
  }

  // 先记录本次同意
  db.tx(() => {
    swapRepo.decideParticipant(mine.id, SWAP_PARTICIPANT_STATUS.APPROVED);
  });

  // 检查是否全部同意
  const after = swapRepo.listParticipants(swapId);
  const anyRejected = after.some((p) => p.status === SWAP_PARTICIPANT_STATUS.REJECTED);
  const allApproved = after.every((p) => p.status === SWAP_PARTICIPANT_STATUS.APPROVED);

  auditRepo.log({
    action: auditRepo.ACTIONS.SWAP_CONFIRM,
    entityType: 'swap',
    entityId: swapId,
    periodId: swap.period_id,
    actorId: ctx.user.id,
    detail: { allApproved, anyRejected },
    requestId: ctx.requestId,
  });

  if (anyRejected) {
    swapRepo.updateSwapStatus(swapId, SWAP_STATUS.REJECTED);
    return { applied: false, status: SWAP_STATUS.REJECTED, reason: '已有参与者拒绝' };
  }

  if (!allApproved) {
    return {
      applied: false,
      status: SWAP_STATUS.PENDING,
      waitingFor: after
        .filter((p) => p.status === SWAP_PARTICIPANT_STATUS.PENDING)
        .map((p) => ({ userId: p.user_id, name: p.name })),
    };
  }

  // === 全部同意 → 事务内原子生效 ===
  try {
    const applied = applySwap(swap, period, ctx);
    return { applied: true, status: SWAP_STATUS.APPROVED, ...applied };
  } catch (err) {
    // 生效失败（如期间他人被排班导致冲突）→ 整体回滚。
    // 必须把参与者状态退回 pending，否则用户既不能重试也无法重新确认，申请会被"卡死"。
    // 同时记录失败原因，便于前端展示与管理员排查。
    db.run(
      `UPDATE swap_participants SET status = 'pending', decided_at = NULL WHERE id = ?`,
      mine.id
    );
    db.run(
      `INSERT INTO audit_logs (action, entity_type, entity_id, period_id, actor_id, detail_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'SWAP_APPLY_FAILED',
      'swap',
      swapId,
      swap.period_id,
      ctx.user.id,
      JSON.stringify({ code: err.code || err.name, message: err.message, details: err.details || null }),
      ctx.requestId,
      new Date().toISOString()
    );
    throw err;
  }
}

/**
 * 在单个事务里执行换班：
 *   1. 全量硬约束复检（期间别人可能已排班）
 *   2. transfer: 原 assignment → released，插入新行给接收人
 *      exchange: 两条都 released，各插一条互换后的新行
 *   3. 更新 swap 状态 + 审计日志
 * 任一步失败 → 整体 ROLLBACK，返回 409，participant 退回 pending 由调用方处理。
 */
function applySwap(swap, period, ctx, { adminDirect = false } = {}) {
  if (adminDirect && !['admin', 'super_admin'].includes(ctx.user.role)) throw forbidden('仅管理员可以直接调配已发布排班');
  const fromAssignmentId = swap.from_assignment_id;
  const toAssignmentId = swap.to_assignment_id;

  const result = db.tx(() => {
    const from = db.get('SELECT * FROM assignments WHERE id = ?', fromAssignmentId);
    if (!from || from.status !== 'active') {
      throw conflict('ASSIGNMENT_RELEASED', '原班次已不在发起人名下，换班失败');
    }

    // 1) 复检约束
    const problems = [];
    if (swap.type === SWAP_TYPE.EXCHANGE) {
      const target = db.get('SELECT * FROM assignments WHERE id = ?', toAssignmentId);
      if (!target || target.status !== 'active') {
        throw conflict('ASSIGNMENT_RELEASED', '目标班次已不在对方名下，换班失败');
      }
      problems.push(
        ...precheckTransfer({ period, assignment: target, toUserId: swap.requester_id, excludeAssignmentId: from.id })
      );
      problems.push(
        ...precheckTransfer({ period, assignment: from, toUserId: swap.to_user_id, excludeAssignmentId: target.id })
      );
    } else {
      problems.push(...precheckTransfer({ period, assignment: from, toUserId: swap.to_user_id }));
    }

    if (problems.length) {
      throw conflict('SWAP_CONFLICT', '换班生效时约束校验失败，可能期间已被安排其他班次', {
        problems: problems.map((p) => ({ ...p, label: REASON_LABELS[p.code] || p.message })),
      });
    }

    const runId = from.run_id;
    const now = new Date().toISOString();
    const appliedItems = [];

    // 2) 释放 + 重新插入
    if (swap.type === SWAP_TYPE.EXCHANGE) {
      const target = db.get('SELECT * FROM assignments WHERE id = ?', toAssignmentId);
      scheduleRepo.releaseAssignment(from.id);
      scheduleRepo.releaseAssignment(target.id);

      scheduleRepo.insertSwapAssignment({
        runId,
        periodId: period.id,
        workDate: from.work_date,
        shiftId: from.shift_id,
        workTypeId: from.work_type_id,
        dutyRole: from.duty_role,
        userId: swap.to_user_id,
        source: adminDirect ? 'manual' : 'swap',
      });
      scheduleRepo.insertSwapAssignment({
        runId,
        periodId: period.id,
        workDate: target.work_date,
        shiftId: target.shift_id,
        workTypeId: target.work_type_id,
        dutyRole: target.duty_role,
        userId: swap.requester_id,
        source: adminDirect ? 'manual' : 'swap',
      });
      appliedItems.push({
        assignmentId: from.id,
        action: 'transferred',
        fromUserId: from.user_id,
        toUserId: swap.to_user_id,
        workDate: from.work_date,
        shiftId: from.shift_id,
        workTypeId: from.work_type_id,
      });
      appliedItems.push({
        assignmentId: target.id,
        action: 'transferred',
        fromUserId: target.user_id,
        toUserId: swap.requester_id,
        workDate: target.work_date,
        shiftId: target.shift_id,
        workTypeId: target.work_type_id,
      });
    } else {
      scheduleRepo.releaseAssignment(from.id);
      const newId = scheduleRepo.insertSwapAssignment({
        runId,
        periodId: period.id,
        workDate: from.work_date,
        shiftId: from.shift_id,
        workTypeId: from.work_type_id,
        dutyRole: from.duty_role,
        userId: swap.to_user_id,
        source: adminDirect ? 'manual' : 'swap',
      });
      appliedItems.push({
        assignmentId: from.id,
        newAssignmentId: newId,
        action: 'transferred',
        fromUserId: from.user_id,
        toUserId: swap.to_user_id,
        workDate: from.work_date,
        shiftId: from.shift_id,
        workTypeId: from.work_type_id,
      });
    }

    // 3) 状态与日志（在同一事务内，保证原子）
    if (!adminDirect) db.run(
      `UPDATE swap_requests SET status = 'approved', decided_at = ?, applied_at = ? WHERE id = ?`,
      now,
      now,
      swap.id
    );
    refreshRunMetrics(runId);
    db.run('UPDATE schedule_runs SET revision=revision+1 WHERE id=?', runId);

    db.run(
      `INSERT INTO audit_logs (action, entity_type, entity_id, period_id, actor_id, detail_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      adminDirect ? auditRepo.ACTIONS.ASSIGNMENT_MANUAL : auditRepo.ACTIONS.SWAP_APPLY,
      adminDirect ? 'assignment' : 'swap',
      adminDirect ? from.id : swap.id,
      period.id,
      ctx.user.id,
      JSON.stringify({ type: swap.type, applied: appliedItems, adminDirect, message: swap.message || null }),
      ctx.requestId,
      now
    );

    return { appliedItems, appliedAt: now };
  });

  return result;
}

function refreshRunMetrics(runId) {
  const run = scheduleRepo.findRun(runId);
  const previous = run.metrics_json ? JSON.parse(run.metrics_json) : null;
  if (!previous?.workload?.distribution || !previous.perWorkType) return;
  const employees = previous.workload.distribution.map((u) => ({
    id: u.userId, name: u.name, employeeNo: u.employeeNo, historyTotal: u.historyTotal,
    workTypes: new Map(previous.perWorkType.filter((w) => w.distribution.some((d) => d.userId === u.userId)).map((w) => [w.workTypeId, 1])),
    historyCount: (id) => previous.perWorkType.find((w) => w.workTypeId === id)?.distribution.find((d) => d.userId === u.userId)?.historyCount || 0,
  }));
  const history = require('./scheduleService').loadHistory(periodRepo.findPeriod(run.period_id).start_date);
  for (const e of enrollmentService.getEffectiveEnrollments(run.period_id)) {
    const current = employees.find((u) => u.id === e.userId);
    if (current) e.workTypes.forEach((w) => current.workTypes.set(w.workTypeId, w.priority));
    else employees.push({ id: e.userId, name: e.name, employeeNo: e.employeeNo, historyTotal: history.get(e.userId)?.total || 0, workTypes: new Map(e.workTypes.map((w) => [w.workTypeId, w.priority])), historyCount: (id) => history.get(e.userId)?.byWorkType.get(id) || 0 });
  }
  const workTypes = previous.perWorkType.map((w) => ({ id: w.workTypeId, name: w.workTypeName, color: w.workTypeColor }));
  const active = scheduleRepo.listAssignmentsWithUser(runId).map((a) => ({ userId: a.user_id, workTypeId: a.work_type_id }));
  db.run('UPDATE schedule_runs SET metrics_json=? WHERE id=?', JSON.stringify(computeMetrics({ employees, workTypes, assignments: active })), runId);
}

function reassignByAdmin(payload, ctx) {
  if (!['admin', 'super_admin'].includes(ctx.user.role)) throw forbidden('仅管理员可以直接调配已发布排班');
  const from = scheduleRepo.findAssignment(payload.fromAssignmentId);
  if (!from || from.status !== 'active') throw conflict('ASSIGNMENT_RELEASED', '原排班已变化，请刷新后重试');
  if (!['transfer', 'exchange'].includes(payload.type)) throw badRequest('无效的调配方式');
  const run = scheduleRepo.findRun(from.run_id);
  if (run?.status !== 'published') throw conflict('ASSIGNMENT_RELEASED', '该排班不是当前生效版本，请刷新后重试');
  const period = periodRepo.findPeriod(from.period_id);
  if (!period) throw notFound('排班周期不存在');
  if (period.status !== PERIOD_STATUS.PUBLISHED) throw conflict('PERIOD_LOCKED', '只能直接调配已发布且未归档的周期');
  const user = userRepo.findById(payload.toUserId);
  if (!user || user.status !== 'active' || user.id === from.user_id) throw badRequest('请选择另一名已启用的人员作为接班人');
  if (payload.type === SWAP_TYPE.EXCHANGE) {
    const target = scheduleRepo.findAssignment(payload.toAssignmentId);
    if (!target || target.status !== 'active' || target.user_id !== user.id || target.period_id !== period.id || target.run_id !== from.run_id) throw badRequest('请选择同周期内属于对方的有效班次');
  }
  return { applied: true, ...applySwap({ type: payload.type, from_assignment_id: from.id, to_assignment_id: payload.toAssignmentId || null, to_user_id: user.id, requester_id: from.user_id, message: payload.message }, period, ctx, { adminDirect: true }) };
}

/** 拒绝 */
function reject(swapId, reason, ctx) {
  const swap = swapRepo.findSwap(swapId);
  if (!swap) throw notFound('换班申请不存在');
  if (swap.status !== SWAP_STATUS.PENDING) {
    throw conflict('ALREADY_DECIDED', `该申请已结束（当前状态：${swap.status}）`);
  }
  const mine = swapRepo.listParticipants(swapId).find((p) => p.user_id === ctx.user.id);
  if (!mine) throw forbidden('你不是该换班申请的参与者');
  if (mine.role === SWAP_PARTICIPANT_ROLE.REQUESTER) {
    throw badRequest('发起人不能拒绝自己的申请，请使用撤回');
  }
  if (mine.status !== SWAP_PARTICIPANT_STATUS.PENDING) {
    throw conflict('ALREADY_DECIDED', '你已经处理过该申请');
  }

  db.tx(() => {
    swapRepo.decideParticipant(mine.id, SWAP_PARTICIPANT_STATUS.REJECTED);
    swapRepo.updateSwapStatus(swapId, SWAP_STATUS.REJECTED, { decidedAt: new Date().toISOString() });
  });

  auditRepo.log({
    action: auditRepo.ACTIONS.SWAP_REJECT,
    entityType: 'swap',
    entityId: swapId,
    periodId: swap.period_id,
    actorId: ctx.user.id,
    detail: { reason },
    requestId: ctx.requestId,
  });

  return { status: SWAP_STATUS.REJECTED };
}

/** 撤回（仅发起人、仅 pending） */
function cancel(swapId, ctx) {
  const swap = swapRepo.findSwap(swapId);
  if (!swap) throw notFound('换班申请不存在');
  if (swap.requester_id !== ctx.user.id && !['admin', 'super_admin'].includes(ctx.user.role)) {
    throw forbidden('只有发起人可以撤回');
  }
  if (swap.status !== SWAP_STATUS.PENDING) {
    throw conflict('ALREADY_DECIDED', `该申请已结束（当前状态：${swap.status}）`);
  }

  swapRepo.updateSwapStatus(swapId, SWAP_STATUS.CANCELLED, { decidedAt: new Date().toISOString() });

  auditRepo.log({
    action: auditRepo.ACTIONS.SWAP_CANCEL,
    entityType: 'swap',
    entityId: swapId,
    periodId: swap.period_id,
    actorId: ctx.user.id,
    detail: {},
    requestId: ctx.requestId,
  });

  return { status: SWAP_STATUS.CANCELLED };
}

/** 我的申请 / 待我确认 */
function listSwaps(userId, { scope = 'mine', status = null } = {}) {
  const swaps =
    scope === 'inbox'
      ? swapRepo.listSwapsAwaitingMe(userId)
      : swapRepo.listSwapsByRequester(userId, status);

  return swaps.map((s) => {
    const participants = swapRepo.listParticipants(s.id);
    const mine = participants.find((p) => p.user_id === userId);
    return {
      id: s.id,
      type: s.type,
      status: s.status,
      message: s.message,
      requesterId: s.requester_id,
      requesterName: s.requester_name,
      toUserId: s.to_user_id,
      toUserName: s.to_user_name,
      fromAssign: s.from_work_date
        ? {
            workDate: s.from_work_date,
            shiftName: s.from_shift_name,
            shiftSeq: s.from_seq,
            workTypeName: s.from_work_type_name,
            workTypeColor: s.from_work_type_color,
            dutyRole: s.from_duty_role,
          }
        : null,
      toAssign: s.to_work_date
        ? {
            workDate: s.to_work_date,
            shiftName: s.to_shift_name,
            shiftSeq: s.to_seq,
            workTypeName: s.to_work_type_name,
            workTypeColor: s.to_work_type_color,
            dutyRole: s.to_duty_role,
          }
        : null,
      createdAt: s.created_at,
      decidedAt: s.decided_at,
      appliedAt: s.applied_at,
      myDecision: mine ? mine.status : null,
      canAct: s.status === SWAP_STATUS.PENDING && mine && mine.status === SWAP_PARTICIPANT_STATUS.PENDING,
    };
  });
}

/** 待我确认数量（首页角标） */
function getPendingCount(userId) {
  return db.pluck(
    `SELECT COUNT(*) FROM swap_participants sp
       JOIN swap_requests sr ON sr.id = sp.swap_id
       JOIN periods p ON p.id=sr.period_id AND p.deleted_at IS NULL
      WHERE sp.user_id = ? AND sp.status = 'pending' AND sr.status = 'pending'`,
    userId
  );
}

/** 同周期内可交换的对象：给某条分配列出潜在接收人 */
function listCandidates(assignmentId, viewer) {
  const assignment = scheduleRepo.findAssignment(assignmentId);
  if (!assignment) throw notFound('排班不存在');
  if (assignment.user_id !== viewer.id && !['admin', 'super_admin'].includes(viewer.role)) throw forbidden('只能为自己的班次寻找换班对象');

  const period = periodRepo.findPeriod(assignment.period_id);
  if (!period) throw notFound('排班周期不存在');
  const enrollments = enrollmentService.getEffectiveEnrollments(period.id);

  const candidates = [];
  for (const e of enrollments) {
    if (e.userId === assignment.user_id) continue;
    const problems = precheckTransfer({ period, assignment, toUserId: e.userId });
    const theirAssignments = scheduleRepo.listUserAssignmentsInPeriod(period.id, e.userId);

    candidates.push({
      userId: e.userId,
      name: e.name,
      employeeNo: e.employeeNo,
      canTake: problems.length === 0,
      problems: problems.map((p) => ({ ...p, label: REASON_LABELS[p.code] || p.message })),
      // 可用于 exchange 的班次
      theirAssignments: theirAssignments.map((a) => ({
        id: a.id,
        workDate: a.work_date,
        shiftId: a.shift_id,
        shiftName: a.shift_name,
        shiftSeq: a.shift_seq,
        workTypeId: a.work_type_id,
        workTypeName: a.work_type_name,
        workTypeColor: a.work_type_color,
        dutyRole: a.duty_role,
      })),
    });
  }

  return {
    assignment: {
      id: assignment.id,
      workDate: assignment.work_date,
      shiftId: assignment.shift_id,
      workTypeId: assignment.work_type_id,
      dutyRole: assignment.duty_role,
    },
    candidates: candidates.sort(
      (a, b) => Number(b.canTake) - Number(a.canTake) || a.employeeNo.localeCompare(b.employeeNo)
    ),
  };
}

module.exports = {
  reassignByAdmin,
  createSwap,
  getSwapDetail,
  confirm,
  reject,
  cancel,
  listSwaps,
  getPendingCount,
  listCandidates,
  precheckTransfer,
  buildEmployeeState,
};
