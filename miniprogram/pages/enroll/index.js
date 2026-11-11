const { request } = require('../../utils/request');
const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOptions = (openDays, selected = openDays) => [1, 2, 3, 4, 5, 6, 0]
  .filter(day => openDays.includes(day))
  .map(day => ({ value: String(day), label: weekdayNames[day], checked: selected.includes(day) }));

Page({
  data: {
    periodId: null,
    period: null,
    workTypes: [],
    fixedAssignments: [],
    shifts: [],
    dates: [],
    selected: {},       // workTypeId -> true
    priorities: {},     // workTypeId -> 1|2|3
    maxShifts: 6,
    note: '',
    grid: [],           // 可用性网格 [{date, dateLabel, shifts:[{shiftId, shiftName, state}]}]
    unavailDates: {},   // date -> true
    submitting: false,
    existing: null,
    roleOptions: ['请选择负责人角色', '主负责人', '副负责人', '主副皆可'],
  },

  onLoad(options) {
    this.setData({ periodId: Number(options.periodId) });
    this.load();
  },

  async load() {
    try {
      const ctx = await request(`/api/enrollments/context/${this.data.periodId}`);
      const mine = await request(`/api/enrollments/mine/${this.data.periodId}`);

      const selected = {};
      const priorities = {};
      const dutyRoles = {};
      const signupDays = {};
      (mine.workTypes || []).forEach((w) => {
        selected[w.workTypeId] = true;
        priorities[w.workTypeId] = w.priority;
        dutyRoles[w.workTypeId] = w.dutyRole || 'member';
        signupDays[w.workTypeId] = w.weekdays;
      });
      this.workTypesAll = ctx.workTypes;
      this.shiftsAll = ctx.shifts;

      // 可用性标记（allow-list）。空 = 全可用
      const availSet = new Set((mine.availability || []).map((a) => `${a.workDate}|${a.shiftId}`));
      const unavailDates = {};
      (mine.unavailability || []).forEach((u) => { unavailDates[u.workDate] = true; });

      // 构建网格：默认全可用；只有当存在过 allow-list 时才显示原样
      const hasAvail = (mine.availability || []).length > 0;
      const grid = ctx.dates.map((d) => ({
        workDate: d,
        dateLabel: d,
        shifts: ctx.shifts.map((s) => ({
          shiftId: s.id,
          shiftName: s.name,
          // 未设置过 allow-list → 全部可用(1)；设置过 → 按 allow-list
          state: hasAvail ? (availSet.has(`${d}|${s.id}`) ? 1 : 0) : (unavailDates[d] ? 0 : 1),
        })),
      }));

      this.setData({
        period: ctx.period,
        fixedAssignments: (ctx.fixedAssignments || []).map((r) => ({...r, weekdayLabel: ['周日','周一','周二','周三','周四','周五','周六'][r.weekday], roleLabel: { member: '普通成员', primary: '主负责人', deputy: '副负责人' }[r.dutyRole] })),
        workTypes: ctx.workTypes.map((w) => {
          let signupWeekdays;
          if (w.allowWeekdaySelection) {
            signupWeekdays = selected[w.id]
              ? signupDays[w.id]?.filter(day => w.weekdays.includes(day))
              : w.weekdays.length === 1 ? w.weekdays : [];
          }
          return {
            ...w, selected: !!selected[w.id], priority: priorities[w.id] || 0,
            dutyRole: dutyRoles[w.id] || 'member',
            roleIndex: Math.max(0, ['member', 'primary', 'deputy', 'both'].indexOf(dutyRoles[w.id])),
            signupWeekdays: signupWeekdays ?? null, weekdayOptions: weekdayOptions(w.weekdays, signupWeekdays),
          };
        }),
        shifts: ctx.shifts,
        dates: ctx.dates,
        maxShifts: mine.maxShifts ?? 6,
        note: mine.note || '',
        grid,
        unavailDates,
        existing: mine.exists ? mine : null,
      });
    } catch (err) {
      // 周期未开放等
    }
  },

  toggleWt(e) {
    const id = Number(e.currentTarget.dataset.id);
    const workTypes = this.data.workTypes.map((w) => {
      if (w.id !== id) return w;
      if (!w.selected && !w.weekdays.length) return w;
      const next = !w.selected;
      return { ...w, selected: next, priority: next ? (w.priority || w.id && 1) : 0 };
    });
    this.setData({ workTypes });
    this.normalizePriorities();
  },

  setPriority(e) {
    const id = Number(e.currentTarget.dataset.id);
    const p = Number(e.currentTarget.dataset.p);
    const workTypes = this.data.workTypes.map((w) => (w.id === id ? { ...w, priority: p } : w));
    this.setData({ workTypes });
  },

  /** 根据选择顺序自动填 1/2/3 */
  normalizePriorities() {
    const chosen = this.data.workTypes.filter((w) => w.selected);
    const priorities = {};
    chosen.forEach((w, i) => { priorities[w.id] = Math.min(i + 1, 3); });
    const workTypes = this.data.workTypes.map((w) => ({
      ...w,
      priority: w.selected ? (priorities[w.id] || w.priority || 3) : 0,
    }));
    this.setData({ workTypes });
  },

  onMaxShifts(e) {
    this.setData({ maxShifts: Number(e.detail.value) || 0 });
  },

  onRole(e) {
    const id = Number(e.currentTarget.dataset.id);
    const roleIndex = Number(e.detail.value);
    this.setData({ workTypes: this.data.workTypes.map((w) => w.id === id ? { ...w, roleIndex, dutyRole: ['member', 'primary', 'deputy', 'both'][roleIndex] } : w) });
  },

  onSignupWeekdays(e) {
    this.setSignupWeekdays(Number(e.currentTarget.dataset.id), e.detail.value.map(Number));
  },

  setSignupWeekdays(id, signupWeekdays) {
    this.setData({ workTypes: this.data.workTypes.map(w => w.id === id
      ? { ...w, signupWeekdays, weekdayOptions: weekdayOptions(w.weekdays, signupWeekdays) }
      : w) });
  },

  toggleAllSignupWeekdays(e) {
    const id = Number(e.currentTarget.dataset.id);
    const work = this.data.workTypes.find(w => w.id === id);
    const days = (work.signupWeekdays ?? work.weekdays).length === work.weekdays.length ? [] : work.weekdays;
    this.setSignupWeekdays(id, days);
  },

  onNote(e) {
    this.setData({ note: e.detail.value });
  },

  /** 切换可用格：1 可用 → 0 不可用 */
  toggleCell(e) {
    const { di, si } = e.currentTarget.dataset;
    const key = `grid[${di}].shifts[${si}].state`;
    const cur = this.data.grid[di].shifts[si].state;
    this.setData({ [key]: cur === 1 ? 0 : 1 });
  },

  toggleWholeDay(e) {
    const di = e.currentTarget.dataset.di;
    const day = this.data.grid[di];
    const anyAvail = day.shifts.some((s) => s.state === 1);
    const grid = this.data.grid.map((g, i) =>
      i === di ? { ...g, shifts: g.shifts.map((s) => ({ ...s, state: anyAvail ? 0 : 1 })) } : g
    );
    this.setData({ grid });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const chosen = this.data.workTypes.filter((w) => w.selected);
    if (!chosen.length && !this.data.existing?.submittedWorkTypeIds?.length && !this.data.existing?.withdrawnWorkTypeIds?.length && !this.data.fixedAssignments.length) {
      wx.showToast({ title: '请至少选择一种工作类型', icon: 'none' });
      return;
    }
    if (chosen.some((w) => w.requiresRoles && !['primary', 'deputy', 'both'].includes(w.dutyRole))) {
      wx.showToast({ title: '请选择报名的主副负责人角色', icon: 'none' });
      return;
    }
    if (chosen.some(w => !(w.signupWeekdays ?? w.weekdays).length)) {
      wx.showToast({ title: '请为每项工作选择报名星期', icon: 'none' });
      return;
    }

    const existing = this.data.existing;
    const previousIds = existing?.submittedWorkTypeIds || [];
    const removed = previousIds.some(id => !chosen.some(w => w.id === id));
    const narrowed = chosen.some(w => {
      if (!w.signupWeekdays || !previousIds.includes(w.id) && !this.data.fixedAssignments.some(rule => rule.workTypeId === w.id)) return false;
      const oldDays = existing?.status === 'submitted' && existing.workTypes.find(work => work.workTypeId === w.id)?.weekdays;
      return (oldDays || w.weekdays).some(day => !w.signupWeekdays.includes(day));
    });
    if (this.data.period.status === 'published' && (removed || narrowed)) {
      const confirmed = await new Promise((resolve) => wx.showModal({ title: '确认取消部分报名？', content: '明天起，本周期被取消的工作或星期所对应的已发布安排将移除。', success: (res) => resolve(res.confirm), fail: () => resolve(false) }));
      if (!confirmed) return;
    }
    const availability = [];
    const unavailability = [];
    for (const day of this.data.grid) {
      const allBlocked = day.shifts.every((s) => s.state === 0);
      if (allBlocked) {
        unavailability.push({ workDate: day.workDate });
        continue;
      }
      for (const s of day.shifts) {
        if (s.state === 1) availability.push({ workDate: day.workDate, shiftId: s.shiftId });
      }
    }

    this.setData({ submitting: true });
    try {
      const result = await request(`/api/enrollments/${this.data.periodId}`, {
        method: 'POST',
        data: {
          workTypes: chosen.map((w) => ({ workTypeId: w.id, priority: w.priority || 3, dutyRole: w.requiresRoles ? w.dutyRole : 'member', weekdays: w.signupWeekdays })),
          maxShifts: this.data.maxShifts,
          availability,
          unavailability,
          note: this.data.note,
          submit: true,
        },
      });
      wx.showToast({ title: result.scheduleChanges ? `补入${result.scheduleChanges.addedCount}项，移除${result.scheduleChanges.removedCount}项` : '报名成功', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (err) {
      // toast 已由 request 层处理
    } finally {
      this.setData({ submitting: false });
    }
  },
});
