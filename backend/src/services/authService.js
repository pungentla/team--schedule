'use strict';

/** 鉴权服务：注册 / 登录 / 退出 */

const crypto = require('node:crypto');
const userRepo = require('../repositories/userRepo');
const auditRepo = require('../repositories/auditRepo');
const { config } = require('../config');
const { hashPasswordSync, verifyPasswordSync, generateToken, hashToken } = require('../utils/security');
const { badRequest, unauthorized, conflict, forbidden } = require('../utils/errors');
const { nowIso } = require('../utils/date');

const EMPLOYEE_NO_RE = /^[A-Za-z0-9_-]{2,32}$/;

function issueSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86400000).toISOString();
  userRepo.createSession({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/**
 * 注册：工号 + 姓名 + 密码 + 邀请码
 * 邀请码消耗放在同一事务里，保证不超用
 */
function register({ employeeNo, name, password, inviteCode, phone }, ctx = {}) {
  const no = String(employeeNo || '').trim();
  if (!EMPLOYEE_NO_RE.test(no)) {
    throw badRequest('工号只能包含字母、数字、下划线或短横线，长度 2-32');
  }
  if (!name || String(name).trim().length < 1) throw badRequest('姓名不能为空');
  if (!password || String(password).length < 6) throw badRequest('密码至少 6 位');

  const invite = userRepo.findInviteByCode(inviteCode);
  if (!invite) throw forbidden('邀请码无效');
  if (invite.expires_at && invite.expires_at < nowIso()) throw forbidden('邀请码已过期');
  if (invite.used_count >= invite.max_uses) throw forbidden('邀请码已用完');

  if (userRepo.findByEmployeeNoInsensitive(no)) {
    throw conflict('EMPLOYEE_NO_TAKEN', '该工号已被注册');
  }

  const passwordHash = hashPasswordSync(String(password));
  const id = userRepo.insertUser({ employeeNo: no, name: String(name).trim(), passwordHash, role: 'employee', phone });

  if (!userRepo.consumeInvite(inviteCode)) {
    throw forbidden('邀请码已被用完');
  }

  auditRepo.log({
    action: auditRepo.ACTIONS.AUTH_REGISTER,
    entityType: 'user',
    entityId: id,
    actorId: id,
    detail: { employeeNo: no, name },
    requestId: ctx.requestId,
  });

  const session = issueSession(id);
  return { user: userRepo.publicUser(userRepo.findById(id)), ...session };
}

/** 登录：工号 + 密码 */
function login({ employeeNo, password }, ctx = {}) {
  const no = String(employeeNo || '').trim();
  if (!no || !password) throw badRequest('请填写工号和密码');

  const user = userRepo.findByEmployeeNoInsensitive(no);
  // 统一提示，避免枚举工号
  if (!user) throw unauthorized('工号或密码错误');
  if (!verifyPasswordSync(String(password), user.password_hash)) {
    throw unauthorized('工号或密码错误');
  }
  if (user.status !== 'active') throw forbidden('账号已被停用，请联系管理员');

  userRepo.deleteExpiredSessions();
  const session = issueSession(user.id);

  auditRepo.log({
    action: auditRepo.ACTIONS.AUTH_LOGIN,
    entityType: 'user',
    entityId: user.id,
    actorId: user.id,
    requestId: ctx.requestId,
  });

  return { user: userRepo.publicUser(user), ...session };
}

function logout(tokenHash, userId, ctx = {}) {
  if (tokenHash) userRepo.deleteSession(tokenHash);
  auditRepo.log({
    action: auditRepo.ACTIONS.AUTH_LOGOUT,
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    requestId: ctx.requestId,
  });
}

/** 修改密码 */
function changePassword(userId, { oldPassword, newPassword }) {
  const user = userRepo.findById(userId);
  if (!user) throw unauthorized();
  if (!verifyPasswordSync(String(oldPassword || ''), user.password_hash)) {
    throw badRequest('原密码错误');
  }
  if (!newPassword || String(newPassword).length < 6) throw badRequest('新密码至少 6 位');
  userRepo.updateUser(userId, { passwordHash: hashPasswordSync(String(newPassword)) });
  // 改密码后踢掉其他会话（保留当前）
  return true;
}

/** 生成邀请码 */
function createInvite({ maxUses = 10, expiresInDays = 30 }, adminId, ctx = {}) {
  const { generateInviteCode } = require('../utils/security');
  let code;
  let attempts = 0;
  do {
    code = generateInviteCode(8);
    attempts += 1;
  } while (userRepo.findInviteByCode(code) && attempts < 20);

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;

  const id = userRepo.createInvite({ code, maxUses, expiresAt, createdBy: adminId });
  auditRepo.log({
    action: auditRepo.ACTIONS.INVITE_CREATE,
    entityType: 'invite',
    entityId: id,
    actorId: adminId,
    detail: { code, maxUses, expiresAt },
    requestId: ctx.requestId,
  });
  return { id, code, maxUses, expiresAt };
}

module.exports = { register, login, logout, changePassword, createInvite, issueSession };
