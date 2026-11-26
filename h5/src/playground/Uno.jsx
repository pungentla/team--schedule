import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Checkbox from 'antd/es/checkbox';
import Collapse from 'antd/es/collapse';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { personName } from '../shared';

const colors = { purple: '葡萄紫', gold: '麦穗金', green: '橄榄绿', blue: '溪水蓝', wild: '彩约' };
const symbols = { purple: '🍇', gold: '🌾', green: '🫒', blue: '💧', wild: '🌈' };
const faces = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '✦', draw4: '+4' };
function CardFace({ card, selected, onClick, disabled }) {
  const content = <><small>{symbols[card.color]} {colors[card.color]}</small><strong>{card.kind === 'number' ? card.value : faces[card.kind]}</strong><small>{card.kind === 'number' ? '同行数字' : card.label}</small></>;
  return onClick ? <button type="button" className={`uno-card uno-${card.color} ${selected ? 'selected' : ''}`} disabled={disabled} aria-pressed={selected} aria-label={`${colors[card.color]} ${card.label}`} onClick={onClick}>{content}</button> : <div className={`uno-card uno-${card.color}`} aria-label={`${colors[card.color]} ${card.label}`}>{content}</div>;
}
export function UnoStage({ room, user, action, busy }) {
  const [selectedId, setSelectedId] = useState(), [color, setColor] = useState(), [uno, setUno] = useState(false);
  const current = room.players.find(p => p.id === room.currentId), mine = current?.id === user.id, selected = room.me.hand.find(c => c.id === selectedId);
  const name = p => personName(p, user.id);
  return <div className="stack uno-stage">
    <div className="uno-player-strip">{room.players.map(p => <div key={p.id} className={p.id === room.currentId && room.phase === 'playing' ? 'current' : ''}><strong>{name(p)}</strong><span>{p.cardCount} 张{p.cardCount === 1 ? ' · UNO' : ''}</span></div>)}</div>
    {room.phase === 'finished' ? <><Alert type={room.winner ? 'success' : 'warning'} showIcon message={room.winner ? '本局已分出胜负' : '本局提前结束'} description={room.reason} />{room.hostId === user.id && <Button type="primary" disabled={busy} onClick={() => action('restart')}>再来一局</Button>}</> : <Alert type={mine ? 'success' : 'info'} message={mine ? '轮到你出牌' : `等待${current ? name(current) : '队友'}出牌`} description={`当前颜色：${colors[room.color]} · ${room.direction === 1 ? '顺序' : '逆序'}出牌${room.drawn ? ' · 本回合只能出刚抽到的牌，或结束回合' : ''}`} />}
    {room.top && <div className="uno-table"><div><small className="muted">牌堆 · {room.drawCount} 张</small><div className="uno-card uno-back">🌈<strong>彩约</strong></div></div><div><small className="muted">当前弃牌</small><CardFace card={room.top} /></div></div>}
    <div className="row-between"><h3>我的手牌 · {room.me.hand.length} 张</h3><Tag>仅自己可见</Tag></div>
    <div className="uno-hand" tabIndex={0} aria-label="我的手牌列表">{room.me.hand.map(card => <CardFace key={card.id} card={card} selected={card.id === selectedId} disabled={busy || !card.playable || room.phase !== 'playing'} onClick={() => setSelectedId(card.id)} />)}</div>
    {mine && room.phase === 'playing' && <>
      <p className="muted">亮起的牌可出；点击选牌后确认。加二、加四不叠加。</p>
      {selected?.color === 'wild' && <Select aria-label="选择下一种颜色" placeholder="选择下一种颜色" value={color} onChange={setColor} options={Object.entries(colors).filter(([id]) => id !== 'wild').map(([value, label]) => ({ value, label }))} />}
      {room.me.hand.length === 2 && <Checkbox checked={uno} onChange={e => setUno(e.target.checked)}>喊 UNO！出牌后只剩一张，忘记会补两张牌。</Checkbox>}
      <Space wrap><Button type="primary" disabled={busy || !selected || (selected.color === 'wild' && !color)} onClick={() => action('playCard', { cardId: selectedId, color, uno }, room.me.hand.length === 2 && !uno ? '未喊 UNO 将补两张，仍然出牌？' : undefined)}>确认出牌</Button><Button disabled={busy || room.drawn} onClick={() => action('draw')}>抽一张</Button>{room.drawn && <Button disabled={busy} onClick={() => action('pass')}>结束回合</Button>}</Space>
    </>}
    {room.events.length > 0 && <Collapse items={[{ key: 'events', label: '对局记录', children: <ol className="uno-events">{room.events.map((event, i) => <li key={i}>{event}</li>)}</ol> }]} />}
  </div>;
}
export function UnoRules() {
  return <Collapse ghost className="avalon-rules" items={[{ key: 'rules', label: '怎么玩？查看彩约对局规则', children: <div className="stack"><p>2–10 人联机，每人 7 张牌，108 张基础牌。开局翻出一张数字牌，随机决定先手；率先出完手牌的人获胜。</p><p>按同色、同数字或同功能接牌。不能或不想出时抽一张；抽到可出的牌，可打出这张新牌，也可结束回合。其他手牌不能在抽牌后打出。</p><p>「安息」跳过下一人，「回转」改变方向（两人时相当于跳过），「同行 +2」让下一人抽两张并跳过；「彩约」选择颜色，「四方 +4」选择颜色并让下一人抽四张、跳过。仅没有当前同色手牌时才能出 +4，由服务器校验，不设质疑流程。</p><p>剩两张时，在出牌前勾选「喊 UNO」。未喊而剩一张会自动补两张。当前不叠加 +2/+4，不设抢出、换手和累计积分；牌堆用完时自动洗回弃牌。</p><p className="muted">圣经意象的原创牌面与家庭规则改编，未使用 UNO 官方图像或商标设计。</p></div> }]} />;
}
