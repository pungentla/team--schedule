'use strict';

/** 统一错误处理 —— 把 AppError 与未知异常都转成 { error: { code, message, details } } */

const { AppError } = require('../utils/errors');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
        requestId: req.requestId,
      },
    });
  }

  // express.json() 的解析错误
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BAD_JSON', message: '请求体不是合法 JSON', requestId: req.requestId },
    });
  }

  // SQLite 约束错误 → 409，避免把 500 抛给前端
  if (err && typeof err.message === 'string' && err.message.includes('constraint failed')) {
    const isUnique = err.message.includes('UNIQUE');
    return res.status(isUnique ? 409 : 400).json({
      error: {
        code: isUnique ? 'CONSTRAINT_UNIQUE' : 'CONSTRAINT_FAILED',
        message: isUnique ? '数据冲突：存在重复记录' : '数据校验失败：违反数据库约束',
        details: err.message,
        requestId: req.requestId,
      },
    });
  }

  console.error(`[error] ${req.requestId} ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      requestId: req.requestId,
    },
  });
}

module.exports = { errorHandler };
