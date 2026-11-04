const { request } = require('../../utils/request');
const { getBaseUrl } = require('../../config/env');

Page({
  data: {
    user: null,
    myShifts: [],
    mySwaps: [],
    stats: null,
    baseUrl: '',
    passwordOpen: false,
    passwordSaving: false,
    passwordError: '',
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

  togglePassword() {
    if (this.data.passwordSaving) return;
    this.setData({ passwordOpen: !this.data.passwordOpen, passwordError: '' });
  },

  async changePassword(e) {
    if (this.data.passwordSaving) return;
    const values = e.detail.value;
    const oldPassword = (values.oldPassword || '').trim();
    const newPassword = (values.newPassword || '').trim();
    const confirmation = (values.confirmPassword || '').trim();
    let error = '';
    if (!oldPassword) error = '请输入原密码';
    else if (newPassword.length < 6 || newPassword.length > 128) error = '新密码需为 6–128 位';
    else if (newPassword !== confirmation) error = '两次新密码不一致';
    else if (oldPassword === newPassword) error = '新密码不能与原密码相同';
    if (error) { this.setData({ passwordError: error }); return; }
    this.setData({ passwordSaving: true, passwordError: '' });
    try {
      await request('/api/auth/password', { method: 'POST', data: { oldPassword, newPassword }, silent: true });
      this.setData({ passwordOpen: false });
      getApp().logout();
      wx.showToast({ title: '密码已修改，请重新登录', icon: 'none' });
    } catch (err) { this.setData({ passwordError: err.message || '修改失败，请重试' }); }
    finally { this.setData({ passwordSaving: false }); }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录', content: '确定退出当前账号？', confirmText: '退出',
      success: async (res) => {
        if (!res.confirm) return;
        try { await request('/api/auth/logout', { method: 'POST', silent: true }); }
        catch (err) { /* 本地退出仍可执行 */ }
        getApp().logout();
      },
    });
  },

  copyServer() {
    wx.setClipboardData({ data: this.data.baseUrl });
  },
});
