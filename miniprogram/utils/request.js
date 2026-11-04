/**
 * 网络请求封装 —— 统一 base_url、token、错误提示。
 * 业务 code 说明：
 *   UNAUTHORIZED   未登录/token 失效 → 跳转登录
 *   FORBIDDEN      无权限
 *   409 冲突       由调用方自行处理，这里只 toast
 */

const { getBaseUrl } = require('../config/env');

function toast(title) {
  wx.showToast({ title, icon: 'none', duration: 2200 });
}

function rawRequest({ path, method = 'GET', data = null, silent = false }) {
  const app = getApp();
  const token = app && app.globalData ? app.globalData.token : wx.getStorageSync('token');

  return new Promise((resolve, reject) => {
    wx.request({
      url: getBaseUrl() + path,
      method,
      data,
      timeout: 10000,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body.data);
          return;
        }
        const err = {
          status: res.statusCode,
          code: (body.error && body.error.code) || 'UNKNOWN',
          message: (body.error && body.error.message) || `请求失败(${res.statusCode})`,
          details: body.error ? body.error.details : null,
        };
        if (err.code === 'UNAUTHORIZED') {
          if (app) app.logout();
          toast('登录已过期，请重新登录');
        } else if (!silent) {
          toast(err.message);
        }
        reject(err);
      },
      fail(err) {
        const e = { code: 'NETWORK', message: '网络连接失败，请检查服务器地址', details: err };
        if (!silent) toast(e.message);
        reject(e);
      },
    });
  });
}

const request = (path, options = {}) => rawRequest({ path, ...options });
request.get = (path, opts) => rawRequest({ path, method: 'GET', ...opts });
request.post = (path, data, opts) => rawRequest({ path, method: 'POST', data, ...opts });
request.put = (path, data, opts) => rawRequest({ path, method: 'PUT', data, ...opts });
request.patch = (path, data, opts) => rawRequest({ path, method: 'PATCH', data, ...opts });
request.del = (path, opts) => rawRequest({ path, method: 'DELETE', ...opts });

module.exports = { request };
