const { request } = require('../../utils/request');
const { friendlyDate } = require('../../utils/constants');
const roleLabels = { primary: '主负责人', deputy: '副负责人' };

function groupDays(assignments, user) {
  const dates = new Map();
  for (const a of assignments) {
    if (!dates.has(a.workDate)) dates.set(a.workDate, new Map());
    const people = dates.get(a.workDate);
    const id = a.userId ?? user.id;
    if (!people.has(id)) people.set(id, { id, name: a.name || user.name, mine: id === user.id, jobs: [] });
    people.get(id).jobs.push({
      ...a, roleLabel: roleLabels[a.dutyRole],
      peers: (a.coworkers || []).map((p) => [p.name, roleLabels[p.dutyRole]].filter(Boolean).join(' · ')).join('、'),
    });
  }
  return [...dates].map(([date, people]) => ({ date, label: friendlyDate(date), people: [...people.values()] }));
}

Page({
  data: {
    tab: 'mine',
    range: 0,
    ranges: ['未来 7 天', '未来 30 天', '当前周期'],
    myId: null,
    period: null,
    days: [],
    filtered: [],
    workTypes: [],
    workIndex: 0,
    gaps: null,
    run: null,
    dateRange: '',
    error: '',
    loading: true,
  },

  onShow() { this.refresh(); },

  async refresh() {
    const user = getApp().globalData.user;
    if (!user) return;
    const token = this.requestId = (this.requestId || 0) + 1;
    const { tab, range } = this.data;
    const silent = { silent: true };
    this.setData({ myId: user.id, loading: true, error: '', period: null, filtered: [], days: [], gaps: null, run: null, dateRange: '' });
    try {
      if (range === 2) {
        const period = await request('/api/periods/current', silent);
        if (!period || token !== this.requestId) return;
        const data = await request(`/api/schedule/periods/${period.id}?version=published`, silent);
        if (token !== this.requestId) return;
        const filtered = (data.matrix || []).map((day) => ({
          ...day, dateLabel: friendlyDate(day.workDate),
          shifts: day.shifts.map((shift) => ({
            ...shift,
            workTypes: shift.workTypes.filter((w) => tab === 'team' || w.assigned.some((a) => a.userId === user.id)),
          })).filter((shift) => shift.workTypes.length),
        })).filter((day) => day.shifts.length);
        this.setData({ period: data.period, run: data.run, filtered, gaps: tab === 'team' ? data.gaps : null });
        return;
      }

      const [data, workTypes] = await Promise.all([
        request(`/api/schedule/${tab === 'mine' ? 'mine' : 'team'}/recent?days=${range === 0 ? 7 : 30}`, silent),
        tab === 'work' ? request('/api/work-types', silent) : [],
      ]);
      if (token !== this.requestId) return;
      this.recentAssignments = data.assignments;
      this.setData({ dateRange: `${data.startDate} 至 ${data.endDate}` });
      if (tab === 'work') {
        const assignedTypes = new Set(data.assignments.map((a) => a.workTypeId));
        const choices = workTypes.filter((w) => w.active || assignedTypes.has(w.id));
        const selected = choices.findIndex((w) => w.id === this.workId);
        this.setData({ workTypes: choices });
        this.selectWork(Math.max(0, selected));
      } else {
        this.setData({ days: groupDays(data.assignments, user) });
      }
    } catch (err) {
      if (token === this.requestId) this.setData({ error: err.message });
    } finally {
      if (token === this.requestId) this.setData({ loading: false });
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({
      tab,
      range: tab === 'work' && this.data.range === 2 ? 0 : this.data.range,
      ranges: tab === 'work' ? ['未来 7 天', '未来 30 天'] : ['未来 7 天', '未来 30 天', '当前周期'],
    });
    this.refresh();
  },

  onRange(e) {
    this.setData({ range: Number(e.detail.value) });
    this.refresh();
  },

  onWork(e) { this.selectWork(Number(e.detail.value)); },

  selectWork(index) {
    this.workId = this.data.workTypes[index]?.id;
    this.setData({ workIndex: index, days: groupDays(this.recentAssignments.filter((a) => a.workTypeId === this.workId), getApp().globalData.user) });
  },

  /** 点自己的班次 → 发起换班 */
  onTapAssignment(e) {
    const { assignmentId, userId } = e.currentTarget.dataset;
    if (userId !== getApp().globalData.user.id) return;
    wx.navigateTo({ url: `/pages/swap/create?assignmentId=${assignmentId}` });
  },
});
