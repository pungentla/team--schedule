'use strict';

/**
 * H5 API 客户端 —— 封装 fetch + token 管理 + 统一错误提示。
 * 与后端约定：成功返回 { data }, 失败返回 { error: { code, message } }
 */

const API = (() => {
  const TOKEN_KEY = 'teamshift_token';
  const USER_KEY = 'teamshift_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  /**
   * 统一请求
   * @param {string} path  形如 /periods/current
   * @param {object} opts  { method, body }
   */
  async function request(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError('NETWORK_ERROR', '网络异常，请检查后端服务是否已启动');
    }

    let payload = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      const e = payload && payload.error ? payload.error : {};
      // 登录态失效 → 清会话，回到登录页
      if (res.status === 401) clearSession();
      throw new ApiError(e.code || `HTTP_${res.status}`, e.message || `请求失败(${res.status})`, res.status);
    }

    return payload ? payload.data : null;
  }

  class ApiError extends Error {
    constructor(code, message, status = 0) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    ApiError,
    getToken,
    getUser,
    setSession,
    clearSession,
    request,
    get: (p) => request(p),
    post: (p, body) => request(p, { method: 'POST', body }),
    put: (p, body) => request(p, { method: 'PUT', body }),

    // ---- 具体端点 ----
    login: (employeeNo, password) => request('/auth/login', { method: 'POST', body: { employeeNo, password } }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),

    currentPeriod: () => request('/periods/current'),
    listPeriods: () => request('/periods'),

    schedule: (periodId) => request(`/schedule/periods/${periodId}`),
    generate: (periodId, seed) => request(`/schedule/periods/${periodId}/generate`, { method: 'POST', body: { seed } }),
    publish: (periodId, runId) => request(`/schedule/periods/${periodId}/publish`, { method: 'POST', body: { runId } }),
    dashboard: () => request('/schedule/dashboard'),

    mySwaps: () => request('/swaps?scope=mine'),
    adminSwaps: (periodId) => request(`/admin/swaps?periodId=${periodId}`),

    auditLogs: (pageSize = 15) => request(`/admin/audit-logs?pageSize=${pageSize}`),

    periodStats: (periodId) => request(`/stats/periods/${periodId}`),
  };
})();
