const { request } = require('../../../utils/request');
const { ACTION_LABELS } = require('../../../utils/constants');

Page({
  data: { items: [], page: 1, hasMore: true, loading: false },

  onShow() { this.load(true); },

  async load(reset = false) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true });
    try {
      const res = await request(`/api/admin/audit-logs?page=${page}&pageSize=30`);
      const items = (reset ? [] : this.data.items).concat(res.items);
      this.setData({
        items,
        page: page + 1,
        hasMore: items.length < res.total,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onReachBottom() {
    if (this.data.hasMore) this.load(false);
  },
});
