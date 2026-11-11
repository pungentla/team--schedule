'use strict';

/** 审计日志仓储 + 服务（写在 service 里但只有一条语句，合并到此处便于调用） */

const db = require('../db/db');
const { nowIso } = require('../utils/date');

const ACTIONS = Object.freeze({
  AUTH_REGISTER: 'AUTH_REGISTER',
  AUTH_LOGIN: 'AUTH_LOGIN',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_PASSWORD_CHANGE: 'AUTH_PASSWORD_CHANGE',
  USER_UPDATE: 'USER_UPDATE',
  INVITE_CREATE: 'INVITE_CREATE',
  WORK_TYPE_CREATE: 'WORK_TYPE_CREATE',
  WORK_TYPE_UPDATE: 'WORK_TYPE_UPDATE',
  SHIFT_CREATE: 'SHIFT_CREATE',
  SHIFT_UPDATE: 'SHIFT_UPDATE',
  PERIOD_CREATE: 'PERIOD_CREATE',
  PERIOD_UPDATE: 'PERIOD_UPDATE',
  PERIOD_DELETE: 'PERIOD_DELETE',
  PERIOD_RESTORE: 'PERIOD_RESTORE',
  SLOTS_GENERATE: 'SLOTS_GENERATE',
  REQUIREMENT_UPDATE: 'REQUIREMENT_UPDATE',
  ENROLL_SUBMIT: 'ENROLL_SUBMIT',
  SCHEDULE_GENERATE: 'SCHEDULE_GENERATE',
  SCHEDULE_PUBLISH: 'SCHEDULE_PUBLISH',
  ASSIGNMENT_MANUAL: 'ASSIGNMENT_MANUAL',
  SWAP_CREATE: 'SWAP_CREATE',
  SWAP_CONFIRM: 'SWAP_CONFIRM',
  SWAP_REJECT: 'SWAP_REJECT',
  SWAP_CANCEL: 'SWAP_CANCEL',
  SWAP_APPLY: 'SWAP_APPLY',
  // 换班在生效阶段因冲突整体回滚时记录，便于排查"换班为什么没成功"
  SWAP_APPLY_FAILED: 'SWAP_APPLY_FAILED',
});

/** 写一条审计日志（不抛错，失败只记录日志） */
function log({ action, entityType = null, entityId = null, periodId = null, actorId = null, detail = null, requestId = null }) {
  try {
    db.run(
      `INSERT INTO audit_logs (action, entity_type, entity_id, period_id, actor_id, detail_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      action,
      entityType,
      entityId,
      periodId,
      actorId,
      detail ? JSON.stringify(detail) : null,
      requestId,
      nowIso()
    );
  } catch (err) {
    console.error('[audit] 写入失败', err.message);
  }
}

/** 分页查询 */
function list({ page = 1, pageSize = 50, periodId = null, action = null, actorId = null } = {}) {
  const where = [];
  const params = [];
  if (periodId) {
    where.push('a.period_id = ?');
    params.push(periodId);
  }
  if (action) {
    where.push('a.action = ?');
    params.push(action);
  }
  if (actorId) {
    where.push('a.actor_id = ?');
    params.push(actorId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.pluck(`SELECT COUNT(*) FROM audit_logs a ${whereSql}`, ...params) || 0;
  const rows = db.all(
    `SELECT a.*, u.display_name AS actor_name, u.employee_no AS actor_no
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ${whereSql}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize
  );

  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actionLabel: ACTION_LABELS[r.action] || r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      periodId: r.period_id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorNo: r.actor_no,
      detail: r.detail_json ? safeParse(r.detail_json) : null,
      requestId: r.request_id,
      createdAt: r.created_at,
    })),
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 只从与当前提交对应的最近一条日志读取代报名人。 */
function enrollmentProxyName(enrollment) {
  if (!enrollment.submitted_at) return null;
  const event = db.get(
    `SELECT a.actor_id, a.detail_json, u.display_name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action = ? AND a.entity_type = 'enrollment'
        AND a.period_id = ? AND a.entity_id = ? AND a.created_at >= ?
      ORDER BY a.id DESC
      LIMIT 1`,
    ACTIONS.ENROLL_SUBMIT,
    enrollment.period_id,
    enrollment.id,
    enrollment.submitted_at
  );
  if (!event || event.actor_id === enrollment.user_id) return null;
  const detail = safeParse(event.detail_json);
  return detail?.submittedByAdmin && detail.submitted !== false ? event.actor_name : null;
}

const ACTION_LABELS = {
  AUTH_REGISTER: '注册账号',
  AUTH_LOGIN: '登录',
  AUTH_LOGOUT: '退出登录',
  AUTH_PASSWORD_CHANGE: '本人修改密码',
  USER_UPDATE: '修改员工信息',
  INVITE_CREATE: '生成邀请码',
  WORK_TYPE_CREATE: '新增工作类型',
  WORK_TYPE_UPDATE: '修改工作类型',
  SHIFT_CREATE: '新增班次',
  SHIFT_UPDATE: '修改班次',
  PERIOD_CREATE: '创建周期',
  PERIOD_UPDATE: '修改周期',
  PERIOD_DELETE: '删除周期',
  PERIOD_RESTORE: '恢复周期',
  SLOTS_GENERATE: '生成需求格子',
  REQUIREMENT_UPDATE: '修改需求人数',
  ENROLL_SUBMIT: '提交报名',
  SCHEDULE_GENERATE: '生成排班',
  SCHEDULE_PUBLISH: '发布排班',
  ASSIGNMENT_MANUAL: '手动调整排班',
  SWAP_CREATE: '发起换班',
  SWAP_CONFIRM: '同意换班',
  SWAP_REJECT: '拒绝换班',
  SWAP_CANCEL: '撤回换班',
  SWAP_APPLY: '换班生效',
  SWAP_APPLY_FAILED: '换班生效失败'
};

module.exports = { log, list, enrollmentProxyName, ACTIONS, ACTION_LABELS };
