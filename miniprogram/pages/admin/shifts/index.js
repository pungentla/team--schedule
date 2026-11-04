const { request } = require('../../../utils/request');

Page({
  data: { items: [], showForm: false, editing: null, form: { code: '', name: '', startTime: '', endTime: '', seq: 1 } },

  onShow() { this.load(); },

  async load() {
    const items = await request('/api/shifts');
    this.setData({ items });
  },

  openCreate() { this.setData({ showForm: true, editing: null, form: { code: '', name: '', startTime: '', endTime: '', seq: 1 } }); },

  openEdit(e) {
    const it = this.data.items.find((x) => x.id === e.currentTarget.dataset.id);
    this.setData({ showForm: true, editing: it, form: { ...it } });
  },

  closeForm() { this.setData({ showForm: false }); },

  onForm(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }); },

  onTime(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }); },

  async onSave() {
    const { form, editing } = this.data;
    if (!form.name.trim() || !form.startTime || !form.endTime) {
      wx.showToast({ title: '请填写完整', icon: 'none' }); return;
    }
    if (editing) await request(`/api/shifts/${editing.id}`, { method: 'PUT', data: form });
    else await request('/api/shifts', { method: 'POST', data: form });
    this.setData({ showForm: false });
    this.load();
  },

  async toggleActive(e) {
    const it = this.data.items.find((x) => x.id === e.currentTarget.dataset.id);
    await request(`/api/shifts/${it.id}`, { method: 'PUT', data: { active: !it.active } });
    this.load();
  },
});
