const { getBaseUrl } = require('./config/env');

App({
  globalData: {
    user: null,
    token: null,
    pendingSwapCount: 0,
  },

  onLaunch() {
    const token = wx.getStorageSync('token');
    const user = wx.getStorageSync('user');
    if (token && user) {
      this.globalData.token = token;
      this.globalData.user = user;
      this.refreshMe();
    }
  },

  onShow() {
    if (this.globalData.token) {
      this.refreshPendingCount();
    }
  },

  async refreshMe() {
    const { request } = require('./utils/request');
    try {
      const res = await request('/api/auth/me');
      this.globalData.user = res;
      wx.setStorageSync('user', res);
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') this.logout();
    }
  },

  async refreshPendingCount() {
    const { request } = require('./utils/request');
    try {
      const res = await request('/api/swaps/pending-count');
      this.globalData.pendingSwapCount = res.count || 0;
    } catch (err) {
      // 静默
    }
  },

  setSession(token, user) {
    this.globalData.token = token;
    this.globalData.user = user;
    wx.setStorageSync('token', token);
    wx.setStorageSync('user', user);
  },

  logout() {
    this.globalData.token = null;
    this.globalData.user = null;
    this.globalData.pendingSwapCount = 0;
    wx.removeStorageSync('token');
    wx.removeStorageSync('user');
    wx.reLaunch({ url: '/pages/login/index' });
  },
});
