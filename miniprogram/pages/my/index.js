const { request } = require('../../utils/request');
const { getBaseUrl } = require('../../config/env');

Page({
  data: {
    user: null,
    myShifts: [],
    mySwaps: [],
    stats: null,
    baseUrl: '',
  },

  onShow() {
    const app = getApp();
    this.setData({ user: app.globalData.user, baseUrl: getBaseUrl() });
    this.load();
  },

  async load() {
    try {
      const [shifts, swaps, stats] = await Promise.all([
        request('/api/schedule/mine'),
        request('/api/swaps?scope=mine', { silent: true }),
        request('/api/stats/me', { silent: true }),
      ]);
      this.setData({ myShifts: shifts, mySwaps: swaps.slice(0, 5), stats });
    } catch (err) {
      // silent
    }
  },

  goEnroll() {
    request('/api/periods/current', { silent: true })
      .then((p) => {
        if (!p) return;
        if (p.status !== 'enrolling') {
          wx.showToast({ title: '当前周期不在报名阶段', icon: 'none' });
          return;
        }
        wx.navigateTo({ url: `/pages/enroll/index?periodId=${p.id}` });
      })
      .catch(() => {});
  },

  goSwapList() {
    wx.navigateTo({ url: '/pages/swap/list' });
  },

  onLogout() {
    const app = getApp();
    request('/api/auth/logout', { method: 'POST', silent: true }).catch(() => {});
    app.logout();
  },

  copyServer() {
    wx.setClipboardData({ data: this.data.baseUrl });
  },
});
