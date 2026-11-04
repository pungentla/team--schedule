'use strict';

/**
 * 限流中间件测试
 *
 * 不用起 HTTP 服务，直接对中间件做单元测试：
 * 构造假的 req/res，验证计数、超限、豁免、按 key 隔离等行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, combine } = require('../src/middleware/rateLimit');

/** 构造最小可用的 req / res */
function mockReq(overrides = {}) {
  return {
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
    headers: {},
    requestId: 'test-req',
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

/** 执行一次请求，返回 { passed, res } */
function run(limiter, req) {
  const res = mockRes();
  let passed = false;
  limiter(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test('未超限时放行', () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
  for (let i = 1; i <= 3; i++) {
    const { passed } = run(limiter, mockReq());
    assert.equal(passed, true, `第 ${i} 次应放行`);
  }
  limiter.stop();
});

test('超过上限返回 429 且带错误码', () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
  run(limiter, mockReq());
  run(limiter, mockReq());

  const { passed, res } = run(limiter, mockReq());
  assert.equal(passed, false, '第 3 次应被拦截');
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'RATE_LIMITED');
  assert.ok(res.headers['Retry-After'], '应带 Retry-After 头');
  limiter.stop();
});

test('响应头包含剩余次数', () => {
  const limiter = createRateLimiter({ max: 5, windowMs: 60_000 });
  const { res } = run(limiter, mockReq());
  assert.equal(res.headers['X-RateLimit-Limit'], '5');
  assert.equal(res.headers['X-RateLimit-Remaining'], '4');
  limiter.stop();
});

test('不同 key 互不影响', () => {
  const limiter = createRateLimiter({
    max: 1,
    windowMs: 60_000,
    keyGenerator: (req) => req.ip,
  });

  assert.equal(run(limiter, mockReq({ ip: 'a' })).passed, true);
  assert.equal(run(limiter, mockReq({ ip: 'b' })).passed, true, '不同 IP 应独立计数');
  assert.equal(run(limiter, mockReq({ ip: 'a' })).passed, false, '同 IP 第二次应被拒');
  limiter.stop();
});

test('带豁免标记的请求不计数、不拦截', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });

  // 先用正常请求打满
  run(limiter, mockReq());
  assert.equal(run(limiter, mockReq()).passed, false, '正常请求应被拒');

  // 豁免请求应直接放行
  const bypassReq = mockReq({ rateLimitBypass: true });
  for (let i = 0; i < 5; i++) {
    assert.equal(run(limiter, bypassReq).passed, true, '豁免请求应始终放行');
  }
  limiter.stop();
});

test('时间窗口过后计数重置', async () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 100 });

  assert.equal(run(limiter, mockReq()).passed, true);
  assert.equal(run(limiter, mockReq()).passed, false, '窗口内第二次应被拒');

  await new Promise((r) => setTimeout(r, 150));

  assert.equal(run(limiter, mockReq()).passed, true, '窗口过后应重新放行');
  limiter.stop();
});

test('combine：任一限流器超限即拒绝', () => {
  const a = createRateLimiter({ max: 2, windowMs: 60_000 });
  const b = createRateLimiter({ max: 5, windowMs: 60_000 });
  const both = combine(a, b);

  assert.equal(run(both, mockReq()).passed, true, '第 1 次通过');
  assert.equal(run(both, mockReq()).passed, true, '第 2 次通过');
  // a 的上限是 2，第 3 次应被 a 拦下
  const { passed, res } = run(both, mockReq());
  assert.equal(passed, false, '应由更严格的 a 拦截');
  assert.equal(res.statusCode, 429);

  a.stop();
  b.stop();
});

test('combine：都未超限时放行', () => {
  const a = createRateLimiter({ max: 10, windowMs: 60_000 });
  const b = createRateLimiter({ max: 10, windowMs: 60_000 });
  const both = combine(a, b);

  for (let i = 0; i < 5; i++) {
    assert.equal(run(both, mockReq()).passed, true);
  }
  a.stop();
  b.stop();
});

test('登录场景：换工号绕不过 IP 维度限流', () => {
  // 模拟真实配置：单账号 10 次，单 IP 15 次
  const byIp = createRateLimiter({ max: 15, windowMs: 600_000 });
  const byAccount = createRateLimiter({
    max: 10,
    windowMs: 600_000,
    keyGenerator: (req) => `${req.ip}|${req.employeeNo}`,
  });
  const loginLimiter = combine(byIp, byAccount);

  // 攻击者换 16 个不同工号撞库
  let blocked = 0;
  for (let i = 0; i < 16; i++) {
    const { passed } = run(loginLimiter, mockReq({ employeeNo: `emp${i}` }));
    if (!passed) blocked += 1;
  }

  assert.equal(blocked, 1, '第 16 次应被 IP 维度拦下（换工号也躲不过）');
  byIp.stop();
  byAccount.stop();
});

test('登录场景：死磕同一账号会被更快拦下', () => {
  const byIp = createRateLimiter({ max: 100, windowMs: 600_000 });
  const byAccount = createRateLimiter({
    max: 3,
    windowMs: 600_000,
    keyGenerator: (req) => `${req.ip}|${req.employeeNo}`,
  });
  const loginLimiter = combine(byIp, byAccount);

  const same = { employeeNo: 'admin' };
  assert.equal(run(loginLimiter, mockReq(same)).passed, true);
  assert.equal(run(loginLimiter, mockReq(same)).passed, true);
  assert.equal(run(loginLimiter, mockReq(same)).passed, true);
  assert.equal(run(loginLimiter, mockReq(same)).passed, false, '第 4 次应被账号维度拦下');

  byIp.stop();
  byAccount.stop();
});
