const { request } = require('../../../utils/request');
const { GRADE_LABELS } = require('../../../utils/constants');

Page({
  data: {
    dash: null,
    gradeLabel: '',
    fillPercent: 0,
    loading: true,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const dash = await request('/api/schedule/dashboard');
      const fillPercent = dash.publishedRun
        ? Math.round(dash.publishedRun.fillRate * 100)
        : 0;
      this.setData({
        dash,
        fillPercent,
        gradeLabel: dash.publishedRun && dash.publishedRun.metrics
          ? GRADE_LABELS[dash.publishedRun.metrics.grade] || dash.publishedRun.metrics.grade
          : '',
        loading: false,
      });
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  goPeriodEdit() {
    if (!this.data.dash || !this.data.dash.currentPeriod) return;
    wx.navigateTo({ url: `/pages/admin/period-edit/index?periodId=${this.data.dash.currentPeriod.id}` });
  },

  goGenerate() {
    if (!this.data.dash || !this.data.dash.currentPeriod) return;
    wx.navigateTo({ url: `/pages/admin/generate/index?periodId=${this.data.dash.currentPeriod.id}` });
  },

  goWorkTypes() { wx.navigateTo({ url: '/pages/admin/work-types/index' }); },
  goShifts() { wx.navigateTo({ url: '/pages/admin/shifts/index' }); },
  goEmployees() { wx.navigateTo({ url: '/pages/admin/employees/index' }); },
  goAudit() { wx.navigateTo({ url: '/pages/admin/audit/index' }); },
});
