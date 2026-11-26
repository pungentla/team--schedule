import React, { useRef, useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Collapse from 'antd/es/collapse';
import Input from 'antd/es/input';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { personName } from '../shared';
const colors = [{ value: '#24344d', label: '墨黑' }, { value: '#3159aa', label: '蓝色' }, { value: '#e05656', label: '红色' }, { value: '#33925c', label: '绿色' }, { value: '#d99826', label: '金色' }];
function Stroke({ stroke }) { const points = stroke.points.length === 1 ? [...stroke.points, stroke.points[0]] : stroke.points; return <polyline points={points.map(([x, y]) => `${x * 700},${y * 400}`).join(' ')} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />; }
export function SketchStage({ room, user, action, busy }) {
  const mine = room.drawerId === user.id, drawing = room.phase === 'drawing';
  const [color, setColor] = useState(colors[0].value), [width, setWidth] = useState(4), [draft, setDraft] = useState(null), [text, setText] = useState('');
  const pointer = useRef(null), points = useRef([]), pending = useRef(false);
  const name = id => { const p = room.players.find(p => p.id === id); return p ? personName(p, user.id) : '已离开成员'; };
  function point(event) { const box = event.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))]; }
  function start(event) {
    if (!mine || !drawing || busy || pending.current || room.strokes.length >= 200 || pointer.current != null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); pointer.current = event.pointerId; points.current = [point(event)]; setDraft({ color, width, points: [...points.current] });
  }
  function move(event) {
    if (pointer.current !== event.pointerId) return;
    event.preventDefault();
    if (points.current.length < 200) { points.current.push(point(event)); setDraft({ color, width, points: [...points.current] }); }
  }
  async function end(event) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null; pending.current = true;
    try { await action('stroke', { color, width, points: [...points.current] }); } finally { pending.current = false; setDraft(null); points.current = []; }
  }
  const last = room.rounds.at(-1);
  return <div className="stack sketch-stage">
    <div className="row-between"><h3>第 {Math.min(room.round, room.players.length)} / {room.players.length} 轮</h3><Tag color="blue">{name(room.drawerId)}绘画</Tag></div>
    {drawing && <Alert type={mine ? 'success' : 'info'} showIcon message={mine ? `你的题目：${room.answer}` : room.me.guessed ? '你猜对了！请勿向其他人透露答案。' : '观察画布，猜猜是什么圣经人物、物件或故事'} description={mine ? '可以画画，也可以用文字描述；请勿写答案、谐音或答案中的文字。' : '每轮最多猜十次；答案有少量常见别称，公布后可查看经文出处。'} />}
    <svg className={`sketch-board ${mine && drawing ? 'editable' : ''}`} viewBox="0 0 700 400" role="img" aria-label={mine && drawing ? '绘画画布，可用手指或鼠标绘画，也可在下方输入描述' : '本轮共享画布'} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <rect width="700" height="400" fill="white" />{room.strokes.map((stroke, i) => <Stroke key={i} stroke={stroke} />)}{draft && <Stroke stroke={draft} />}
      {!room.strokes.length && !draft && <text x="350" y="200" textAnchor="middle" fill="#98a3b5" fontSize="20">{mine && drawing ? '在这里画出你的线索' : '等待绘画者落笔…'}</text>}
    </svg>
    {drawing && mine && <><Space wrap><Select aria-label="画笔颜色" disabled={busy} value={color} onChange={setColor} options={colors} /><Select aria-label="画笔粗细" disabled={busy} value={width} onChange={setWidth} options={[{ value: 2, label: '细笔' }, { value: 4, label: '中笔' }, { value: 8, label: '粗笔' }]} /><Button disabled={busy || !room.strokes.length} onClick={() => action('undoStroke')}>撤销</Button><Button disabled={busy || !room.strokes.length} onClick={() => action('clearCanvas', {}, '清空当前画布？')}>清空</Button><small className="muted">{room.strokes.length}/200 笔</small></Space>
      <form className="bible-answer-form" onSubmit={e => { e.preventDefault(); if (text.trim() && !busy) { action('describeDrawing', { text }).then(ok => { if (ok) setText(''); }); } }}><Input aria-label="补充文字线索" maxLength={120} placeholder="也可以输入一句描述，不能直接写答案" value={text} onChange={e => setText(e.target.value)} /><Button htmlType="submit" disabled={!text.trim() || busy}>发送线索</Button></form></>}
    {room.description && <Alert type="info" message={`文字线索：${room.description}`} />}
    {drawing && !mine && !room.me.guessed && <form className="bible-answer-form" onSubmit={e => { e.preventDefault(); if (text.trim() && !busy) { action('guessDrawing', { text }).then(ok => { if (ok) setText(''); }); } }}><Input aria-label="我的猜测" value={text} maxLength={30} placeholder="输入你猜到的答案" onChange={e => setText(e.target.value)} /><Button type="primary" htmlType="submit" disabled={busy || !text.trim()}>猜一下</Button></form>}
    {drawing && (mine || room.hostId === user.id) && <Button disabled={busy} onClick={() => action('advance', {}, '结束本轮并揭晓答案？')}>结束本轮，揭晓答案</Button>}
    {room.guesses.length > 0 && <div className="sketch-guesses" aria-live="polite">{room.guesses.map((guess, i) => <p key={i}><strong>{name(guess.userId)}</strong> <span className={guess.correct ? 'sketch-guess-correct' : 'muted'}>{guess.text}{guess.correct ? ' ✓' : ''}</span></p>)}</div>}
    {room.phase === 'drawingResult' && <><Alert showIcon type="success" message={`本轮答案：${room.answer}`} description={<a href={last.url} target="_blank" rel="noreferrer">{last.ref} ↗</a>} />{(mine || room.hostId === user.id) ? <Button type="primary" disabled={busy} onClick={() => action('advance')}>{room.round === room.players.length ? '查看最终成绩' : '下一位绘画'}</Button> : <p className="muted">等待绘画者或房主继续。</p>}</>}
    {room.phase === 'finished' && <><Alert showIcon type={room.winner ? 'success' : 'warning'} message={room.winner ? `本局优胜：${room.winner.map(name).join('、')}` : '本局提前结束'} description={room.reason} />{room.hostId === user.id && <Button disabled={busy} type="primary" onClick={() => action('restart')}>再来一局</Button>}</>}
    <h3>本局成绩</h3><div className="avalon-players">{[...room.players].sort((a, b) => b.score - a.score).map(p => <div key={p.id} className="row-between"><strong>{name(p.id)}{p.id === room.drawerId ? ' ✏️' : ''}</strong><Space>{p.guessed && <Tag color="green">已猜中</Tag>}<Tag>{p.score} 分</Tag></Space></div>)}</div>
    {room.rounds.length > 0 && <Collapse items={[{ key: 'rounds', label: `已揭晓 ${room.rounds.length} 轮`, children: <div className="stack">{room.rounds.map(r => <div key={r.round}><strong>第 {r.round} 轮 · {name(r.drawerId)} · {r.answer}</strong><p className="muted">{r.correct.length} 人猜中 · <a href={r.url} target="_blank" rel="noreferrer">{r.ref} ↗</a></p></div>)}</div> }]} />}
  </div>;
}
export function SketchRules() { return <Collapse ghost items={[{ key: 'rules', label: '怎么玩？查看绘画猜词规则', children: <div className="stack"><p>2–10 人，各自账号加入。每人轮流绘画一轮，只有绘画者能看到题目；其他人看共享画布猜答案，也可以用文字线索代替绘画。</p><p>每轮每人最多猜十次。首位猜中得 100 分，之后依次 80、60、40，最低 20 分；每有一人猜中，绘画者得 30 分。已猜中的答案暂不公开，避免影响其他人。</p><p>全部猜中自动揭晓，绘画者或房主也可提前结束本轮。揭晓后可读经文出处；每个人画完一轮，总分最高者获胜，同分并列。没有强制倒计时。</p><p>请用图画、描述表达，勿直接写题目或谐音。房间 2–5 人时每 2 秒同步，6–10 人时每 5 秒同步，一次最多 200 笔，每笔最多 200 个采样点。对局记录保留题目、出处、猜中者与成绩，不保存画布。</p></div> }]} />; }
