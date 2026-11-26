import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Collapse from 'antd/es/collapse';
import Input from 'antd/es/input';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { personName } from '../shared';

export function UndercoverStage({ room, user, action, busy }) {
  const [text, setText] = useState(''), [targetId, setTargetId] = useState();
  const name = id => { const p = room.players.find(p => p.id === id); return p ? personName(p, user.id) : '已离开成员'; };
  const alive = room.players.filter(p => !p.eliminated), last = room.history.at(-1);
  return <div className="stack undercover-stage">
    <div className="row-between"><h3>第 {room.round} 轮{room.runoff ? ' · 平票加赛' : ''}</h3><Tag>{alive.length} 人在场 · {room.undercoverCount} 名卧底</Tag></div>
    {room.phase === 'identity' && <><p>私密查看自己的词语，记住后确认。{room.players.filter(p => p.acknowledged).length}/{room.players.length} 人已确认。</p><Button type="primary" disabled={busy || room.players.find(p => p.id === user.id)?.acknowledged} onClick={() => action('acknowledge')}>我记住词语了</Button></>}
    {room.phase === 'describe' && <><Alert type={room.speakerId === user.id ? 'success' : 'info'} message={`轮到${name(room.speakerId)}描述`} /><div className="undercover-order"><small className="muted">本轮顺序</small><Space wrap>{room.order.map(id => <Tag key={id} color={id === room.speakerId ? 'blue' : room.spoken.includes(id) ? 'green' : 'default'}>{name(id)}{room.spoken.includes(id) ? ' ✓' : ''}</Tag>)}</Space></div>
      {room.speakerId === user.id && <><Input.TextArea aria-label="我的描述" rows={2} maxLength={120} showCount value={text} onChange={e => setText(e.target.value)} placeholder="用一句话描述，不要直接写出词语" /><p className="muted">可以发送文字，也可以口头描述后直接确认。</p><Button type="primary" disabled={busy} onClick={() => action('speak', { text })}>{text.trim() ? '发送描述' : '我已完成口头描述'}</Button></>}
    </>}
    {room.phase === 'vote' && <><p>请投出你认为词语不同的成员。{alive.filter(p => p.voted).length}/{alive.length} 人已投票，提交后不可更改。</p>
      {room.me.eliminated ? <Alert type="info" message="你已出局，本轮旁观即可，请保守词语秘密。" /> : room.me.vote != null ? <Alert type="success" message={`你已投给${name(room.me.vote)}，等待其他人。`} /> : <><Select aria-label="投票给谁" placeholder="选择你认为的卧底" value={targetId} onChange={setTargetId} options={room.candidates.filter(id => id !== user.id).map(id => ({ value: id, label: name(id) }))} /><Button type="primary" disabled={busy || !targetId} onClick={() => action('votePlayer', { targetId }, `确认投给${name(targetId)}？`)}>提交投票</Button></>}
    </>}
    {room.phase === 'voteResult' && <><Alert type={last.eliminatedId ? 'info' : 'warning'} message={last.eliminatedId ? `${name(last.eliminatedId)}出局` : room.runoff ? '再次平票，本轮无人出局' : '出现平票，最高票成员将再描述一次'} /><Button type="primary" disabled={busy} onClick={() => action('advance')}>{!last.eliminatedId && !room.runoff ? '进入平票加赛' : '下一轮描述'}</Button></>}
    {room.phase === 'finished' && <><Alert showIcon type={room.winner ? 'success' : 'warning'} message={room.winner ? `${room.winner === 'civilian' ? '平民' : '卧底'}获胜` : '本局提前结束'} description={room.reason} />{room.hostId === user.id && <Button type="primary" disabled={busy} onClick={() => action('restart')}>再来一局</Button>}</>}
    <div className="avalon-players">{room.players.map(p => <div key={p.id} className="row-between"><strong>{name(p.id)}</strong><Space wrap>{p.word && <Tag>{p.word}</Tag>}<Tag color={p.role === 'undercover' ? 'purple' : p.role === 'civilian' ? 'blue' : 'default'}>{p.role ? p.role === 'undercover' ? '卧底' : '平民' : '身份保密'}{p.eliminated ? ' · 已出局' : ''}</Tag></Space></div>)}</div>
    {(room.clues.length > 0 || room.history.length > 0) && <Collapse items={[
      { key: 'clues', label: `描述记录 · ${room.clues.length} 条`, children: <div className="undercover-clues">{room.clues.map((clue, i) => <div key={i}><small className="muted">第 {clue.round} 轮{clue.runoff ? '加赛' : ''} · {name(clue.userId)}</small><p>{clue.text}</p></div>)}</div> },
      { key: 'votes', label: `投票记录 · ${room.history.length} 次`, children: <div className="stack">{room.history.map((vote, i) => <div key={i}><strong>第 {vote.round} 轮{vote.runoff ? '加赛' : ''}</strong><Space wrap>{Object.entries(vote.votes).map(([id, target]) => <Tag key={id}>{name(Number(id))} → {name(target)}</Tag>)}</Space></div>)}</div> },
    ]} />}
  </div>;
}
export function UndercoverRules() {
  return <Collapse ghost className="avalon-rules" items={[{ key: 'rules', label: '怎么玩？查看猜词规则', children: <div className="stack"><p>4–6 人有 1 名卧底，7–10 人有 2 名。大多数人拿到同一个词，卧底拿到相近的另一个词；开局只知道自己的词，不知道阵营。</p><p>词组包含圣经人物、地点和物件，由平台原创整理。每人按顺序描述一句，不能直接说出词语；可以文字描述，也可以口头描述后确认。</p><p>所有在场成员秘密投票，不能投自己。最高票唯一则出局并公开阵营；平票者再描述后加赛投票，再平票则无人出局，进入下一轮。</p><p>所有卧底出局，平民胜；在场卧底不少于平民，卧底胜。出局者可旁观，不能继续描述和投票。结束时公开所有人的词语与阵营。</p><p className="muted">当前为平民与卧底的基础版，没有白板角色；不使用第三方词库或图片。</p></div> }]} />;
}
