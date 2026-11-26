import React, { useRef, useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Input from 'antd/es/input';
import Progress from 'antd/es/progress';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { API, Heading, Load, useAction, useLoad } from '../shared';
import { moveItem, projectPoint } from './learning.mjs';
import { RewardReceipt } from './Harvest';

export const learningGames = [
  { id: 'quiz', icon: '📖', name: '圣经闯关', copy: '选择主题，边答边认识圣经故事', color: 'blue', rule: '每关 8 题，选择答案后确认。每题 10 分，答后展示解释与经文出处。' },
  { id: 'identity', icon: '🔎', name: '我是谁', copy: '逐条揭晓线索，猜出圣经人物', color: 'gold', rule: '每关 4 位人物。只看一条线索猜中得 10 分，两条 7 分，三条 4 分；答错或揭晓答案得 0 分。请填写和合本的人物名称。' },
  { id: 'timeline', icon: '⏳', name: '故事时间线', copy: '排好先后，串起故事的来龙去脉', color: 'cyan', rule: '每关 3 个故事。拖动卡片或用上下箭头排序，按经文叙事次序排列，整题正确得 10 分。' },
  { id: 'verse', icon: '🧩', name: '经文拼图', copy: '点选词块，拼回熟悉的经文', color: 'green', rule: '每关 3 节经文。依次点击词块拼句，点击已选词块可撤回。按和合本用字，标点不计；整句正确得 10 分。' },
  { id: 'match', icon: '🌿', name: '人物关系连连看', copy: '人物与经历配对，记住彼此的联系', color: 'purple', rule: '每关 4 对。先选人物，再选对应经历；配错可重试。每对 10 分，每次配错扣 2 分，最低 0 分。' },
  { id: 'map', icon: '🗺️', name: '圣经地图寻踪', copy: '跟随故事，在地图上找到地点', color: 'orange', rule: '沿关卡探索不同地区，阅读线索后点击地图编号或地点按钮。每题 10 分。地图是带方位的概略学习示意，不表示疆界或精确古址。' },
];
export default function BibleLearning({ game, user }) {
  const info = learningGames.find(item => item.id === game), meta = useLoad(`learning-meta-${user.id}-${game}`, API.learningMeta);
  const [session, setSession] = useState(null);
  const { run, busy } = useAction();
  function accept(value) { if (value.phase === 'abandoned') { setSession(null); meta.refresh(); return; } setSession(value); if (value.phase === 'completed') meta.refresh(); }
  async function start(levelId) { await run(() => API.learningStart({ game, levelId }), null, value => { accept(value); window.scrollTo(0, 0); }); }
  async function act(action, values = {}) {
    let result;
    const ok = await run(() => API.learningAct(session.id, { action, index: session.index, ...values }), null, value => { accept(value); result = value; });
    if (!ok) { try { accept(await API.learningGet(session.id)); } catch { /* Keep the existing challenge visible until the next retry. */ } }
    return result;
  }
  const done = session?.phase === 'completed', feedback = session?.feedback, question = session?.question;
  return <div className="stack bible-learning">
    <Card><Heading>{info.icon} {info.name}</Heading><p className="muted">{info.copy}</p><p>{info.rule}</p><small className="muted">单人闯关 · {meta.data?.levels[game].filter(l => l.cleared).length ?? '—'} / {meta.data?.levels[game].length ?? '—'} 关已通关 · 80% 解锁下一关</small></Card>
    {!session ? <Card><Load query={meta}>{data => <div className="stack"><div className="row-between"><h3>选择关卡</h3><Tag color="gold">每日首次完成收获禾穗</Tag></div><p className="muted">同一关每天仅首次完成奖励禾穗（北京时间）。达到 80% 成绩即可通关。已通关可重玩，保留最佳成绩并更新最近成绩；新增关卡会接在后面，已有进度继续保留。</p><div className="bible-levels">{data.levels[game].map(level => <button type="button" className={`bible-level ${level.cleared ? 'cleared' : ''}`} key={level.id} disabled={!level.unlocked || busy} onClick={() => start(level.id)}>
      <span className="row-between"><strong>第 {level.number} 关</strong><Tag color={level.cleared ? 'green' : level.unlocked ? 'blue' : 'default'}>{level.cleared ? '已通关 ✓' : level.unlocked ? '待挑战' : '🔒 未解锁'}</Tag></span><strong>{level.title}</strong><span className="muted">{level.count} {game === 'match' ? '对' : '题'} · 满分 {level.maximum}</span>{level.bestScore != null && <><span>最佳 {level.bestScore} / {level.maximum}</span><small className="muted">最近 {level.lastScore} · 已挑战 {level.attempts} 次</small></>}
      <span className="bible-level-action">{!level.unlocked ? '通过上一关后解锁' : level.attempts ? '再次挑战 / 继续 ›' : '开始挑战 ›'}</span>
    </button>)}</div><small className="muted">进行中的关卡会跟随账号保存。切换到其他关卡会重新开始该关；未完成的关卡不结算禾穗。</small></div>}</Load></Card> : done ? <Card><div className="stack bible-summary"><span className="bible-summary-icon">🌾</span><h2>第 {session.level.number} 关 · {session.passed ? '通关成功' : '继续加油'}</h2><Tag color={session.passed ? 'green' : 'orange'}>{session.passed ? '已达到 80% 通关标准' : '本次未达到 80%，可以重试'}</Tag>{session.newBest && <Tag color="gold">刷新最佳成绩</Tag>}<strong className="bible-score">{session.score}<small> / {session.level.maximum} 分</small></strong><RewardReceipt reward={session.reward} /><p>把答案带回经文，会发现更多故事。</p>
      {session.results.map((r, i) => <div className="bible-review" key={i}><Tag color={r.score ? 'green' : 'default'}>{r.score} 分</Tag><strong>{r.title}</strong><p>{r.answer}</p><p className="muted">{r.explain}</p><Reference item={r} /></div>)}
      <Space wrap><Button type="primary" loading={busy} onClick={() => start(session.level.id)}>重新挑战本关</Button>{session.nextLevelId && <Button disabled={busy} onClick={() => start(session.nextLevelId)}>挑战下一关</Button>}<Button disabled={busy} onClick={() => setSession(null)}>返回关卡</Button></Space>
    </div></Card> : <Card><div className="stack"><div className="row-between"><Tag color="gold">第 {session.level.number} 关</Tag><Tag color="blue">{game === 'match' ? `本轮 ${session.count} 对` : `第 ${session.index + 1} / ${session.count} 题`}</Tag><span className="muted">本局成绩 {session.score} 分</span></div>{game !== 'match' && <Progress percent={Math.round(session.index / session.count * 100)} showInfo={false} />}
      {game === 'match' ? <MatchRound item={question} act={act} busy={busy} /> : <>
        {game === 'quiz' && <QuizRound key={session.index} item={question} feedback={feedback} act={act} busy={busy} />}
        {game === 'identity' && <IdentityRound key={session.index} item={question} feedback={feedback} act={act} busy={busy} />}
        {(game === 'timeline' || game === 'verse') && <OrderRound key={session.index} item={question} feedback={feedback} verse={game === 'verse'} act={act} busy={busy} />}
        {game === 'map' && <MapRound key={session.index} item={question} feedback={feedback} act={act} busy={busy} />}
        {feedback && <Button type="primary" loading={busy} onClick={() => act('next')}>{session.index + 1 === session.count ? '完成本关，查看收获' : '下一题'}</Button>}
      </>}
    </div></Card>}
    {meta.data && <p className="muted bible-source">{meta.data.source.note} 经文来源：<a href={meta.data.source.url} target="_blank" rel="noreferrer">{meta.data.source.name}</a>。</p>}
  </div>;
}
function Reference({ item }) { return <a href={item.url} target="_blank" rel="noreferrer">{item.ref} ↗</a>; }
function Feedback({ item }) { return <Alert showIcon type={item.correct ? 'success' : 'info'} message={item.correct ? '答对了！' : `答案：${item.answer}`} description={<div className="stack"><span>{item.explain}</span><Reference item={item} /></div>} />; }
function QuizRound({ item, feedback, act, busy }) {
  const [selected, setSelected] = useState(null);
  return <><h2 className="bible-question">{item.question}</h2><div className="bible-options">{item.options.map((option, i) => <Button key={option} block disabled={!!feedback || busy} className={feedback && option === feedback.answer ? 'bible-correct' : ''} type={selected === option ? 'primary' : 'default'} onClick={() => setSelected(option)}><span>{String.fromCharCode(65 + i)}.</span> {option}</Button>)}</div>
    {feedback ? <Feedback item={feedback} /> : <Button type="primary" disabled={!selected || busy} onClick={() => act('answer', { answer: selected })}>确认答案</Button>}
  </>;
}
function IdentityRound({ item, feedback, act, busy }) {
  const [answer, setAnswer] = useState('');
  return <><h2 className="bible-question">这些线索描述的是谁？</h2><ol className="bible-clues">{item.clues.map((clue, i) => <li key={clue}><span>{i + 1}</span>{clue}</li>)}</ol>
    {feedback ? <Feedback item={feedback} /> : <><form className="bible-answer-form" onSubmit={e => { e.preventDefault(); if (answer.trim() && !busy) act('answer', { answer }); }}><Input aria-label="猜猜我是谁" disabled={busy} value={answer} maxLength={20} placeholder="输入人物名字" onChange={e => setAnswer(e.target.value)} /><Button htmlType="submit" type="primary" disabled={!answer.trim() || busy}>确认</Button></form><Space wrap><Button disabled={busy || item.hints === item.maxHints} onClick={() => act('hint')}>再看一条线索</Button><Button disabled={busy} type="text" onClick={() => act('reveal')}>揭晓答案</Button><Tag>猜中可得 {[10, 7, 4][item.hints - 1]} 分</Tag></Space></>}
  </>;
}
function OrderRound({ item, feedback, verse, act, busy }) {
  const values = Object.fromEntries(item.choices.map(c => [c.id, c.text]));
  const [order, setOrder] = useState(() => verse ? [] : item.choices.map(c => c.id));
  const dragged = useRef(null), disabled = !!feedback || busy;
  return <><h2 className="bible-question">{verse ? '把词块拼成经文' : item.title}</h2>{verse && <small className="muted">{item.ref} · 点选词块拼句，点击上方词块可撤回</small>}
    {verse ? <><div className="bible-verse-line" aria-label="已拼经文">{order.length ? order.map((id, index) => <Button key={id} disabled={disabled} onClick={() => setOrder(o => o.filter((_, i) => i !== index))}>{values[id]}</Button>) : <span className="muted">依次点击下方词块…</span>}</div><div className="bible-word-bank">{item.choices.map(({ id, text }) => <Button key={id} disabled={disabled || order.includes(id)} onClick={() => setOrder(o => [...o, id])}>{text}</Button>)}</div></> : <ol className="bible-timeline">{order.map((id, index) => <li key={id} draggable={!disabled} onDragStart={() => { dragged.current = index; }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!disabled && dragged.current != null) setOrder(o => moveItem(o, dragged.current, index)); dragged.current = null; }}><span className="bible-order-number">{index + 1}</span><strong>{values[id]}</strong><Space size={0}><Button aria-label={`上移${values[id]}`} disabled={disabled || index === 0} onClick={() => setOrder(o => moveItem(o, index, index - 1))}>↑</Button><Button aria-label={`下移${values[id]}`} disabled={disabled || index === order.length - 1} onClick={() => setOrder(o => moveItem(o, index, index + 1))}>↓</Button></Space></li>)}</ol>}
    {feedback ? <Feedback item={feedback} /> : <Space wrap><Button type="primary" disabled={busy || order.length !== item.choices.length} onClick={() => act('answer', { answer: order })}>确认{verse ? '拼句' : '顺序'}</Button>{verse && <Button disabled={busy || !order.length} onClick={() => setOrder([])}>重新拼</Button>}</Space>}
  </>;
}
function MatchRound({ item, act, busy }) {
  const [selected, setSelected] = useState(null);
  async function pair(rightId) { if (!selected || busy) return; const result = await act('pair', { leftId: selected, rightId }); if (result?.question?.lastPair?.correct) setSelected(null); }
  return <><h2 className="bible-question">找到人物对应的经历</h2><p className="muted" role="status">已配对 {item.matched.length}/{item.left.length} · {item.lastPair?.correct === false ? '这一对不匹配，再试试。' : selected ? `为${item.left.find(p => p.id === selected)?.text}选择经历` : '先选左侧人物，再选右侧经历'}</p><div className="bible-match-columns"><div>{item.left.map(p => <Button key={p.id} block type={selected === p.id ? 'primary' : 'default'} disabled={busy || item.matched.some(m => m.leftId === p.id)} onClick={() => setSelected(p.id)}>{item.matched.some(m => m.leftId === p.id) ? '✓ ' : ''}{p.text}</Button>)}</div><div>{item.right.map(p => <Button key={p.id} block disabled={busy || item.matched.some(m => m.rightId === p.id) || !selected} danger={item.lastPair?.correct === false && item.lastPair.rightId === p.id} onClick={() => pair(p.id)}>{item.matched.some(m => m.rightId === p.id) ? '✓ ' : ''}{p.text}</Button>)}</div></div>
    {item.matched.length > 0 && <div className="bible-matched-notes">{item.matched.map(m => <div key={m.leftId}><strong>{m.title}</strong><p className="muted">{m.explain}</p><Reference item={m} /></div>)}</div>}
  </>;
}
function MapRound({ item, feedback, act, busy }) {
  const region = item.region;
  const places = item.places, [selected, setSelected] = useState(null), submitted = !!feedback;
  const water = projectPoint(region.waterPoint, region.bounds);
  function choose(name) { if (!submitted && !busy) setSelected(name); }
  return <><h2 className="bible-question">{item.question}</h2><p className="muted">{region.name} · 点击编号或下方地点选择，北方朝上</p><div className="bible-map"><svg viewBox="0 0 700 380" role="img" aria-label={`${region.name}地点示意图，亦可用下方按钮选择`}><defs><pattern id="bible-map-grid" width="70" height="38" patternUnits="userSpaceOnUse"><path d="M70 0H0V38" fill="none" stroke="#d9e5d3" strokeWidth="1" /></pattern></defs><rect width="700" height="380" rx="20" fill="#f4f5e8" /><rect width="700" height="380" fill="url(#bible-map-grid)" /><ellipse cx={water[0]} cy={water[1]} rx={region.id === 'journeys' ? 140 : 25} ry={region.id === 'journeys' ? 45 : 37} fill="#cce8ef" /><text x={water[0]} y={water[1] + 5} textAnchor="middle" fill="#4c7e90" fontSize="15">{region.water}</text><text x="650" y="27" fontSize="17" fill="#64745c">↑ N</text>{places.map((place, i) => { const [x, y] = projectPoint([place.lon, place.lat], region.bounds); const color = submitted && place.name === feedback?.answer ? '#33925c' : selected === place.name ? '#3159aa' : '#fff'; return <g key={place.name} onClick={() => choose(place.name)} className="bible-map-marker"><circle cx={x} cy={y} r="16" fill={color} stroke="#3159aa" strokeWidth="2" /><text x={x} y={y + 5} textAnchor="middle" fontSize="14" fill={color === '#fff' ? '#3159aa' : '#fff'}>{i + 1}</text></g>; })}</svg></div>
    <div className="bible-map-choices">{places.map((place, i) => <Button key={place.name} disabled={submitted || busy} className={submitted && place.name === feedback?.answer ? 'bible-correct' : ''} type={selected === place.name ? 'primary' : 'default'} onClick={() => choose(place.name)}>{i + 1}. {place.name}</Button>)}</div>
    {submitted ? <Feedback item={feedback} /> : <Button type="primary" disabled={!selected || busy} onClick={() => act('answer', { answer: selected })}>确认地点</Button>}
  </>;
}
