'use strict';

/**
 * H5 API 客户端 —— 封装 fetch + token 管理 + 统一错误提示。
 * 与后端约定：成功返回 { data }, 失败返回 { error: { code, message } }
 */

export const API = (() => {
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
      if (res.status === 401 && token && getToken() === token) {
        clearSession();
        window.dispatchEvent(new Event('teamshift:session-expired'));
      }
      throw new ApiError(e.code || `HTTP_${res.status}`, e.message || `请求失败(${res.status})`, res.status, e.details);
    }

    return payload ? payload.data : null;
  }

  class ApiError extends Error {
    constructor(code, message, status = 0, details = null) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = details;
    }
  }

  return {
    ApiError,
    getToken,
    getUser,
    setSession,
    clearSession,
    request,
    changePassword: (body) => request('/auth/password', { method: 'POST', body }),
    deletePeriod: (id) => request(`/periods/${id}`, { method: 'DELETE' }),
    deletedPeriods: () => request('/periods/deleted'),
    restorePeriod: (id) => request(`/periods/${id}/restore`, { method: 'POST' }),
    get: (p) => request(p),
    post: (p, body) => request(p, { method: 'POST', body }),
    put: (p, body) => request(p, { method: 'PUT', body }),

    // ---- 具体端点 ----
    login: (employeeNo, password) => request('/auth/login', { method: 'POST', body: { employeeNo, password } }),
    logout: (pushEndpoint) => request('/auth/logout', { method: 'POST', body: pushEndpoint ? { pushEndpoint } : undefined }),
    me: () => request('/auth/me'),
    reminderStatus: (endpoint) => request('/reminders/status', { method: 'POST', body: { endpoint } }),
    enableReminder: (subscription) => request('/reminders/subscription', { method: 'PUT', body: subscription }),
    disableReminder: (endpoint) => request('/reminders/subscription', { method: 'DELETE', body: { endpoint } }),
    testReminder: (endpoint) => request('/reminders/test', { method: 'POST', body: { endpoint } }),
    announcement: () => request('/announcements/current'),
    publishAnnouncement: (body) => request('/announcements/current', { method: 'PUT', body }),
    discussionTopics: (page, options) => request(`/discussions?${new URLSearchParams({ page, ...options })}`),
    discussionTopic: id => request(`/discussions/${id}`),
    deleteTopic: id => request(`/discussions/${id}`, { method: 'DELETE' }),
    setTopicLike: (id, liked) => request(`/discussions/${id}/like`, { method: 'PUT', body: { liked } }),
    topicImages: id => request(`/discussions/${id}/images`),
    createTopic: body => request('/discussions', { method: 'POST', body }),
    topicReplies: (id, page) => request(`/discussions/${id}/replies?page=${page}`),
    replyToTopic: (id, content) => request(`/discussions/${id}/replies`, { method: 'POST', body: { content } }),
    deleteTopicReply: (topicId, replyId) => request(`/discussions/${topicId}/replies/${replyId}`, { method: 'DELETE' }),

    currentPeriod: () => request('/periods/current'),
    listPeriods: () => request('/periods'),
    workTypes: () => request('/work-types'),
    updateWorkType: (id, body) => request(`/work-types/${id}`, { method: 'PUT', body }),
    createWorkType: (body) => request('/work-types', { method: 'POST', body }),
    shifts: () => request('/shifts'),
    saveShift: (id, body) => request(id ? `/shifts/${id}` : '/shifts', { method: id ? 'PUT' : 'POST', body }),
    createPeriod: (body) => request('/periods', { method: 'POST', body }),
    periodRange: (startDate, duration) => request(`/periods/range?startDate=${encodeURIComponent(startDate)}&duration=${duration}`),
    updatePeriod: (id, body) => request(`/periods/${id}`, { method: 'PUT', body }),
    generateSlots: (id) => request(`/periods/${id}/slots/generate`, { method: 'POST', body: { defaultNeed: 0 } }),
    periodPreparation: (id) => request(`/periods/${id}/preparation`),
    preparePeriod: (id) => request(`/periods/${id}/prepare`, { method: 'POST', body: {} }),
    requirements: (id) => request(`/periods/${id}/requirements`),
    saveRequirements: (id, items) => request(`/periods/${id}/requirements`, { method: 'PUT', body: { items } }),
    applyWorkRules: (id) => request(`/periods/${id}/requirements/apply-rules`, { method: 'POST', body: {} }),
    enrollContext: (id) => request(`/enrollments/context/${id}`),
    myEnrollment: (id) => request(`/enrollments/mine/${id}`),
    saveEnrollment: (id, body) => request(`/enrollments/${id}`, { method: 'POST', body }),

    schedule: (periodId, version) => request(`/schedule/periods/${periodId}${version ? `?version=${version}` : ''}`),
    generate: (periodId, seed) => request(`/schedule/periods/${periodId}/generate`, { method: 'POST', body: { seed } }),
    publish: (periodId, runId, revision, publishedRunId, publishedRevision) => request(`/schedule/periods/${periodId}/publish`, { method: 'POST', body: { runId, revision, publishedRunId, publishedRevision } }),
    draftCandidates: (id, target) => request(`/schedule/runs/${id}/candidates?${new URLSearchParams(target)}`),
    adjustDraft: (id, body) => request(`/schedule/runs/${id}/adjust`, { method: 'POST', body }),
    adminReassign: (body) => request('/schedule/reassign', { method: 'POST', body }),
    adminEnrollment: (periodId, userId) => request(`/enrollments/${periodId}/users/${userId}`),
    saveAdminEnrollment: (periodId, userId, body) => request(`/enrollments/${periodId}/users/${userId}`, { method: 'POST', body }),
    adminUsers: () => request('/admin/users'),
    saveUser: (id, body) => request(id ? `/admin/users/${id}` : '/admin/users', { method: id ? 'PATCH' : 'POST', body }),
    resetUserPassword: (id, newPassword) => request(`/admin/users/${id}/password`, { method: 'POST', body: { newPassword } }),
    dashboard: () => request('/schedule/dashboard'),

    mySwaps: () => request('/swaps?scope=mine'),
    swapInbox: () => request('/swaps?scope=inbox'),
    recentSchedule: (params, scope = 'mine') => request(`/schedule/${scope === 'mine' ? 'mine' : 'team'}/recent?${new URLSearchParams(params)}`),
    myAssignments: () => request('/schedule/mine?upcoming=1'),
    swapCandidates: (id) => request(`/swaps/candidates/${id}`),
    createSwap: (body) => request('/swaps', { method: 'POST', body }),
    swapDetail: (id) => request(`/swaps/${id}`),
    decideSwap: (id, action, reason) => request(`/swaps/${id}/${action}`, { method: 'POST', body: { reason } }),
    adminSwaps: (periodId) => request(`/admin/swaps?periodId=${periodId}`),

    auditLogs: (pageSize = 15) => request(`/admin/audit-logs?pageSize=${pageSize}`),

    periodStats: (periodId) => request(`/stats/periods/${periodId}`),
  };
})();
