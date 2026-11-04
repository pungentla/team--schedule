const { request } = require('../../utils/request');

Page({
  data: {
    assignmentId: null,
    fromAssignment: null,
    mode: 'transfer', // transfer | exchange
    candidates: [],
    selectedUser: null,
    selectedSwapTarget: null,
    message: '',
    submitting: false,
    loading: true,
  },

  onLoad(options) {
    this.setData({ assignmentId: Number(options.assignmentId) });
    this.load();
  },

  async load() {
    try {
      const data = await request(`/api/swaps/candidates/${this.data.assignmentId}`);
      const fromAssignment = {
        id: data.assignment.id,
        label: `${data.assignment.workDate}`,
      };
      // 补充班次信息：先取当前周期，再读该周期的排班表
      // 注意：/schedule/periods/:periodId 需要真实数字 ID，不能传 'current'
      try {
        const period = await request('/api/periods/current', { silent: true });
        if (period && period.id) {
          const schedule = await request(`/api/schedule/periods/${period.id}`, { silent: true });
          if (schedule && Array.isArray(schedule.assignments)) {
            const a = schedule.assignments.find((x) => x.id === data.assignment.id);
            if (a) {
              fromAssignment.label = `${a.workDate} ${a.shiftName} ${a.workTypeName}${a.dutyRole === 'primary' ? ' · 主负责人' : a.dutyRole === 'deputy' ? ' · 副负责人' : ''}`;
              fromAssignment.workDate = a.workDate;
              fromAssignment.shiftName = a.shiftName;
              fromAssignment.workTypeName = a.workTypeName;
            }
          }
        }
      } catch (e) {
        // 补信息失败不影响主流程，用 assignment 自带字段兜底
      }
      this.setData({
        fromAssignment,
        candidates: data.candidates.map((c) => ({
          ...c,
          problemText: (c.problems || []).map((p) => p.label).join('、'),
        })),
        loading: false,
      });
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  switchMode(e) {
    this.setData({
      mode: e.currentTarget.dataset.mode,
      selectedUser: null,
      selectedSwapTarget: null,
    });
  },

  selectUser(e) {
    const userId = Number(e.currentTarget.dataset.id);
    const c = this.data.candidates.find((x) => x.userId === userId);
    if (this.data.mode === 'transfer' ? !c.canTake : !c.theirAssignments.length) {
      wx.showToast({ title: c.problemText || '对方不能接这个班', icon: 'none' });
      return;
    }
    this.setData({ selectedUser: c, selectedSwapTarget: null });
  },

  selectSwapTarget(e) {
    const id = Number(e.currentTarget.dataset.id);
    const t = this.data.selectedUser.theirAssignments.find((x) => x.id === id);
    this.setData({ selectedSwapTarget: t });
  },

  onMessage(e) {
    this.setData({ message: e.detail.value });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const { mode, selectedUser, selectedSwapTarget, assignmentId, message } = this.data;
    if (!selectedUser) {
      wx.showToast({ title: '请选择接收人', icon: 'none' });
      return;
    }
    if (mode === 'exchange' && !selectedSwapTarget) {
      wx.showToast({ title: '请选择对方的班次', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      const payload = {
        type: mode,
        fromAssignmentId: assignmentId,
        toUserId: selectedUser.userId,
        message,
      };
      if (mode === 'exchange') payload.toAssignmentId = selectedSwapTarget.id;
      await request('/api/swaps', { method: 'POST', data: payload });
      wx.showToast({ title: '已发起，等待对方确认', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/swap/list' }), 900);
    } catch (err) {
      // 409 的 details.problems 展示
      if (err.details && err.details.problems) {
        const text = err.details.problems.map((p) => p.label).join('；');
        wx.showModal({ title: '换班被约束拦截', content: text, showCancel: false });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },
});
