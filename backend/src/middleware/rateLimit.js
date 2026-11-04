'use strict';

/**
 * 限流中间件 —— 零依赖，内存滑动窗口。
 *
 * 生产环境的真实威胁：
 *   1. 单 IP 暴力破解某个账号  → 需要「IP + 工号」维度限流
 *   2. 单 IP 换着工号撞库      → 需要「纯 IP」维度限流（只按 IP+工号会漏掉）
 *   3. 刷接口拖垮服务          → 需要全局 IP 限流
 *
 * 所以登录接口采用双层限流，两个都过才放行。
 */

function createRateLimiter({ windowMs = 60_000, max = 100, keyGenerator = null, message = '请求过于频繁，请稍后再试' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  // 定期清理过期条目，避免内存无限增长
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (v.resetAt <= now) hits.delete(k);
    }
  }, 60_000);
  if (timer.unref) timer.unref();

  function middleware(req, res, next) {
    // 验收豁免：请求头带了正确密钥则不计入限流
    if (req.rateLimitBypass) return next();

    const key = keyGenerator ? keyGenerator(req) : (req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    const resetSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetSec));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSec));
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message, requestId: req.requestId },
      });
    }
    return next();
  }

  middleware.reset = () => hits.clear();
  middleware.stop = () => clearInterval(timer);
  return middleware;
}

/**
 * 组合多个限流器：任一超限即拒绝。
 * 用于登录接口的「IP 总量」+「IP+账号」双维度保护。
 */
function combine(...limiters) {
  return function combined(req, res, next) {
    let idx = 0;
    const run = (err) => {
      if (err) return next(err);
      if (idx >= limiters.length) return next();
      // 用 res 已被写过状态判断是否被拦截（限流器拦下时已 send）
      const limiter = limiters[idx++];
      limiter(req, res, () => {
        if (res.headersSent) return; // 已被该限流器拒绝
        run();
      });
    };
    run();
  };
}

module.exports = { createRateLimiter, combine };
