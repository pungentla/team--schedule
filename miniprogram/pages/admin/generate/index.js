const { request } = require('../../../utils/request');
const { GRADE_LABELS } = require('../../../utils/constants');

Page({
  data: {
    periodId: null,
    result: null,
    gradeLabel: '',
    seed: 42,
    referenceHistory: true,
    generating: false,
    publishing: false,
    generated: false,
  },

  onLoad(options) {
    this.setData({ periodId: Number(options.periodId) });
  },

  onSeed(e) {
    this.setData({ seed: Number(e.detail.value) || 42 });
  },

  onReferenceHistory(e) {
    this.setData({ referenceHistory: e.detail.value.includes('history') });
  },

  async onGenerate() {
    if (this.data.generating) return;
    this.setData({ generating: true });
    try {
      const result = await request(`/api/schedule/periods/${this.data.periodId}/generate`, {
        method: 'POST',
        data: { seed: this.data.seed, referenceHistory: this.data.referenceHistory },
      });
      this.setData({
        result,
        generated: true,
        gradeLabel: GRADE_LABELS[result.metrics.grade] || result.metrics.grade,
      });
      wx.showToast({ title: '生成完成', icon: 'success' });
    } finally {
      this.setData({ generating: false });
    }
  },

  async onPublish() {
    if (this.data.publishing) return;
    const that = this;
    wx.showModal({
      title: '发布排班？',
      content: `共 ${this.data.result.stats.filled} 个班次，发布后全员可见`,
      async success(res) {
        if (!res.confirm) return;
        that.setData({ publishing: true });
        try {
          await request(`/api/schedule/periods/${that.data.periodId}/publish`, {
            method: 'POST',
            data: {},
          });
          wx.showToast({ title: '已发布', icon: 'success' });
          setTimeout(() => wx.switchTab({ url: '/pages/schedule/index' }), 900);
        } finally {
          that.setData({ publishing: false });
        }
      },
    });
  },

  /** 重新生成换个 seed */
  async onRegenerate() {
    this.setData({ seed: Math.floor(Math.random() * 2147483000) });
    await this.onGenerate();
  },
});
