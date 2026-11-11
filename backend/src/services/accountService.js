'use strict';

const db = require('../db/db');
const users = require('../repositories/userRepo');
const audit = require('../repositories/auditRepo');
const { hashPasswordSync } = require('../utils/security');
const { requireString, requireEnum, optionalString } = require('../utils/validate');
const { forbidden, notFound, badRequest, conflict } = require('../utils/errors');

function authorize(ctx, target) {
  if (!['admin', 'super_admin'].includes(ctx.user?.role)) throw forbidden('仅管理员可以管理账号');
  if (ctx.user.role !== 'super_admin' && target?.role !== 'employee') throw forbidden('管理员只能管理员工账号');
  if (target?.role === 'super_admin' && target.id !== ctx.user.id) throw forbidden('不能修改其他超级管理员账号');
}

function fields(body, ctx, creating = false) {
  const result = {};
  if (creating || body.employeeNo !== undefined) {
    result.employeeNo = requireString(body.employeeNo, '登录账号', { min: 2, max: 32 });
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(result.employeeNo)) throw badRequest('登录账号只能包含字母、数字、下划线或短横线，长度 2-32');
  }
  if (creating || body.name !== undefined) result.name = requireString(body.name, '姓名', { max: 32 });
  if (creating || body.role !== undefined) {
    result.role = requireEnum(body.role ?? 'employee', '角色', ['admin', 'employee']);
    if (ctx.user.role !== 'super_admin' && result.role !== 'employee') throw forbidden('只有超级管理员可以设置管理员');
  }
  if (body.status !== undefined) result.status = requireEnum(body.status, '状态', ['active', 'disabled']);
  if (body.phone !== undefined) result.phone = optionalString(body.phone, '手机号', { max: 32 });
  return result;
}

function uniqueAccount(employeeNo, id) {
  const existing = users.findByEmployeeNoInsensitive(employeeNo);
  if (existing && existing.id !== id) throw conflict('EMPLOYEE_NO_TAKEN', '该登录账号已被使用');
}
function log(id, detail, ctx) {
  audit.log({ action: audit.ACTIONS.USER_UPDATE, entityType: 'user', entityId: id, actorId: ctx.user.id, detail, requestId: ctx.requestId });
}
function create(body, ctx) {
  authorize(ctx, { role: 'employee' });
  const data = fields(body, ctx, true);
  const password = requireString(body.password, '初始密码', { min: 6, max: 128 });
  return db.tx(() => {
    uniqueAccount(data.employeeNo);
    const id = users.insertUser({ ...data, passwordHash: hashPasswordSync(password) });
    log(id, { ...data, action: 'create_account' }, ctx);
    return users.accountUser(users.findById(id));
  });
}
function update(id, body, ctx) {
  return db.tx(() => {
    const target = users.findById(id);
    if (!target) throw notFound('账号不存在');
    authorize(ctx, target);
    const data = fields(body, ctx);
    if (data.employeeNo) uniqueAccount(data.employeeNo, id);
    if (target.role === 'super_admin' && (data.role !== undefined || data.status === 'disabled')) {
      throw conflict('SUPER_ADMIN_PROTECTED', '超级管理员不能降级或停用，请保留管理入口');
    }
    users.updateUser(id, data);
    if (data.role !== undefined || data.status !== undefined || data.employeeNo !== undefined) users.deleteUserSessions(id);
    log(id, data, ctx);
    return users.accountUser(users.findById(id));
  });
}
function resetPassword(id, newPassword, ctx) {
  return db.tx(() => {
    const target = users.findById(id);
    if (!target) throw notFound('账号不存在');
    authorize(ctx, target);
    const password = requireString(newPassword, '新密码', { min: 6, max: 128 });
    users.updateUser(id, { passwordHash: hashPasswordSync(password) });
    users.deleteUserSessions(id);
    log(id, { action: 'reset_password' }, ctx);
  });
}

module.exports = { create, update, resetPassword };
