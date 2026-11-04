const { request } = require('../../utils/request');
const { friendlyDate, shortDate } = require('../../utils/constants');

Page({
  data: {
    tab: 'all', // all | mine
    period: null,
    matrix: [],
    filtered: [],
    gaps: null,
    run: null,
    loading: true,
    isAdmin: false,
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    const app = getApp();
    this.setData({ isAdmin: ['admin', 'super_admin'].includes(app.globalData.user.role), loading: true });
    try {
      const period = await request('/api/periods/current');
      if (!period) {
        this.setData({ loading: false, matrix: [], period: null });
        return;
      }
      const data = await request(`/api/schedule/periods/${period.id}`);
      const matrix = (data.matrix || []).map((day) => ({
        ...day,
        dateLabel: friendlyDate(day.workDate),
        shifts: day.shifts.map((s) => ({
          ...s,
          workTypes: s.workTypes.map((w) => ({
            ...w,
            gapLabel: w.gap > 0 ? `缺${w.gap}` : '',
          })),
        })),
      }));
      this.setData({
        period: data.period,
        matrix,
        gaps: data.gaps,
        run: data.run,
      });
      this.applyFilter();
    } catch (err) {
      this.setData({ matrix: [], period: null });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
    this.applyFilter();
  },

  applyFilter() {
    const { tab, matrix } = this.data;
    const app = getApp();
    const myId = app.globalData.user.id;
    if (tab === 'mine') {
      const filtered = matrix
        .map((day) => ({
          ...day,
          shifts: day.shifts
            .map((s) => ({
              ...s,
              workTypes: s.workTypes.filter((w) => w.assigned.some((a) => a.userId === myId)),
            }))
            .filter((s) => s.workTypes.length > 0),
        }))
        .filter((day) => day.shifts.length > 0);
      this.setData({ filtered });
    } else {
      this.setData({ filtered: matrix });
    }
  },

  /** 点自己的班次 → 发起换班 */
  onTapAssignment(e) {
    const { assignmentId, userId } = e.currentTarget.dataset;
    const app = getApp();
    if (userId !== app.globalData.user.id) {
      wx.showToast({ title: '只能对在自己的班次发起换班', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/swap/create?assignmentId=${assignmentId}` });
  },
});
