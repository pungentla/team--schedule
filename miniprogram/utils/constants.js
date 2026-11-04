/** 常量与格式化工具 */

const STATUS_LABELS = {
  draft: '草稿',
  enrolling: '报名中',
  scheduling: '排班中',
  published: '已发布',
  archived: '已归档',
};

const SWAP_STATUS_LABELS = {
  pending: '待确认',
  approved: '已生效',
  rejected: '已拒绝',
  cancelled: '已撤回',
  expired: '已过期',
};

const PRIORITY_LABELS = { 1: '最想去', 2: '愿意去', 3: '可以接受' };

const GAP_REASON_LABELS = {
  no_candidate: '无人报名',
  overloaded: '人员已达上限',
  constraint_blocked: '受请假/时段限制',
  no_candidates_left: '人员已被安排其他工作',
};

const GRADE_LABELS = {
  excellent: '优秀',
  good: '良好',
  fair: '一般',
  poor: '较差',
};

const ACTION_LABELS = {
  AUTH_REGISTER: '注册账号',
  AUTH_LOGIN: '登录',
  AUTH_LOGOUT: '退出登录',
  USER_UPDATE: '修改员工',
  INVITE_CREATE: '生成邀请码',
  WORK_TYPE_CREATE: '新增工作类型',
  WORK_TYPE_UPDATE: '修改工作类型',
  SHIFT_CREATE: '新增班次',
  SHIFT_UPDATE: '修改班次',
  PERIOD_CREATE: '创建周期',
  PERIOD_UPDATE: '修改周期',
  SLOTS_GENERATE: '生成需求格子',
  REQUIREMENT_UPDATE: '修改需求人数',
  ENROLL_SUBMIT: '提交报名',
  SCHEDULE_GENERATE: '生成排班',
  SCHEDULE_PUBLISH: '发布排班',
  ASSIGNMENT_MANUAL: '手动调班',
  SWAP_CREATE: '发起换班',
  SWAP_CONFIRM: '同意换班',
  SWAP_REJECT: '拒绝换班',
  SWAP_CANCEL: '撤回换班',
  SWAP_APPLY: '换班生效',
  SWAP_APPLY_FAILED: '换班生效失败',
};

function isBefore(dateStr) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return dateStr < today;
}

/** '2025-01-06' → '1月6日 周一' */
function friendlyDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  const dt = new Date(`${dateStr}T00:00:00`);
  const wd = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()];
  return `${Number(m)}月${Number(d)}日 周${wd}`;
}

/** '2025-01-06' → '01/06' */
function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function periodLabel(p) {
  if (!p) return '';
  return `${p.name}（${shortDate(p.startDate)} ~ ${shortDate(p.endDate)}）`;
}

module.exports = {
  STATUS_LABELS,
  SWAP_STATUS_LABELS,
  PRIORITY_LABELS,
  GAP_REASON_LABELS,
  GRADE_LABELS,
  isBefore,
  friendlyDate,
  shortDate,
  periodLabel,
};
