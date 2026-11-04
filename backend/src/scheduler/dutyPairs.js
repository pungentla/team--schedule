'use strict';

// Every assigned primary/deputy must have at least one configured partner in this cell.
// An incomplete draft may temporarily keep just one role while the administrator edits it.
function pairProblem(pairs, people) {
  if (!pairs?.length) return null;
  const primary = people.filter((a) => a.dutyRole === 'primary');
  const deputy = people.filter((a) => a.dutyRole === 'deputy');
  if (!primary.length || !deputy.length) return null;
  const matches = (a, b) => pairs.some((p) => p.primaryUserId === a.userId && p.deputyUserId === b.userId);
  if (primary.some((a) => !deputy.some((b) => matches(a, b))) || deputy.some((b) => !primary.some((a) => matches(a, b)))) {
    return { code: 'DUTY_PAIR_MISMATCH', message: '主副负责人不在允许的搭档组合中' };
  }
  return null;
}

function validatePairs(slots, assignments) {
  for (const slot of slots) {
    if (!slot.dutyPairs?.length) continue;
    const people = assignments.filter((a) => a.workDate === slot.workDate && a.shiftId === slot.shiftId && a.workTypeId === slot.workTypeId);
    const problem = pairProblem(slot.dutyPairs, people);
    if (problem) return [{ ...problem, workDate: slot.workDate, shiftId: slot.shiftId, workTypeId: slot.workTypeId }];
  }
  return [];
}

module.exports = { pairProblem, validatePairs };
