'use strict';
const { randomUUID } = require('node:crypto');
const db = require('../db/db');
const harvest = require('./harvestService');
const { requireEnum, requireString } = require('../utils/validate');
const { badRequest, conflict } = require('../utils/errors');
const { newTopic } = require('./systemNoticeService');
const COST = 30;
const disclaimer = '愿望不保证实现，大家可自愿回应。';
const presets = [
  { id: 'hello', icon: '👋', title: '想和大家热情地打招呼', content: '希望大家见到我时，都能和我热情地打个招呼，让一天从温暖开始。' },
  { id: 'encourage', icon: '💛', title: '想收到一句鼓励', content: '希望大家送给我一句鼓励的话，为最近的生活加一点力量。' },
  { id: 'prayer', icon: '🙏', title: '想找人一起祷告', content: '希望有一位伙伴愿意和我一起，为心里的挂念祷告。' },
  { id: 'reading', icon: '📖', title: '想找一位读经伙伴', content: '希望找一位伙伴，一起读一段圣经、聊聊彼此的收获。' },
  { id: 'joy', icon: '🌻', title: '想听大家分享开心的事', content: '希望大家分享最近一件开心的小事，让快乐在这里传递。' },
];
function metadata(user) { harvest.participant(user); return { cost: COST, disclaimer, presets }; }
function present(row, replayed) { return { id: row.id, title: row.title, content: row.content, topicId: row.topic_id, cost: row.cost, balance: harvest.balance(row.user_id), replayed }; }
function create(user, body = {}) {
  harvest.participant(user);
  const requestKey = requireString(body.requestKey, '许愿请求编号', { max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)) throw badRequest('许愿请求编号无效，请重新打开许愿窗口');
  const presetId = requireEnum(body.presetId, '愿望类型', [...presets.map(p => p.id), 'custom']);
  const preset = presets.find(p => p.id === presetId);
  const title = preset ? preset.title : requireString(body.title, '愿望标题', { max: 60 });
  const note = requireString(body.content ?? '', '愿望说明', { min: 0, max: 1000 });
  const content = preset ? `${preset.content}${note ? `\n\n${note}` : ''}` : note || title;
  return db.tx(() => {
    const existing = db.get('SELECT * FROM playground_wishes WHERE user_id=? AND request_key=?', user.id, requestKey);
    if (existing) {
      if (existing.title !== title || existing.content !== content) throw conflict('WISH_ALREADY_SUBMITTED', '这次许愿已经提交，请关闭窗口后查看收获记录');
      return present(existing, true);
    }
    if (harvest.balance(user.id) < COST) throw conflict('HARVEST_NOT_ENOUGH', `禾穗不足，攒满 ${COST} 禾穗再来许愿吧`);
    const id = randomUUID(), createdAt = new Date().toISOString();
    const topic = db.run(`INSERT INTO discussion_topics(author_id,category,title,content,created_at)
      VALUES(?,'chat',?,?,?)`, user.id, `许愿：${title}`, `${content}\n\n—— 来自游乐场 · 消耗 ${COST} 禾穗许愿\n${disclaimer}`, createdAt);
    db.run('INSERT INTO playground_wishes(id,user_id,request_key,title,content,cost,topic_id,created_at) VALUES(?,?,?,?,?,?,?,?)', id, user.id, requestKey, title, content, COST, topic.lastInsertRowid, createdAt);
    newTopic(user.id);
    return present(db.get('SELECT * FROM playground_wishes WHERE id=?', id), false);
  });
}
module.exports = { metadata, create };
