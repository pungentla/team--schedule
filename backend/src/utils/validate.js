'use strict';

/** 参数校验小工具 —— 保持轻量，不引第三方校验库 */

const { badRequest } = require('../utils/errors');

function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw badRequest(`${field} 不能为空`);
  if (trimmed.length > max) throw badRequest(`${field} 长度不能超过 ${max} 个字符`);
  return trimmed;
}

function optionalString(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, opts);
}

function requireInt(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n)) throw badRequest(`${field} 必须是整数`);
  if (n < min) throw badRequest(`${field} 不能小于 ${min}`);
  if (n > max) throw badRequest(`${field} 不能大于 ${max}`);
  return n;
}

function optionalInt(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return null;
  return requireInt(value, field, opts);
}

function requireArray(value, field, { min = 0, max = 500 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`${field} 必须是数组`);
  if (value.length < min) throw badRequest(`${field} 至少需要 ${min} 项`);
  if (value.length > max) throw badRequest(`${field} 最多 ${max} 项`);
  return value;
}

function requireEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw badRequest(`${field} 必须是以下之一：${allowed.join(' / ')}`);
  }
  return value;
}

/** 时间 'HH:MM' 或 'HH:MM:SS' */
function requireTime(value, field) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
    throw badRequest(`${field} 必须是 HH:MM 格式的时间`);
  }
  return value.length === 5 ? value : value.slice(0, 5);
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw badRequest(`${field} 必须是布尔值`);
  return value;
}

/** 从 express req 里安全取整数路径参数 */
function intParam(value, field) {
  return requireInt(value, field, { min: 1 });
}

module.exports = {
  requireString,
  optionalString,
  requireInt,
  optionalInt,
  requireArray,
  requireEnum,
  requireTime,
  requireBoolean,
  intParam,
};
