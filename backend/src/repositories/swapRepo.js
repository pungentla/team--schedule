'use strict';

/** 换班仓储 */

const db = require('../db/db');
const { nowIso } = require('../utils/date');

function insertSwap({ periodId, type, fromAssignmentId, toUserId, toAssignmentId, requesterId, message }) {
  const { lastInsertRowid } = db.run(
    `INSERT INTO swap_requests
       (period_id, type, from_assignment_id, to_user_id, to_assignment_id, requester_id, status, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    periodId,
    type,
    fromAssignmentId,
    toUserId,
    toAssignmentId,
    requesterId,
    message,
    nowIso()
  );
  return lastInsertRowid;
}

/** 带名字的完整视图 */
const SWAP_SELECT = `
  SELECT sr.*,
         ru.name AS requester_name,
         tu.name AS to_user_name,
         fa.work_date AS from_work_date,
         fs.name AS from_shift_name, fs.seq AS from_seq,
         fw.name AS from_work_type_name, fw.color AS from_work_type_color,
         ta.work_date AS to_work_date,
         ts.name AS to_shift_name, ts.seq AS to_seq,
         tw.name AS to_work_type_name, tw.color AS to_work_type_color
    FROM swap_requests sr
    JOIN users ru ON ru.id = sr.requester_id
    JOIN users tu ON tu.id = sr.to_user_id
    LEFT JOIN assignments fa ON fa.id = sr.from_assignment_id
    LEFT JOIN shifts fs ON fs.id = fa.shift_id
    LEFT JOIN work_types fw ON fw.id = fa.work_type_id
    LEFT JOIN assignments ta ON ta.id = sr.to_assignment_id
    LEFT JOIN shifts ts ON ts.id = ta.shift_id
    LEFT JOIN work_types tw ON tw.id = ta.work_type_id
`;

function findSwap(id) {
  return db.get(`${SWAP_SELECT} WHERE sr.id = ?`, id);
}

function findAssignmentDetail(id) {
  return db.get(
    `SELECT a.*, u.name AS user_name, u.employee_no,
            s.name AS shift_name, s.seq, s.start_time, s.end_time,
            wt.name AS work_type_name, wt.color AS work_type_color
       FROM assignments a
       JOIN users u ON u.id = a.user_id
       JOIN shifts s ON s.id = a.shift_id
       JOIN work_types wt ON wt.id = a.work_type_id
      WHERE a.id = ?`,
    id
  );
}

function findPendingByAssignment(assignmentId) {
  return db.get(
    `SELECT * FROM swap_requests
      WHERE status = 'pending' AND (from_assignment_id = ? OR to_assignment_id = ?)`,
    assignmentId,
    assignmentId
  );
}

function listSwapsByRequester(userId, status = null) {
  if (status) {
    return db.all(`${SWAP_SELECT} WHERE sr.requester_id = ? AND sr.status = ? ORDER BY sr.id DESC`, userId, status);
  }
  return db.all(`${SWAP_SELECT} WHERE sr.requester_id = ? ORDER BY sr.id DESC`, userId);
}

/** 待我确认：我是 participant 且 pending，swap 也还 pending */
function listSwapsAwaitingMe(userId) {
  return db.all(
    `${SWAP_SELECT}
      WHERE sr.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM swap_participants sp
           WHERE sp.swap_id = sr.id AND sp.user_id = ? AND sp.status = 'pending'
        )
      ORDER BY sr.id DESC`,
    userId
  );
}

function listSwapsByPeriod(periodId, status = null) {
  if (status) {
    return db.all(`${SWAP_SELECT} WHERE sr.period_id = ? AND sr.status = ? ORDER BY sr.id DESC`, periodId, status);
  }
  return db.all(`${SWAP_SELECT} WHERE sr.period_id = ? ORDER BY sr.id DESC`, periodId);
}

function updateSwapStatus(id, status, { decidedAt = null } = {}) {
  if (decidedAt) {
    db.run('UPDATE swap_requests SET status = ?, decided_at = ? WHERE id = ?', status, decidedAt, id);
  } else {
    db.run('UPDATE swap_requests SET status = ? WHERE id = ?', status, id);
  }
}

// ---------------------------- participants ----------------------------

function insertParticipant(swapId, userId, role, seq, status) {
  db.run(
    `INSERT INTO swap_participants (swap_id, user_id, role, seq, status, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    swapId,
    userId,
    role,
    seq,
    status,
    status === 'approved' || status === 'rejected' ? nowIso() : null
  );
}

function listParticipants(swapId) {
  return db.all(
    `SELECT sp.*, u.name, u.employee_no
       FROM swap_participants sp
       JOIN users u ON u.id = sp.user_id
      WHERE sp.swap_id = ?
      ORDER BY sp.seq ASC, sp.id ASC`,
    swapId
  );
}

function decideParticipant(participantId, status) {
  return db.run(
    `UPDATE swap_participants SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
    status,
    nowIso(),
    participantId
  ).changes;
}

module.exports = {
  insertSwap,
  findSwap,
  findAssignmentDetail,
  findPendingByAssignment,
  listSwapsByRequester,
  listSwapsAwaitingMe,
  listSwapsByPeriod,
  updateSwapStatus,
  insertParticipant,
  listParticipants,
  decideParticipant,
};
