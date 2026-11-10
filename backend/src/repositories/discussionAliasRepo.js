'use strict';

const { randomInt } = require('node:crypto');
const db = require('../db/db');

const names = [
  '亚伯拉罕', '撒拉', '利百加', '拉结', '约瑟', '米利暗', '约书亚', '迦勒',
  '底波拉', '路得', '拿俄米', '撒母耳', '约拿单', '大卫', '亚比该', '以斯帖',
  '末底改', '尼希米', '但以理', '约拿', '以利亚', '以利沙', '马利亚', '马大',
  '路加', '约翰', '巴拿巴', '提摩太', '百基拉', '吕底亚', '非比', '多加',
];

function ensureAlias(topicId, userId) {
  if (db.pluck('SELECT 1 FROM discussion_aliases WHERE topic_id = ? AND user_id = ?', topicId, userId)) return;
  const usedNames = new Set(db.all('SELECT name FROM discussion_aliases WHERE topic_id = ?', topicId).map(alias => alias.name));
  const unusedNames = names.filter(name => !usedNames.has(name));
  const candidates = unusedNames.length ? unusedNames : names;
  const baseName = candidates[randomInt(candidates.length)];
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName}${suffix}`;
    const { changes } = db.run(`INSERT INTO discussion_aliases (topic_id, user_id, name) VALUES (?, ?, ?)
      ON CONFLICT(topic_id, name) DO NOTHING`, topicId, userId, name);
    if (changes) return;
  }
}

module.exports = { ensureAlias };
