const { request } = require('../../utils/request');
const { getBaseUrl } = require('../../config/env');

function nicknameSettings(user) {
  const next = Date.parse(user?.nicknameNextChangeAt);
  const nicknameLocked = next > Date.now();
  return {
    nicknameLocked,
    nicknameAvailableAt: nicknameLocked ? new Date(next + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '',
  };
}

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
    nicknameOpen: false,
    nicknameSaving: false,
    nicknameError: '',
  },

  onShow() {
    const app = getApp();
    this.setData({ user: app.globalData.user, baseUrl: getBaseUrl(), ...nicknameSettings(app.globalData.user) });
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
        if (!['enrolling', 'scheduling', 'published'].includes(p.status)) {
          wx.showToast({ title: '当前周期不可报名', icon: 'none' });
          return;
        }
        wx.navigateTo({ url: `/pages/enroll/index?periodId=${p.id}` });
      })
      .catch(() => {});
  },

  goSwapList() {
    wx.navigateTo({ url: '/pages/swap/list' });
  },

  toggleNickname() {
    if (this.data.nicknameSaving) return;
    this.setData({ nicknameOpen: !this.data.nicknameOpen, nicknameError: '', ...nicknameSettings(this.data.user) });
  },

  submitNickname(e) {
    const nickname = (e.detail.value.nickname || '').trim();
    if (!nickname) { this.setData({ nicknameError: '请输入花名' }); return; }
    this.saveNickname('/api/auth/me/nickname', { nickname }, '花名已保存');
  },

  toggleNicknameEnabled() {
    const enabled = !this.data.user.nicknameEnabled;
    this.saveNickname('/api/auth/me/nickname/status', { enabled }, enabled ? '花名已启用' : '花名已禁用');
  },

  async saveNickname(path, data, success) {
    if (this.data.nicknameSaving) return;
    const app = getApp();
    const token = app.globalData.token;
    this.setData({ nicknameSaving: true, nicknameError: '' });
    try {
      const user = await request(path, { method: 'PUT', data, silent: true });
      if (app.globalData.token !== token) return;
      app.setSession(token, user);
      this.setData({ user, nicknameOpen: false, ...nicknameSettings(user) });
      wx.showToast({ title: success, icon: 'none' });
    } catch (err) {
      this.setData({ nicknameError: err.message || '保存失败，请重试' });
    } finally {
      this.setData({ nicknameSaving: false });
    }
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
