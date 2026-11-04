const { request } = require('../../../utils/request');
const DAYS = [1, 2, 3, 4, 5, 6, 0].map((value) => ({ value, label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][value], checked: true }));

Page({
  data: { items: [], shifts: [], employees: [], rules: [], dayNames: ['周日','周一','周二','周三','周四','周五','周六'], roleNames: ['主负责人','副负责人'], editing: null, showForm: false, weekdays: DAYS, form: { code: '', name: '', color: '#4A90D9', sortOrder: 0, defaultNeed: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] } },

  onShow() { this.load(); },

  async load() {
    const [items, shifts, users] = await Promise.all([request('/api/work-types'), request('/api/shifts'), request('/api/admin/users')]);
    this.setData({ items, shifts: shifts.filter((s) => s.active), employees: users.filter((u) => u.status === 'active').map((u) => ({...u, label: `${u.name}（${u.employeeNo}）`})) });
  },

  openCreate() {
    this.setData({ showForm: true, editing: null, weekdays: DAYS, rules: [], form: { code: '', name: '', color: '#4A90D9', sortOrder: 0, defaultNeed: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  },

  openEdit(e) {
    const it = this.data.items.find((x) => x.id === e.currentTarget.dataset.id);
    this.setData({ showForm: true, editing: it, form: { ...it }, weekdays: DAYS.map((d) => ({ ...d, checked: it.weekdays.includes(d.value) })) });
    this.setRules(it.weeklyAssignments || []);
  },

  closeForm() { this.setData({ showForm: false }); },

  onForm(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
    if (field === 'requiresRoles') this.setRules(this.data.rules.map((r) => ({ ...r, dutyRole: e.detail.value ? 'primary' : 'member' })));
    if (field === 'requiresRoles' && e.detail.value && Number(this.data.form.defaultNeed) === 1) this.setData({ 'form.defaultNeed': 2 });
  },
  onWeekdays(e) {
    const days = e.detail.value.map(Number);
    this.setData({ 'form.weekdays': days, weekdays: DAYS.map((d) => ({ ...d, checked: days.includes(d.value) })) });
  },

  setRules(rules) {
    this.setData({ rules: rules.map((r) => ({ ...r,
      shiftIndex: this.data.shifts.findIndex((s) => s.id === r.shiftId),
      userIndex: this.data.employees.findIndex((u) => u.id === r.userId),
      roleIndex: r.dutyRole === 'deputy' ? 1 : 0,
    })) });
  },
  addRule() { this.setRules([...this.data.rules, { weekday: 1, shiftId: this.data.shifts[0]?.id, userId: this.data.employees[0]?.id, dutyRole: this.data.form.requiresRoles ? 'primary' : 'member' }]); },
  removeRule(e) { this.setRules(this.data.rules.filter((r, i) => i !== Number(e.currentTarget.dataset.index))); },
  onRule(e) {
    const index = Number(e.currentTarget.dataset.index), field = e.currentTarget.dataset.field, value = Number(e.detail.value);
    const rows = this.data.rules.map((r) => ({ ...r }));
    rows[index][field] = field === 'shiftId' ? this.data.shifts[value].id : field === 'userId' ? this.data.employees[value].id : field === 'dutyRole' ? ['primary','deputy'][value] : value;
    this.setRules(rows);
  },
  async onSave() {
    const { form, editing } = this.data;
    if (!form.name.trim()) { wx.showToast({ title: '请填写名称', icon: 'none' }); return; }
    form.weeklyAssignments = this.data.rules.map(({ weekday, shiftId, userId, dutyRole }) => ({ weekday, shiftId, userId, dutyRole }));
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
