'use strict';

/**
 * 确定性伪随机数 —— 排班算法必须"同输入 + 同 seed → 同输出"，
 * 因此不能使用 Math.random()，所有 tie-break 抖动都由这里产生。
 */

/** 字符串转 32 位无符号哈希（FNV-1a） */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：小而快的种子化 PRNG */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由 seed + 多个 key 组合出 [0,1) 的确定性抖动值。
 * 同一个 (seed, keys...) 永远返回同一个值 —— 这是算法可复现的基石。
 */
function deterministicJitter(seed, ...keys) {
  const combined = `${seed}|${keys.join('|')}`;
  const rand = mulberry32(hashString(combined));
  return rand();
}

module.exports = { hashString, mulberry32, deterministicJitter };
