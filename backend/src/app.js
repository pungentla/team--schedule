'use strict';

/** Express 应用装配 */

const express = require('express');
const { requestId } = require('./middleware/requestId');
const { errorHandler } = require('./middleware/error');
const { createRateLimiter, combine } = require('./middleware/rateLimit');
const routes = require('./routes');
const { config } = require('./config');

function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // 生产环境跑在 Nginx 之后，需信任代理才能拿到真实客户端 IP（限流依赖）
  if (config.trustProxy) {
    app.set('trust proxy', config.trustProxy === true ? 1 : config.trustProxy);
  }

  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);

  // 基础安全响应头（无需 helmet 依赖）
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });

  // 请求日志
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      if (!req.originalUrl.startsWith('/api/health')) {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms [#${req.requestId}]`);
      }
    });
    next();
  });

  // 允许小程序开发者工具 / H5 跨域访问
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id,X-RateLimit-Limit,X-RateLimit-Remaining');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // 全局限流：防止单 IP 刷接口拖垮服务
  if (config.rateLimit.enabled) {
    // 验收豁免：带正确 X-Verify-Key 的请求跳过限流，避免自动化验收被误伤。
    // 密钥为空时不挂载该中间件，生产环境完全不受影响。
    if (config.rateLimit.bypassKey) {
      app.use('/api', (req, res, next) => {
        req.rateLimitBypass = req.get('X-Verify-Key') === config.rateLimit.bypassKey;
        next();
      });
    }

    app.use(
      '/api',
      createRateLimiter({
        windowMs: 60_000,
        max: config.rateLimit.globalPerMinute,
        message: '请求过于频繁，请稍后再试',
      })
    );

    // 登录接口双层限流：
    //   A. 纯 IP 维度 —— 防「换工号撞库」，攻击者换号也绕不过
    //   B. IP + 工号 维度 —— 防「死磕某一个账号」
    const loginByIp = createRateLimiter({
      windowMs: 10 * 60_000,
      max: config.rateLimit.loginPerTenMinutesByIp,
      message: '该网络登录尝试过于频繁，请 10 分钟后再试',
    });

    const loginByAccount = createRateLimiter({
      windowMs: 10 * 60_000,
      max: config.rateLimit.loginPerTenMinutes,
      keyGenerator: (req) => {
        const no = (req.body && req.body.employeeNo) || '';
        return `${req.ip || 'unknown'}|${no}`;
      },
      message: '登录尝试过于频繁，请 10 分钟后再试',
    });

    app.use('/api/auth/login', combine(loginByIp, loginByAccount));
  }

  app.use('/api', routes);

  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.originalUrl}`, requestId: req.requestId },
    });
  });

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
