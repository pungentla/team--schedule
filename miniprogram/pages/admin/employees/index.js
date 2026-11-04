const { request } = require('../../../utils/request');

Page({
  data: { users: [], invites: [], showInviteForm: false, inviteForm: { maxUses: 20, expiresInDays: 30 } },

  onShow() { this.load(); },

  async load() {
    const [users, invites] = await Promise.all([
      request('/api/admin/users'),
      request('/api/admin/invites'),
    ]);
    this.setData({ users, invites });
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

  async toggleRole(e) {
    const u = this.data.users.find((x) => x.id === e.currentTarget.dataset.id);
    await request(`/api/admin/users/${u.id}`, {
      method: 'PATCH',
      data: { role: u.role === 'admin' ? 'employee' : 'admin' },
    });
    this.load();
  },
});
