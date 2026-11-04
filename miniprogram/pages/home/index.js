const { request } = require('../../utils/request');
const { STATUS_LABELS, periodLabel, friendlyDate } = require('../../utils/constants');

Page({
  data: {
    user: null,
    period: null,
    periodLabel: '',
    statusLabel: '',
    myNextShift: null,
    myShiftsCount: 0,
    pendingSwapCount: 0,
    enrollmentStatus: null,
    loading: true,
    stats: null,
  },

  onShow() {
    this.refresh();
  },

  async refresh() {
    const app = getApp();
    this.setData({ user: app.globalData.user, pendingSwapCount: app.globalData.pendingSwapCount });

    try {
      const period = await request('/api/periods/current');
      this.setData({
        period,
        periodLabel: periodLabel(period),
        statusLabel: STATUS_LABELS[period.status] || period.status,
      });

      const [mine, pending] = await Promise.all([
        request('/api/schedule/mine?upcoming=1'),
        request('/api/swaps/pending-count', { silent: true }),
      ]);

      const upcoming = mine.filter((a) => a.periodId === period.id);
      this.setData({
        myNextShift: upcoming[0] || null,
        myShiftsCount: upcoming.length,
        pendingSwapCount: pending.count,
      });
      app.globalData.pendingSwapCount = pending.count;

      // 已发布 → 拉统计（管理员）
      if (period.status === 'published' && ['admin', 'super_admin'].includes(app.globalData.user.role)) {
        try {
          const dash = await request('/api/schedule/dashboard');
          this.setData({ stats: dash });
        } catch (e) { /* ignore */ }
      }
    } catch (err) {
      // 无周期等情况
      this.setData({ period: null });
    } finally {
      this.setData({ loading: false });
    }
  },

  goEnroll() {
    if (!this.data.period) return;
    wx.navigateTo({ url: `/pages/enroll/index?periodId=${this.data.period.id}` });
  },

  goSchedule() {
    wx.switchTab({ url: '/pages/schedule/index' });
  },

  goSwapList() {
    wx.navigateTo({ url: '/pages/swap/list' });
  },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/dashboard/index' });
  },
});
