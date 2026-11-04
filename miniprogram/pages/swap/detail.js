const { request } = require('../../utils/request');
const { SWAP_STATUS_LABELS } = require('../../utils/constants');

Page({
  data: {
    swapId: null,
    detail: null,
    statusLabel: '',
    loading: true,
    acting: false,
  },

  onLoad(options) {
    this.setData({ swapId: Number(options.id) });
  },

  onShow() {
    this.load();
  },

  async load() {
    try {
      const detail = await request(`/api/swaps/${this.data.swapId}`);
      this.setData({
        detail,
        statusLabel: SWAP_STATUS_LABELS[detail.swap.status] || detail.swap.status,
        loading: false,
      });
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  fmtAssign(a, prefix) {
    if (!a) return '';
    return `${prefix}：${a.workDate} ${a.shiftName} ${a.workTypeName}（${a.userName}）`;
  },

  async onConfirm() {
    if (this.data.acting) return;
    const d = this.data.detail;
    if (!d.canConfirm) {
      const text = d.liveProblems.map((p) => p.label).join('；');
      wx.showModal({
        title: '当前无法确认',
        content: text || '状态已变化，请刷新查看',
        showCancel: false,
      });
      return;
    }
    this.setData({ acting: true });
    try {
      const r = await request(`/api/swaps/${this.data.swapId}/confirm`, { method: 'POST', data: {} });
      if (r.applied) {
        wx.showToast({ title: '换班已生效', icon: 'success' });
        const app = getApp();
        app.refreshPendingCount();
        setTimeout(() => wx.navigateBack(), 900);
      } else {
        wx.showToast({ title: '已记录，等待其他人确认', icon: 'none' });
        this.load();
      }
    } catch (err) {
      if (err.details && err.details.problems) {
        wx.showModal({
          title: '生效失败',
          content: err.details.problems.map((p) => p.label).join('；'),
          showCancel: false,
        });
      }
      this.load();
    } finally {
      this.setData({ acting: false });
    }
  },

  async onReject() {
    if (this.data.acting) return;
    const that = this;
    wx.showModal({
      title: '确认拒绝？',
      content: '拒绝后该申请自动结束',
      async success(res) {
        if (!res.confirm) return;
        that.setData({ acting: true });
        try {
          await request(`/api/swaps/${that.data.swapId}/reject`, { method: 'POST', data: { reason: '不同意' } });
          wx.showToast({ title: '已拒绝', icon: 'none' });
          const app = getApp();
          app.refreshPendingCount();
          setTimeout(() => wx.navigateBack(), 900);
        } finally {
          that.setData({ acting: false });
        }
      },
    });
  },

  async onCancel() {
    if (this.data.acting) return;
    const that = this;
    wx.showModal({
      title: '撤回申请？',
      content: '撤回后该申请自动结束',
      async success(res) {
        if (!res.confirm) return;
        that.setData({ acting: true });
        try {
          await request(`/api/swaps/${that.data.swapId}/cancel`, { method: 'POST', data: {} });
          wx.showToast({ title: '已撤回', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 900);
        } finally {
          that.setData({ acting: false });
        }
      },
    });
  },
});
