'use strict';

/**
 * 全局配置：环境变量读取 + 业务枚举 + 算法默认权重。
 * 所有可调的业务参数集中在这里，避免散落在各处。
 */

const path = require('node:path');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: intEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  dbFile: path.resolve(__dirname, '..', process.env.DB_FILE || './data/app.db'),
  sessionTtlDays: intEnv('SESSION_TTL_DAYS', 30),
  defaultSeed: intEnv('SCHEDULE_SEED', 42),
  historyPeriods: intEnv('HISTORY_PERIODS', 6),
  algoVersion: '1.2.0',
  // 排班迭代优化上限与最小改进阈值（保证收敛）
  maxOptimizeRounds: intEnv('MAX_OPTIMIZE_ROUNDS', 30),
  minImprovement: 1.0,

  // 运行环境
  nodeEnv: process.env.NODE_ENV || 'development',
  // 部署在 Nginx 等反向代理后时置为 1，才能拿到真实客户端 IP（限流依赖）
  trustProxy: intEnv('TRUST_PROXY', 0) === 1 ? 1 : false,

  // 限流：生产必需，防密码爆破与刷接口
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== '0',
    // 自动化验收时用此密钥在请求头带 X-Verify-Key 跳过限流，
    // 避免 55 项验收被登录限流误伤。生产环境留空即完全关闭该豁免。
    bypassKey: process.env.RATE_LIMIT_BYPASS_KEY || '',
    globalPerMinute: intEnv('RATE_LIMIT_GLOBAL_PER_MIN', 300),
    loginPerTenMinutes: intEnv('RATE_LIMIT_LOGIN_PER_10MIN', 10),
    // 单 IP 10 分钟内总登录次数上限（防换工号撞库），应显著大于单账号上限
    loginPerTenMinutesByIp: intEnv('RATE_LIMIT_LOGIN_IP_PER_10MIN', 60),
  },
};

/** 角色 */
const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  EMPLOYEE: 'employee',
});

/** 周期状态流转 */
const PERIOD_STATUS = Object.freeze({
  DRAFT: 'draft',
  ENROLLING: 'enrolling',
  SCHEDULING: 'scheduling',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
});

/** 报名状态 */
const ENROLLMENT_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
});

/** 排班运行状态 */
const RUN_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  DISCARDED: 'discarded',
});

/** 排班分配状态 */
const ASSIGNMENT_STATUS = Object.freeze({
  ACTIVE: 'active',
  RELEASED: 'released',
});

/** 分配来源 */
const ASSIGNMENT_SOURCE = Object.freeze({
  ALGO: 'algo',
  MANUAL: 'manual',
  SWAP: 'swap',
});

/** 换班类型与状态 */
const SWAP_TYPE = Object.freeze({
  TRANSFER: 'transfer',
  EXCHANGE: 'exchange',
});

const SWAP_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

/** 参与者角色与状态 */
const SWAP_PARTICIPANT_ROLE = Object.freeze({
  REQUESTER: 'requester',
  RECEIVER: 'receiver',
});

const SWAP_PARTICIPANT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

/**
 * 评分权重 —— 轮转公平是首要目标，权重必须显著高于个人意愿。
 * rot: 60 / (1 + 该工作历史次数 + 本周期已排次数)
 *      → 0次=60, 1次=30, 2次=20（历史+本周期都计入，避免被反复排同一工作）
 * rarity: 岗位稀缺加成 = 12 / sqrt(报名该工作的人数)
 *      → 只有1人报名得 12 分，避免小候选池的岗位被其他工作挤掉
 * pref: 意愿优先级 1/2/3 分别 15/8/0 分
 * 因为 rot 首轮 60 > pref 15，"没做过该工作"的人一定优先于"做过1次且最想做"的人
 * → 轮转优先于偏好
 */
const SCORE_WEIGHTS = Object.freeze({
  base: 100,
  rotation: 60,
  rarity: 12,
  balance: 25,
  preference: { 1: 15, 2: 8, 3: 0 },
  freshness: 4,
  periodLoad: -6,
  weekLoad: -3,
  jitter: 0.999,
});

/** 周期默认约束 */
const PERIOD_DEFAULTS = Object.freeze({
  maxShiftsPerDay: 1,
  maxShiftsPerWeek: 5,
  forbidConsecutive: true,
});

module.exports = {
  config,
  ROLES,
  PERIOD_STATUS,
  ENROLLMENT_STATUS,
  RUN_STATUS,
  ASSIGNMENT_STATUS,
  ASSIGNMENT_SOURCE,
  SWAP_TYPE,
  SWAP_STATUS,
  SWAP_PARTICIPANT_ROLE,
  SWAP_PARTICIPANT_STATUS,
  SCORE_WEIGHTS,
  PERIOD_DEFAULTS,
};
