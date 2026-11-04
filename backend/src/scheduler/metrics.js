'use strict';

/**
 * 公平度指标 —— 量化"轮转是否公平"和"工作量是否均衡"。
 *
 * 展示以「工作类型 × 标准差/极差」为主，比单一综合分更可解释：
 *   rotationStd(w) = 报名了 w 的人之间，被排到 w 的次数的标准差
 *   rotationRange(w) = 最多 - 最少
 *   理想情况：所有人次数相同 → std = 0
 */

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} args
 * @param {Array} employees        EmployeeState[]（算法结束后）
 * @param {Array} workTypes        参与本周期的工作类型 [{ id, name, color }]
 * @param {Array} assignments      最终分配 [{ userId, workTypeId }]
 */
function computeMetrics({ employees, workTypes, assignments }) {
  const countByUser = new Map();
  const countByUserWorkType = new Map();
  for (const a of assignments) {
    countByUser.set(a.userId, (countByUser.get(a.userId) || 0) + 1);
    const k = `${a.userId}|${a.workTypeId}`;
    countByUserWorkType.set(k, (countByUserWorkType.get(k) || 0) + 1);
  }

  const perWorkType = workTypes.map((wt) => {
    // 只统计"报名了该工作类型"的人，否则没报名的人恒为 0，标准差没有意义
    const eligible = employees.filter((e) => e.workTypes.has(wt.id));
    const counts = eligible.map((e) => countByUserWorkType.get(`${e.id}|${wt.id}`) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const max = counts.length ? Math.max(...counts) : 0;
    const min = counts.length ? Math.min(...counts) : 0;
    return {
      workTypeId: wt.id,
      workTypeName: wt.name,
      workTypeColor: wt.color,
      eligibleCount: eligible.length,
      totalAssigned: total,
      avg: round2(mean(counts)),
      std: round2(stddev(counts)),
      range: max - min,
      max,
      min,
      distribution: eligible
        .map((e) => ({
          userId: e.id,
          name: e.name,
          employeeNo: e.employeeNo,
          count: countByUserWorkType.get(`${e.id}|${wt.id}`) || 0,
          historyCount: e.historyCount(wt.id),
        }))
        .sort((a, b) => b.count - a.count || a.employeeNo.localeCompare(b.employeeNo)),
    };
  });

  const workloadCounts = employees.map((e) => countByUser.get(e.id) || 0);
  const avgWorkload = mean(workloadCounts);
  const workloadStd = stddev(workloadCounts);

  // 综合公平分：各工作类型标准差的平均（越大越不公平）
  const avgRotationStd = perWorkType.length
    ? mean(perWorkType.filter((w) => w.eligibleCount > 0).map((w) => w.std))
    : 0;

  return {
    perWorkType,
    workload: {
      avg: round2(avgWorkload),
      std: round2(workloadStd),
      max: workloadCounts.length ? Math.max(...workloadCounts) : 0,
      min: workloadCounts.length ? Math.min(...workloadCounts) : 0,
      range: workloadCounts.length ? Math.max(...workloadCounts) - Math.min(...workloadCounts) : 0,
      distribution: employees
        .map((e) => ({
          userId: e.id,
          name: e.name,
          employeeNo: e.employeeNo,
          assigned: countByUser.get(e.id) || 0,
          historyTotal: e.historyTotal,
        }))
        .sort((a, b) => b.assigned - a.assigned || a.employeeNo.localeCompare(b.employeeNo)),
    },
    // 0 为完美公平；< 1 可视为良好
    fairnessScore: round2(avgRotationStd),
    grade:
      avgRotationStd <= 0.5
        ? 'excellent'
        : avgRotationStd <= 1
          ? 'good'
          : avgRotationStd <= 2
            ? 'fair'
            : 'poor',
  };
}

module.exports = { computeMetrics, stddev, mean };
