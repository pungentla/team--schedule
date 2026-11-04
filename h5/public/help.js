'use strict';
const helpContent = {
  trash: ['周期回收站', '管理员和超级管理员都可以删除周期；仅超级管理员可以恢复。\n删除后排班、报名和换班暂时隐藏，恢复后按原状态重新显示，已发布排班会重新生效。'],
  period: ['排班周期', '选择本次工作、班次和起止日期。只为所选项目带入默认人数和固定名单。\n快捷周期从开始日期计算，包含首尾；月末不足时取最后一天，最长一年。'],
  requirements: ['需求人数', '0 表示不安排。主副工作每班至少 2 人。\n可按月份、工作筛选，切换筛选不会丢失未保存人数。重新按默认规则填充会覆盖手工人数。'],
  participants: ['参与人员', '管理员可直接代报名，无需人员登录，也可开放本人报名。\n固定名单自动参与；固定和本期报名按人员去重。生成时仍检查工作与主副资格、请假和班次上限。'],
  generation: ['生成与发布', '先安排长期固定人员，再从本期报名中补齐其他岗位，同时考虑轮转与工作量。\n生成只创建草稿；检查并发布后，员工排班才会改变。算法不能保证排满所有可行安排。'],
  draft: ['排班草稿', '可替换、移除或补充草稿人员，发布后生效。\n重新生成会覆盖当前草稿及手工调配。需求、报名或配置变化后，需要重新生成再发布。'],
  published: ['生效排班', '这是人员当前使用的排班。直接调班立即生效，无需员工确认。\n发布新草稿会替换本周期生效版本，旧版本保留为历史。'],
  fairness: ['公平度', '轮转分布与工作量用于比较均衡程度。标准差越小，分配越接近。\n固定名单、个人可用时间和主副资格会影响结果。'],
  worktypes: ['工作设置', '工作日决定每周哪些天需要该工作；默认人数用于创建周期或按规则填充。\n区分主副时每班至少 1 主、1 副，总人数可更多。停用项目不进入后续生成。'],
  fixed: ['长期固定人员', '按星期、班次、人员和角色设置；同一天可添加多人。跨周期自动参与，无需重复报名。\n固定名单遵守请假和上限；冲突需在草稿中处理。本次手工调配不改变长期名单。'],
  shifts: ['班次设置', '设置班次起止时间及启停状态。\n班次顺序用于判断同日连续班次；是否禁止连续安排由周期规则决定。'],
  accounts: ['账号权限', '管理员可管理员工账号；超级管理员可管理管理员和员工。\n密码不能查看，只能重置。修改账号、权限或重置密码后，需要重新登录。'],
  enroll: ['我的报名', '选择本周期可承担的工作、意愿和主副角色，再提交报名。保存草稿不进入普通报名候选。\n已有固定安排时，可只提交请假和个人上限；额外勾选工作表示也参与其他日期。'],
  limit: ['个人班次上限', '留空表示不限；0 表示本周期不接班。\n实际安排还遵守周期的每日、每周班次上限。'],
  availability: ['可用时间', '勾选可工作的班次；整天不可用时可填写请假原因。\n切换月份只改变显示，所有月份会一起保存。'],
  swaps: ['换班', '转班：把自己的班次交给同事。互换：交换双方班次。\n员工申请由对方确认；生效前再次检查资格、请假和上限。管理员直接调班立即生效。'],
  proxy: ['管理员代报名', '提交后直接参与本周期生成，无需本人登录；不改变长期固定名单。\n更新已有报名时，以当前所选工作和角色为准，保留原有请假、可用时间、个人上限和备注。审计记录实际操作的管理员。'],
  recent: ['我的近期安排', '默认查看从今天起的 7 天，可切换 30 天或自定义日期。\n只显示本人已发布的安排；同伴为同一生效版本、同一天、同班次、同一工作中的其他已排人员。'],
  calendar: ['月历', '点击日期查看当天完整安排。灰色日期不在本周期内。\n管理员可筛选人员；员工默认查看本人，也可选择全部。'],
};
const helpIcon = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="6" r="1" fill="currentColor"/></svg>';
function helpButton(key) {
  const item = helpContent[key];
  return `<button type="button" class="help-button" data-help="${key}" aria-label="查看${escapeHtml(item[0])}说明" title="${escapeHtml(item[0])}说明">${helpIcon}</button>`;
}
function bindHelpEvents() {
  $$('[data-help]').forEach((button) => { button.innerHTML = helpIcon; });
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-help]');
    if (!trigger) return;
    const item = helpContent[trigger.dataset.help];
    if (!item) return;
    $('#help-title').textContent = item[0]; $('#help-content').textContent = item[1];
    if (!$('#help-dialog').open) $('#help-dialog').showModal();
  });
  $('#btn-help-close').addEventListener('click', () => $('#help-dialog').close());
  $('#help-dialog').addEventListener('click', (event) => {
    const dialog = event.currentTarget, rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
}
