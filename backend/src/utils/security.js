'use strict';

/**
 * 密码与 token 工具 —— 只用 Node 内置 crypto，不引 bcrypt 原生依赖。
 * 密码格式：scrypt$N$r$p$saltHex$hashHex
 */

const crypto = require('node:crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keylen,
      { N, r, p, maxmem: 128 * N * r * 2 },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/** 生成密码哈希（同步阻塞实现，便于在 seed/登录流程中直接调用） */
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  // crypto.scryptSync 与异步版本算法一致
  const derived = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** 校验密码，使用 timingSafeEqual 防时序攻击 */
function verifyPasswordSync(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');

  const derived = crypto.scryptSync(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/** 生成随机 token（明文返回给客户端，仅哈希入库） */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** token 存库前的哈希 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 生成邀请码，去掉易混淆字符 O/0/I/1 */
function generateInviteCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** 短 id，用于 requestId */
function shortId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  hashPasswordSync,
  verifyPasswordSync,
  generateToken,
  hashToken,
  generateInviteCode,
  shortId,
  scryptAsync,
};
