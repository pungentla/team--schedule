const { request } = require('../../utils/request');
const { SWAP_STATUS_LABELS, shortDate } = require('../../utils/constants');

Page({
  data: {
    tab: 'inbox', // inbox 待我确认 | mine 我发起的
    inbox: [],
    mine: [],
    loading: true,
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const [inbox, mine] = await Promise.all([
        request('/api/swaps?scope=inbox', { silent: true }),
        request('/api/swaps?scope=mine', { silent: true }),
      ]);
      const fmt = (list) =>
        list.map((s) => ({
          ...s,
          statusLabel: SWAP_STATUS_LABELS[s.status] || s.status,
          dateLabel: s.fromAssign ? shortDate(s.fromAssign.workDate) : '',
        }));
      this.setData({ inbox: fmt(inbox), mine: fmt(mine), loading: false });
      const app = getApp();
      app.globalData.pendingSwapCount = inbox.filter((x) => x.status === 'pending').length;
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/swap/detail?id=${e.currentTarget.dataset.id}` });
  },
});
