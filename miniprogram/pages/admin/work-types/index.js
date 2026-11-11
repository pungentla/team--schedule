const { request } = require('../../../utils/request');
const DAYS = [1, 2, 3, 4, 5, 6, 0].map((value) => ({ value, label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][value], checked: true }));

Page({
  data: { items: [], shifts: [], employees: [], rules: [], pairs: [], dayNames: ['周日','周一','周二','周三','周四','周五','周六'], roleNames: ['主负责人','副负责人'], editing: null, showForm: false, weekdays: DAYS, form: { code: '', name: '', color: '#4A90D9', sortOrder: 0, defaultNeed: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] } },

  onShow() { this.load(); },

  async load() {
    const [items, shifts, users] = await Promise.all([request('/api/work-types'), request('/api/shifts'), request('/api/admin/users')]);
    this.setData({ items, shifts: shifts.filter((s) => s.active), employees: users.filter((u) => u.status === 'active').map((u) => ({...u, label: `${u.displayName || u.name}（${u.employeeNo}）`})) });
  },

  openCreate() {
    this.setData({ showForm: true, editing: null, weekdays: DAYS, rules: [], pairs: [], form: { code: '', name: '', color: '#4A90D9', sortOrder: 0, defaultNeed: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  },

  openEdit(e) {
    const it = this.data.items.find((x) => x.id === e.currentTarget.dataset.id);
    this.setData({ showForm: true, editing: it, form: { ...it }, weekdays: DAYS.map((d) => ({ ...d, checked: it.weekdays.includes(d.value) })) });
    this.setRules(it.weeklyAssignments || []);
    const groups = new Map();
    for (const { primaryUserId, deputyUserId } of it.dutyPairs || []) {
      if (!groups.has(primaryUserId)) groups.set(primaryUserId, { primaryUserId, deputyUserIds: [] });
      groups.get(primaryUserId).deputyUserIds.push(deputyUserId);
    }
    this.setPairs([...groups.values()]);
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
  setPairs(pairs) {
    const { employees } = this.data;
    this.setData({ pairs: pairs.map(({ primaryUserId, deputyUserIds }) => ({
      primaryUserId, deputyUserIds,
      primaryIndex: employees.findIndex((u) => u.id === primaryUserId),
      deputies: deputyUserIds.map(id => ({ id, label: employees.find(u => u.id === id)?.label || `人员 #${id}（已停用）` })),
      deputyOptions: employees.filter(u => u.id !== primaryUserId && !deputyUserIds.includes(u.id)),
    })) });
  },
  addPair() { this.setPairs([...this.data.pairs, { primaryUserId: null, deputyUserIds: [] }]); },
  removePair(e) { this.setPairs(this.data.pairs.filter((p, i) => i !== Number(e.currentTarget.dataset.index))); },
  onPair(e) {
    const index = Number(e.currentTarget.dataset.index);
    const primaryUserId = this.data.employees[Number(e.detail.value)].id;
    this.setPairs(this.data.pairs.map((p, i) => i === index ? { primaryUserId, deputyUserIds: p.deputyUserIds.filter(id => id !== primaryUserId) } : p));
  },
  addDeputy(e) {
    const index = Number(e.currentTarget.dataset.index);
    const deputy = this.data.pairs[index].deputyOptions[Number(e.detail.value)];
    this.setPairs(this.data.pairs.map((p, i) => i === index ? { ...p, deputyUserIds: [...p.deputyUserIds, deputy.id] } : p));
  },
  removeDeputy(e) {
    const { index, id } = e.currentTarget.dataset;
    this.setPairs(this.data.pairs.map((p, i) => i === Number(index) ? { ...p, deputyUserIds: p.deputyUserIds.filter(deputyId => deputyId !== Number(id)) } : p));
  },
  async onSave() {
    const { form, editing } = this.data;
    if (!form.name.trim()) { wx.showToast({ title: '请填写名称', icon: 'none' }); return; }
    if (form.requiresRoles && this.data.pairs.some(p => !p.primaryUserId || !p.deputyUserIds.length)) {
      wx.showToast({ title: '每组请选择一主和至少一副', icon: 'none' }); return;
    }
    form.dutyPairs = form.requiresRoles ? this.data.pairs.flatMap(({ primaryUserId, deputyUserIds }) =>
      deputyUserIds.map(deputyUserId => ({ primaryUserId, deputyUserId }))) : [];
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
