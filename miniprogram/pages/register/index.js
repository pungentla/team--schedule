const { request } = require('../../utils/request');

Page({
  data: {
    employeeNo: '',
    name: '',
    password: '',
    inviteCode: '',
    loading: false,
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async onRegister() {
    const { employeeNo, name, password, inviteCode, loading } = this.data;
    if (loading) return;
    if (!employeeNo.trim() || !name.trim() || !password || !inviteCode.trim()) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }
    if (password.length < 6) {
      wx.showToast({ title: '密码至少 6 位', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const res = await request('/api/auth/register', {
        method: 'POST',
        data: {
          employeeNo: employeeNo.trim(),
          name: name.trim(),
          password,
          inviteCode: inviteCode.trim().toUpperCase(),
        },
        silent: true,
      });
      const app = getApp();
      app.setSession(res.token, res.user);
      wx.showToast({ title: '注册成功', icon: 'success' });
      setTimeout(() => wx.reLaunch({ url: '/pages/home/index' }), 800);
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
