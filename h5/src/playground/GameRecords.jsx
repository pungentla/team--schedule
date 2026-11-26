import React, { useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Modal from 'antd/es/modal';
import Pagination from 'antd/es/pagination';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { API, Blank, Heading, Load, personName, timeText, useAction, usePageLoad } from '../shared';
import { RewardReceipt } from './Harvest';
const games = { avalon: '圣经版阿瓦隆', undercover: '圣经版谁是卧底', uno: '圣经版 UNO', sketch: '圣经你画我猜' };
function outcome(record) {
  if (record.status === 'abandoned') return '提前结束';
  if (record.game === 'sketch') return `优胜：${record.winner.map(id => record.players.find(p => p.id === id)?.name || '玩家').join('、')}`;
  if (record.game === 'uno') return `${record.players.find(p => p.id === record.winner)?.name || '玩家'}获胜`;
  return `${({ light: '光明阵营', shadow: '暗影阵营', civilian: '平民', undercover: '卧底' })[record.winner]}获胜`;
}
export default function GameRecords({ user, back, initialGame = 'all' }) {
  const [game, setGame] = useState(initialGame), [page, setPage] = useState(1), [id, setId] = useState(null);
  const query = usePageLoad(`${game}-${page}`, () => API.gameRecords({ game, page }));
  return <div className="stack"><Button className="playground-back" type="text" onClick={back}>← 返回游乐场</Button><Card><Heading>游戏记录</Heading><div className="stack"><p className="muted">仅展示你参与的对局，完成和提前结束的记录都会保留。</p><Select aria-label="筛选游戏记录" value={game} onChange={value => { setGame(value); setPage(1); }} options={[{ value: 'all', label: '全部游戏' }, ...Object.entries(games).map(([value, label]) => ({ value, label }))]} /></div></Card>
    <Load query={query}>{data => <>{data.items.length ? data.items.map(record => <Card key={record.id}><button type="button" className="todo-summary" onClick={() => setId(record.id)}>
      <div className="row-between"><strong>{games[record.game]}</strong><Tag color={record.status === 'completed' ? 'green' : 'default'}>{outcome(record)}</Tag></div><span className="muted">{timeText(record.finishedAt)} · {record.players.length} 人</span><span>{record.players.map(p => personName(p, user.id)).join('、')}</span><span className="game-record-open">查看详情 ›</span>
    </button></Card>) : <Card><Blank>还没有游戏记录，和朋友开一局吧</Blank></Card>}<Pagination current={page} total={data.total} pageSize={20} showSizeChanger={false} hideOnSinglePage onChange={setPage} /></>}</Load>
    {id && <RecordDetail id={id} user={user} close={() => setId(null)} deleted={() => {
      setId(null);
      if (query.data?.items.length === 1 && page > 1) setPage(page - 1);
      else query.refresh();
    }} />}
  </div>;
}
function RecordDetail({ id, user, close, deleted }) {
  const query = usePageLoad(id, () => API.gameRecord(id));
  const { run, busy, confirm } = useAction();
  async function remove() {
    if (!await confirm('删除这条游戏记录？', '删除后，所有参与者都将无法再查看这条记录，且无法恢复。确定删除吗？', true, '确认删除')) return;
    await run(() => API.deleteGameRecord(id), '游戏记录已删除', deleted);
  }
  return <Modal open title="游戏记录详情" onCancel={() => !busy && close()} footer={<div className="row-between">
    <span>{query.data?.canDelete && <Button danger disabled={busy} loading={busy} onClick={remove}>删除记录</Button>}</span>
    <Button disabled={busy} onClick={close}>关闭</Button>
  </div>} width={720}><Load query={query}>{record => {
    const name = id => { const p = record.players.find(p => p.id === id); return p ? personName(p, user.id) : '玩家'; };
    return <div className="stack game-record-detail"><h2>{games[record.game]}</h2><Tag color={record.status === 'completed' ? 'green' : 'default'}>{outcome(record)}</Tag><p>{record.reason}</p><p className="muted">{timeText(record.startedAt)} 至 {timeText(record.finishedAt)} · 房间 {record.roomCode}</p>
      {record.reward?.amount > 0 && <RewardReceipt reward={record.reward} />}<h3>参与成员</h3><div className="avalon-players">{record.players.map(p => <div key={p.id} className="row-between"><strong>{personName(p, user.id)}</strong><Space wrap>{p.role && <Tag>{p.role}</Tag>}{p.word && <Tag color="blue">{p.word}</Tag>}{p.cardCount != null && <Tag>剩 {p.cardCount} 张</Tag>}{record.scores && <Tag>{record.scores[p.id] || 0} 分</Tag>}</Space></div>)}</div>
      {record.rounds && <><h3>绘画猜词记录</h3>{record.rounds.map(r => <div key={r.round}><strong>第 {r.round} 轮 · {name(r.drawerId)} · {r.answer}</strong><p className="muted">猜中：{r.correct.map(name).join('、') || '无人猜中'}</p><a href={r.url} target="_blank" rel="noreferrer">{r.ref} ↗</a></div>)}</>}
      {record.missions && <><h3>使命结果</h3><Space wrap>{record.missions.map((m, i) => <Tag key={i} color={m.success ? 'green' : 'red'}>使命 {i + 1} · {m.success ? '成功' : '失败'} · {m.fails} 张破坏</Tag>)}</Space></>}
      {record.clues?.length > 0 && <><h3>描述记录</h3>{record.clues.map((clue, i) => <div key={i}><small className="muted">第 {clue.round} 轮{clue.runoff ? '加赛' : ''} · {name(clue.userId)}</small><p>{clue.text}</p></div>)}</>}
      {record.history?.length > 0 && <><h3>投票记录</h3>{record.history.map((entry, i) => <div key={i} className="game-record-vote"><strong>{record.game === 'avalon' ? `使命 ${entry.round + 1} · ${entry.approved ? '组队通过' : '组队未通过'}` : `第 ${entry.round} 轮${entry.runoff ? '加赛' : ''}`}</strong>{entry.team && <p className="muted">队伍：{entry.team.map(name).join('、')}</p>}<Space wrap>{Object.entries(entry.votes).map(([id, value]) => <Tag key={id}>{name(Number(id))} → {record.game === 'avalon' ? value ? '赞成' : '反对' : name(value)}</Tag>)}</Space></div>)}</>}
      {record.events && <><h3>对局记录</h3><p className="muted">最多保留最近 500 条动作，不展示其他人的手牌。</p><ol className="uno-events">{record.events.map((event, i) => <li key={i}>{event}</li>)}</ol></>}
    </div>;
  }}</Load></Modal>;
}
