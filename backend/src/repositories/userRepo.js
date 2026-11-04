'use strict';

/** 用户 / 会话 / 邀请码仓储 */

const db = require('../db/db');
const { nowIso } = require('../utils/date');

// ---------------------------- users ----------------------------

function findById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

function findByEmployeeNo(employeeNo) {
  return db.get('SELECT * FROM users WHERE employee_no = ?', employeeNo);
}

function findByEmployeeNoInsensitive(employeeNo) {
  return db.get('SELECT * FROM users WHERE employee_no = ? COLLATE NOCASE', employeeNo);
}

function insertUser({ employeeNo, name, passwordHash, role = 'employee', phone = null, status = 'active' }) {
  const now = nowIso();
  const { lastInsertRowid } = db.run(
    `INSERT INTO users (employee_no, name, password_hash, role, phone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    employeeNo,
    name,
    passwordHash,
    role,
    phone,
    status,
    now,
    now
  );
  return lastInsertRowid;
}

function updateUser(id, { name, role, status, phone, passwordHash }) {
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push('name = ?');
    params.push(name);
  }
  if (role !== undefined) {
    fields.push('role = ?');
    params.push(role);
  }
  if (status !== undefined) {
    fields.push('status = ?');
    params.push(status);
  }
  if (phone !== undefined) {
    fields.push('phone = ?');
    params.push(phone);
  }
  if (passwordHash !== undefined) {
    fields.push('password_hash = ?');
    params.push(passwordHash);
  }
  if (!fields.length) return 0;
  fields.push('updated_at = ?');
  params.push(nowIso(), id);
  const { changes } = db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params);
  return changes;
}

function listUsers({ keyword = null, includeDisabled = true } = {}) {
  const where = [];
  const params = [];
  if (!includeDisabled) where.push(`status = 'active'`);
  if (keyword) {
    where.push('(name LIKE ? OR employee_no LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.all(
    `SELECT id, employee_no, name, role, phone, status, created_at FROM users ${whereSql}
      ORDER BY role = 'admin' DESC, employee_no ASC`,
    ...params
  );
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    employeeNo: u.employee_no,
    name: u.name,
    role: u.role,
    phone: u.phone ?? null,
    status: u.status,
  };
}

// ---------------------------- sessions ----------------------------

function createSession({ tokenHash, userId, expiresAt }) {
  db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    tokenHash,
    userId,
    nowIso(),
    expiresAt
  );
}

function deleteSession(tokenHash) {
  db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}

function deleteExpiredSessions() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}

function deleteUserSessions(userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// ---------------------------- invites ----------------------------

function findInviteByCode(code) {
  return db.get('SELECT * FROM invites WHERE code = ? COLLATE NOCASE', code);
}

function createInvite({ code, maxUses, expiresAt, createdBy }) {
  const { lastInsertRowid } = db.run(
    `INSERT INTO invites (code, max_uses, used_count, expires_at, created_by, created_at)
     VALUES (?, ?, 0, ?, ?, ?)`,
    code,
    maxUses,
    expiresAt,
    createdBy,
    nowIso()
  );
  return lastInsertRowid;
}

/**
 * 原子消耗一次邀请码。
 * 用 WHERE used_count < max_uses 做条件更新，避免并发超用。
 */
function consumeInvite(code) {
  const { changes } = db.run(
    `UPDATE invites SET used_count = used_count + 1
      WHERE code = ? COLLATE NOCASE AND used_count < max_uses`,
    code
  );
  return changes > 0;
}

function listInvites() {
  return db.all(
    `SELECT i.*, u.name AS created_by_name
       FROM invites i
       LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.id DESC`
  );
}

module.exports = {
  findById,
  findByEmployeeNo,
  findByEmployeeNoInsensitive,
  insertUser,
  updateUser,
  listUsers,
  publicUser,
  createSession,
  deleteSession,
  deleteExpiredSessions,
  deleteUserSessions,
  findInviteByCode,
  createInvite,
  consumeInvite,
  listInvites,
};
