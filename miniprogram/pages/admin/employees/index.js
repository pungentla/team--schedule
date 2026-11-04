const { request } = require('../../../utils/request');

Page({
  data: { isSuper: false, showAccount: false, accountId: null, accountForm: {}, users: [], invites: [], showInviteForm: false, inviteForm: { maxUses: 20, expiresInDays: 30 } },

  onShow() { this.load(); },

  async load() {
    const [users, invites] = await Promise.all([
      request('/api/admin/users'),
      request('/api/admin/invites'),
    ]);
    const me = getApp().globalData.user;
    this.setData({ users: users.map((u) => ({ ...u, roleLabel: {super_admin: '超级管理员', admin: '管理员', employee: '员工'}[u.role], canEdit: u.role === 'employee' || (me.role === 'super_admin' && (u.role !== 'super_admin' || u.id === me.id)) })), invites, isSuper: me.role === 'super_admin' });
  },

  openInviteForm() { this.setData({ showInviteForm: true }); },
  closeInviteForm() { this.setData({ showInviteForm: false }); },

  onInviteForm(e) { this.setData({ [`inviteForm.${e.currentTarget.dataset.field}`]: Number(e.detail.value) || 1 }); },

  async createInvite() {
    await request('/api/admin/invites', { method: 'POST', data: this.data.inviteForm });
    this.setData({ showInviteForm: false });
    this.load();
  },

  copyInvite(e) {
    const it = this.data.invites.find((x) => x.id === e.currentTarget.dataset.id);
    wx.setClipboardData({ data: it.code });
  },

  async toggleStatus(e) {
    const u = this.data.users.find((x) => x.id === e.currentTarget.dataset.id);
    await request(`/api/admin/users/${u.id}`, {
      method: 'PATCH',
      data: { status: u.status === 'active' ? 'disabled' : 'active' },
    });
    this.load();
  },

  openAccount(e) {
    const id = Number(e.currentTarget.dataset.id) || null;
    const user = this.data.users.find((u) => u.id === id);
    this.setData({ showAccount: true, accountId: id, accountForm: { employeeNo: user?.employeeNo || '', name: user?.name || '', phone: user?.phone || '', role: user?.role || 'employee', password: '' } });
  },
  closeAccount() { this.setData({ showAccount: false, accountForm: {} }); },
  onAccountInput(e) { this.setData({ [`accountForm.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  onAccountRole(e) { this.setData({ 'accountForm.role': e.detail.value ? 'admin' : 'employee' }); },
  async saveAccount() {
    if (this.saving) return;
    const id = this.data.accountId;
    const { password, ...body } = this.data.accountForm;
    if (!body.employeeNo || !body.name || (!id && password.length < 6)) return wx.showToast({ title: '填写账号、姓名及至少6位密码', icon: 'none' });
    if (body.role === 'super_admin') delete body.role;
    this.saving = true;
    try {
      await request(id ? `/api/admin/users/${id}` : '/api/admin/users', { method: id ? 'PATCH' : 'POST', data: id ? body : { ...body, password } });
      this.closeAccount();
      if (id === getApp().globalData.user.id) return getApp().logout();
      await this.load(); wx.showToast({ title: '账号已保存' });
    } finally { this.saving = false; }
  },
  resetPassword(e) {
    const id = Number(e.currentTarget.dataset.id);
    wx.showModal({ title: '重置密码', editable: true, placeholderText: '输入新密码（至少6位）', success: async (res) => {
      if (!res.confirm) return;
      if (!res.content || res.content.trim().length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' });
      await request(`/api/admin/users/${id}/password`, { method: 'POST', data: { newPassword: res.content } });
      if (id === getApp().globalData.user.id) return getApp().logout();
      wx.showToast({ title: '已重置，请重新登录', icon: 'none' });
    } });
  },
});
