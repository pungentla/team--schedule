'use strict';

/** 鉴权中间件：解析 Bearer token → 挂载 req.user */

const db = require('../db/db');
const { unauthorized, forbidden } = require('../utils/errors');
const { hashToken } = require('../utils/security');
const { nowIso } = require('../utils/date');

function extractToken(req) {
  const header = req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // 兼容小程序端偶尔用 query 传 token（如下载场景）
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;
  return null;
}

/** 解析当前用户，失败直接 401 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(unauthorized('缺少访问令牌'));

  const tokenHash = hashToken(token);
  const row = db.get(
    `SELECT s.user_id, s.expires_at, u.employee_no, u.name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    tokenHash
  );

  if (!row) return next(unauthorized('令牌无效，请重新登录'));
  if (row.expires_at < nowIso()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return next(unauthorized('登录已过期，请重新登录'));
  }
  if (row.status !== 'active') return next(forbidden('账号已被停用'));

  req.user = {
    id: row.user_id,
    employeeNo: row.employee_no,
    name: row.name,
    role: row.role,
  };
  req.tokenHash = tokenHash;
  return next();
}

/** 可选鉴权：有 token 就解析，没有也放行 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  const row = db.get(
    `SELECT s.user_id, s.expires_at, u.employee_no, u.name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    hashToken(token)
  );
  if (row && row.expires_at >= nowIso() && row.status === 'active') {
    req.user = { id: row.user_id, employeeNo: row.employee_no, name: row.name, role: row.role };
    req.tokenHash = hashToken(token);
  }
  return next();
}

/** 仅管理员 */
function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('该操作仅管理员可执行'));
  return next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, extractToken };
