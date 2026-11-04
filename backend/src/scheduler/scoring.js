'use strict';

/**
 * 评分函数 —— 决定"谁该上这个班"。
 *
 * 核心权衡：轮转公平 > 个人意愿。
 *   rot = 60 / (1 + 该工作类型历史次数)   → 0次=60, 1次=30, 2次=20
 *   pref = 15 / 8 / 0                    → 意愿优先级 1/2/3
 * 因为 60 > 15，一个"没做过该工作但没把它排在首位"的人，
 * 一定排在"做过1次且最想做"的人前面 → 轮转优先于偏好。
 */

const { SCORE_WEIGHTS: W } = require('../config');
const { diffDays } = require('../utils/date');
const { deterministicJitter } = require('../utils/random');

/**
 * 计算员工在某槽位上的得分（越大越优先）
 * @param {EmployeeState} emp
 * @param {object} slot  { workDate, shiftSeq, shiftId, workTypeId }
 * @param {object} ctx   { seed, periodStartDate, refDate, workTypeRarity: Map<workTypeId, Number> }
 */
function scoreEmployee(emp, slot, ctx) {
  const { workDate, shiftId, workTypeId } = slot;

  // 1) 轮转公平（主权重）
  //    h_eff = 历史次数 + 本周期已排次数 —— 必须把本周期已排计入，
  //    否则同一人在本周期会被反复排到同一个工作（因为历史次数不变，rot 恒为最高）。
  const hHist = emp.historyCount(workTypeId);
  const hEff = hHist + emp.assignedCount(workTypeId);
  const rot = W.rotation / (1 + hEff);

  // 1b) 岗位稀缺度：报名人数少的工作类型，"占住一个人"的边际代价更高，
  //     需要额外加成，避免它因为候选池小而被其他工作挤掉。
  //     ctx.workTypeRarity 由 index.js 预先算好（报名该类型的人数）。
  const rarity = ctx.workTypeRarity ? ctx.workTypeRarity.get(workTypeId) || 0 : 0;
  const rareBonus = rarity > 0 ? W.rarity / Math.sqrt(rarity) : 0;

  // 2) 工作量均衡：历史总次数越多，得分越低（除以 4 平滑，避免早期差异过大）
  const bal = W.balance / (1 + emp.historyTotal / 4);

  // 3) 报名意愿优先级
  const priority = emp.workTypes.get(workTypeId) ?? 3;
  const pref = W.preference[priority] ?? 0;

  // 4) 新鲜度：距上次做该工作的天数越久，越该轮到他
  let fresh = 0;
  const lastDate = emp.lastDateByWorkType.get(workTypeId);
  if (lastDate) {
    const days = Math.max(0, diffDays(lastDate, ctx.refDate || workDate));
    fresh = W.freshness / (1 + days);
  } else {
    fresh = W.freshness; // 从没做过 → 满分
  }

  // 5) 本周期已排数量惩罚 → 让同一个人不会在前面被连排
  const load = W.periodLoad * emp.total;

  // 6) 周内均衡惩罚
  const weekLoad = W.weekLoad * emp.weekCount(workDate);

  // 7) 确定性抖动：打破平局，保证可复现
  const jitter = W.jitter * deterministicJitter(ctx.seed, emp.id, workDate, shiftId, workTypeId);

  return W.base + rot + rareBonus + bal + pref + fresh + load + weekLoad + jitter;
}

/**
 * 评分明细（用于 API 返回"为什么排给他"，便于管理员理解算法）
 */
function explainScore(emp, slot, ctx) {
  const { workDate, shiftId, workTypeId } = slot;
  const hHist = emp.historyCount(workTypeId);
  const hEff = hHist + emp.assignedCount(workTypeId);
  const priority = emp.workTypes.get(workTypeId) ?? 3;
  const lastDate = emp.lastDateByWorkType.get(workTypeId);
  const rarity = ctx.workTypeRarity ? ctx.workTypeRarity.get(workTypeId) || 0 : 0;

  return {
    userId: emp.id,
    name: emp.name,
    employeeNo: emp.employeeNo,
    total: Number(scoreEmployee(emp, slot, ctx).toFixed(4)),
    breakdown: {
      rotation: Number((W.rotation / (1 + hEff)).toFixed(2)),
      historyCount: hHist,
      assignedInPeriod: emp.assignedCount(workTypeId),
      rarityBonus: rarity > 0 ? Number((W.rarity / Math.sqrt(rarity)).toFixed(2)) : 0,
      rarityCount: rarity,
      balance: Number((W.balance / (1 + emp.historyTotal / 4)).toFixed(2)),
      historyTotal: emp.historyTotal,
      preference: W.preference[priority] ?? 0,
      priority,
      freshness: lastDate
        ? Number((W.freshness / (1 + Math.max(0, diffDays(lastDate, ctx.refDate || workDate)))).toFixed(2))
        : W.freshness,
      periodLoad: Number((W.periodLoad * emp.total).toFixed(2)),
      totalInPeriod: emp.total,
      weekLoad: Number((W.weekLoad * emp.weekCount(workDate)).toFixed(2)),
      jitterSource: { seed: ctx.seed, userId: emp.id, workDate, shiftId, workTypeId },
    },
  };
}

module.exports = { scoreEmployee, explainScore };
