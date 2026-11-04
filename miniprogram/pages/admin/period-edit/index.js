const { request } = require('../../../utils/request');

Page({
  data: {
    periodId: null,
    matrix: null,
    workTypes: [],
    saving: false,
    dirty: false,
  },

  onLoad(options) {
    this.setData({ periodId: Number(options.periodId) });
    this.load();
  },

  async load() {
    const data = await request(`/api/periods/${this.data.periodId}/requirements`);
    this.setData({ matrix: data, workTypes: data.workTypes });
  },

  /** 编辑某个格子的需求人数 */
  onNeedInput(e) {
    const { di, si, wi } = e.currentTarget.dataset;
    const val = Math.max(0, Math.min(99, Number(e.detail.value) || 0));
    this.setData({
      [`matrix.dates[${di}].shifts[${si}].requirements[${wi}].needCount`]: val,
      dirty: true,
    });
  },

  /** 批量：把某工作类型的所有格子设为同一个人数 */
  async fillColumn(e) {
    const wtId = Number(e.currentTarget.dataset.id);
    const that = this;
    wx.showActionSheet({
      itemList: ['全部设为 0', '全部设为 1', '全部设为 2', '全部设为 3'],
      success(res) {
        const val = [0, 1, 2, 3][res.tapIndex];
        const matrix = that.data.matrix;
        matrix.dates.forEach((d) =>
          d.shifts.forEach((s) =>
            s.requirements.forEach((r) => {
              if (r.workTypeId === wtId) r.needCount = val;
            })
          )
        );
        that.setData({ matrix, dirty: true });
      },
    });
  },

  async onSave() {
    if (!this.data.dirty || this.data.saving) return;
    const items = [];
    this.data.matrix.dates.forEach((d) =>
      d.shifts.forEach((s) =>
        s.requirements.forEach((r) => {
          items.push({ workDate: d.workDate, shiftId: s.shiftId, workTypeId: r.workTypeId, needCount: r.needCount });
        })
      )
    );
    this.setData({ saving: true });
    try {
      await request(`/api/periods/${this.data.periodId}/requirements`, {
        method: 'PUT',
        data: { items },
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ dirty: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
