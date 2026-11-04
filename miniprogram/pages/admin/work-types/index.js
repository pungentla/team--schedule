const { request } = require('../../../utils/request');

Page({
  data: { items: [], editing: null, showForm: false, form: { code: '', name: '', color: '#4A90D9', sortOrder: 0 } },

  onShow() { this.load(); },

  async load() {
    const items = await request('/api/work-types');
    this.setData({ items });
  },

  openCreate() {
    this.setData({ showForm: true, editing: null, form: { code: '', name: '', color: '#4A90D9', sortOrder: 0 } });
  },

  openEdit(e) {
    const it = this.data.items.find((x) => x.id === e.currentTarget.dataset.id);
    this.setData({ showForm: true, editing: it, form: { ...it } });
  },

  closeForm() { this.setData({ showForm: false }); },

  onForm(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }); },

  async onSave() {
    const { form, editing } = this.data;
    if (!form.name.trim()) { wx.showToast({ title: '请填写名称', icon: 'none' }); return; }
    if (editing) {
      await request(`/api/work-types/${editing.id}`, { method: 'PUT', data: form });
    } else {
      await request('/api/work-types', { method: 'POST', data: form });
    }
    this.setData({ showForm: false });
    this.load();
  },

  async toggleActive(e) {
    const it = this.data.items.find((x) => x.id === e.currentTarget.dataset.id);
    await request(`/api/work-types/${it.id}`, { method: 'PUT', data: { active: !it.active } });
    this.load();
  },
});
