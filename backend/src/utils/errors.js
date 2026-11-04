'use strict';

/**
 * 统一错误类型 —— 路由层只负责抛 AppError，序列化交给 error 中间件。
 * 每个错误都有稳定的业务 code，前端可据此做分支处理。
 */

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = '未登录或登录已过期') => new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = '无权执行该操作') => new AppError(403, 'FORBIDDEN', message);
const notFound = (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message);
const conflict = (code, message, details) => new AppError(409, code, message, details);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
};
