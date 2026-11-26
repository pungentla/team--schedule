import React, { useEffect, useRef, useState } from 'react';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Collapse from 'antd/es/collapse';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Spin from 'antd/es/spin';
import Tag from 'antd/es/tag';
import CopyOutlined from '@ant-design/icons/es/icons/CopyOutlined';
import EyeOutlined from '@ant-design/icons/es/icons/EyeOutlined';
import { API, Heading, personName, useAction } from '../shared';
import { UndercoverStage, UndercoverRules } from './Undercover';
import { UnoStage, UnoRules } from './Uno';
import { SketchStage, SketchRules } from './Sketch';
import { RewardReceipt } from './Harvest';

const stages = { waiting: '等待加入', identity: '领取秘密', team: '队长组队', vote: '全员投票', voteResult: '投票结果', mission: '执行使命', missionResult: '使命结果', accusation: '最终指认', finished: '本局结束', describe: '轮流描述', playing: '出牌进行中', drawing: '绘画猜词', drawingResult: '本轮揭晓' };
const gameInfo = {
  sketch: { name: '圣经你画我猜', title: '🎨 画里有故事', min: 2, copy: '一人画线索，大家猜故事，揭晓后一起认识经文。' },
  avalon: { name: '圣经版阿瓦隆', title: '🕯️ 守望之旅', min: 5, copy: '各用一部手机，共赴一场关于信任与辨识的旅程。' },
  undercover: { name: '圣经版谁是卧底', title: '🕊️ 同词异心', min: 4, copy: '一样的故事，不一样的词语。用一句描述，寻找隐藏的不同。' },
  uno: { name: '圣经版 UNO', title: '🌈 彩约对局', min: 2, copy: '让色彩与数字接续旅程，别忘了最后一张前喊 UNO！' },
};
const missionNames = ['同行启程', '分享粮食', '守护城门', '旷野互助', '点亮灯台'];

export default function PartyGame({ user, game, openGame, openRecords }) {
  const info = gameInfo[game];
  const [room, setRoom] = useState(null), [loading, setLoading] = useState(true), [syncError, setSyncError] = useState('');
  const [code, setCode] = useState(''), [privateOpen, setPrivateOpen] = useState(false);
  const epoch = useRef(0);
  const { run, busy, confirm } = useAction();
  const { message } = App.useApp();
  function accept(data) { setRoom(previous => previous && data && previous.id === data.id && previous.revision > data.revision ? previous : data); }
  useEffect(() => {
    let active = true;
    API.partyCurrent().then(data => { if (active) accept(data); }, e => { if (active) setSyncError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!room) return;
    let active = true, pending = false;
    async function refresh() {
      if (document.hidden || pending) return;
      pending = true;
      const version = epoch.current;
      try {
        const data = await API.partyRoom(room.id);
        if (active && version === epoch.current) { accept(data); setSyncError(''); }
      } catch (e) {
        if (active && version === epoch.current) {
          setSyncError(e.message);
          if (e.status === 404) { setRoom(null); setPrivateOpen(false); }
        }
      } finally { pending = false; }
    }
    const timer = setInterval(refresh, game === 'sketch' && room.players.length < 6 ? 2000 : 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [room?.id, room?.players.length, game]);
  useEffect(() => {
    const hide = () => setPrivateOpen(false);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);
    return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hide); };
  }, []);
  async function action(type, values = {}, question) {
    if (question && !await confirm(question, '提交后不能修改，请确认选择。')) return;
    epoch.current++;
    const success = await run(() => API.partyAction(room.id, { action: type, turn: room.turn, ...values }), null,
      data => { accept(data); setSyncError(''); if (!data) setPrivateOpen(false); });
    // A simultaneous action may have advanced the phase; reconcile even after a conflict.
    if (type !== 'leave' && !(success && game === 'sketch')) {
      try { accept(await API.partyRoom(room.id)); } catch (e) { if (e.status === 404) setRoom(null); }
    }
    return success;
  }
  async function leave() {
    const text = room.hostId === user.id ? '解散房间？其他成员也将退出。' : !['waiting', 'finished'].includes(room.phase) ? '退出房间？当前对局将结束。' : '退出房间？';
    if (await confirm(text)) await action('leave');
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(room.code); message.success('房间号已复制'); }
    catch { message.info(`房间号：${room.code}`); }
  }
  if (room && room.game !== game) return <Card><div className="stack"><Heading>你已在另一个游戏房间中</Heading><p>当前正在参加{gameInfo[room.game].name}，一个账号同时只能加入一个房间。</p><Button type="primary" onClick={() => openGame(room.game)}>返回{gameInfo[room.game].name}</Button><Button disabled={busy} onClick={leave}>{room.hostId === user.id ? '解散当前房间' : '退出当前房间'}</Button></div></Card>;
  return <>
    <Card className="avalon-intro"><div className="row-between"><div><span className="playground-eyebrow">{info.name} · 多人联机</span><h2>{info.title}</h2></div><Space wrap>{room && <Tag color="gold">{stages[room.phase]}</Tag>}<Button size="small" onClick={() => openRecords(game)}>游戏记录</Button></Space></div>
      <p className="muted">{info.copy}</p>
      {game === 'avalon' ? <Rules /> : game === 'undercover' ? <UndercoverRules /> : game === 'sketch' ? <SketchRules /> : <UnoRules />}
    </Card>
    {room?.phase === 'finished' && <RewardReceipt reward={room.reward} />}
    {syncError && <Alert type="warning" showIcon message={syncError} action={!room && !loading ? <Button size="small" onClick={() => { setLoading(true); run(API.partyCurrent, null, data => { accept(data); setSyncError(''); }).finally(() => setLoading(false)); }}>重试</Button> : undefined} />}
    {loading ? <div className="loading"><Spin /></div> : !room ? <Card><Heading>开启一场旅程</Heading><div className="stack">
      <Button type="primary" block loading={busy} onClick={() => run(() => API.partyCreate(game), null, data => { accept(data); setSyncError(''); })}>创建房间</Button><div className="avalon-or">或加入朋友的房间</div>
      <Form onFinish={() => run(() => API.partyJoin(code), null, data => { accept(data); setSyncError(''); })}>
        <div className="avalon-join"><Input aria-label="六位房间号" inputMode="numeric" maxLength={6} placeholder="六位房间号" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
          <Button htmlType="submit" disabled={code.length !== 6} loading={busy}>加入房间</Button></div>
      </Form><p className="muted">需要 {info.min}–10 位玩家，使用各自的时禾账号。离开页面后可回来继续，房间 24 小时无操作自动失效。</p>
    </div></Card> : <>
      <Card><div className="row-between avalon-room-heading"><div><small className="muted">房间号</small><strong className="avalon-code">{room.code}</strong></div><Space wrap><Button size="small" icon={<CopyOutlined />} onClick={copyCode}>复制</Button><Button size="small" onClick={leave} disabled={busy}>{room.hostId === user.id ? '解散' : '退出'}</Button></Space></div>
        <p className="muted avalon-sync" role="status">{syncError ? '正在重连…' : `已连接 · 每 ${game === 'sketch' && room.players.length < 6 ? 2 : 5} 秒同步进度`}</p>
        {room.phase === 'waiting' ? <div className="stack"><div className="avalon-players">{room.players.map(player => <div key={player.id} className="row-between"><strong>{personName(player, user.id)}{player.id === room.hostId && <small className="muted"> · 房主</small>}</strong><Tag color={player.ready ? 'green' : 'default'}>{player.ready ? '已准备' : '待准备'}</Tag></div>)}</div>
          <p className="muted">{room.players.length}/10 人 · 至少 {info.min} 人，所有人准备后由房主开始。</p>
          <Space wrap><Button type={room.players.find(p => p.id === user.id)?.ready ? 'default' : 'primary'} disabled={busy} onClick={() => action('ready', { ready: !room.players.find(p => p.id === user.id)?.ready })}>{room.players.find(p => p.id === user.id)?.ready ? '取消准备' : '我准备好了'}</Button>
            {room.hostId === user.id && <Button type="primary" disabled={busy || room.players.length < info.min || !room.players.every(p => p.ready)} onClick={() => action('start')}>开始游戏</Button>}</Space>
        </div> : <div className="stack">
          {game === 'avalon' && <div className="avalon-scoreboard">{missionNames.map((name, i) => <div key={name} className={`avalon-mission ${room.missions[i] ? room.missions[i].success ? 'success' : 'failure' : i === room.round ? 'current' : ''}`}>
            <small>使命 {i + 1}</small><strong>{room.missions[i] ? room.missions[i].success ? '✓' : '✕' : room.teamSizes[i] || '—'}</strong><small>{room.missions[i] ? room.missions[i].success ? '成功' : '失败' : '人'}</small>
          </div>)}</div>}
          {(room.me.role || room.me.word) && room.phase !== 'finished' && <Button icon={<EyeOutlined />} onClick={() => setPrivateOpen(true)}>{game === 'undercover' ? '私密查看我的词语' : '私密查看我的身份'}</Button>}
          {game === 'avalon' ? <GameStage key={room.turn} room={room} user={user} action={action} busy={busy} /> : game === 'undercover' ? <UndercoverStage key={room.turn} room={room} user={user} action={action} busy={busy} /> : game === 'sketch' ? <SketchStage key={room.turn} room={room} user={user} action={action} busy={busy} /> : <UnoStage key={room.turn} room={room} user={user} action={action} busy={busy} />}
        </div>}
      </Card>
      {game === 'avalon' && room.history.length > 0 && <Card className="avalon-history"><Collapse ghost items={[{ key: 'history', label: `旅程记录 · ${room.history.length} 次组队`, children: <div className="stack">{room.history.map((entry, i) => <div key={i} className="avalon-history-entry"><strong>使命 {entry.round + 1} · 第 {i + 1} 次组队 <Tag color={entry.approved ? 'green' : 'default'}>{entry.approved ? '通过' : '未通过'}</Tag></strong>
        <p className="muted">队伍：{entry.team.map(id => room.players.find(p => p.id === id)?.name || '已离开成员').join('、')}</p>
        <VoteResult votes={entry.votes} room={room} /></div>)}</div> }]} /></Card>}
    </>}
    {privateOpen && (room?.me.role || room?.me.word) && <Modal open title="仅自己查看" footer={<Button type="primary" onClick={() => setPrivateOpen(false)}>隐藏秘密</Button>} onCancel={() => setPrivateOpen(false)}>
      {game === 'undercover' ? <div className="avalon-identity"><small>你的词语</small><h2>{room.me.word}</h2><p>不要展示给其他人。你暂时不知道自己是平民还是卧底。</p></div> : <div className={`avalon-identity ${room.me.role.side}`}><small>{room.me.role.side === 'light' ? '光明阵营' : '暗影阵营'}</small><h2>{room.me.role.name}</h2><p>{room.me.role.description}</p>
        {room.me.knowledge.length > 0 && <><strong>{room.me.role.code === 'watcher' ? '先知与迷惑者候选（不区分先后）' : '你知道的暗影成员'}</strong><Space wrap>{room.me.knowledge.map(id => <Tag key={id}>{room.players.find(p => p.id === id)?.name}</Tag>)}</Space></>}
      </div>}
    </Modal>}
  </>;
}
function GameStage({ room, user, action, busy }) {
  const [team, setTeam] = useState([]), [targetId, setTargetId] = useState();
  const leader = room.players.find(p => p.id === room.leaderId);
  const teamNames = room.team.map(id => room.players.find(p => p.id === id)?.name).join('、');
  const name = person => personName(person, user.id);
  const myPlayer = room.players.find(p => p.id === user.id);
  const lastVote = room.history.at(-1), lastMission = room.missions.at(-1);
  return <div className="stack avalon-stage">
    <h3>{room.phase === 'finished' ? '旅程落幕' : room.phase === 'identity' ? '先认识自己的身份' : `${missionNames[room.round]} · ${stages[room.phase]}`}</h3>
    {room.phase === 'identity' && <><p>请先私密查看身份，再确认准备。{room.players.filter(p => p.acknowledged).length}/{room.players.length} 人已确认。</p><Button type="primary" disabled={busy || myPlayer.acknowledged} onClick={() => action('acknowledge')}>{myPlayer.acknowledged ? '等待其他成员确认' : '已了解我的身份'}</Button></>}
    {room.phase === 'team' && <>
      <p>队长：<strong>{leader && name(leader)}</strong> · 本次需要 {room.teamSizes[room.round]} 人</p>
      {room.failThreshold === 2 && <Alert type="info" message="本次使命需至少两张破坏牌才会失败" />}
      <p className="muted">连续否决 {room.rejected}/5 次；五次未通过，暗影获胜。</p>
      {room.leaderId === user.id ? <><Checkbox.Group className="avalon-team-options" value={team} onChange={setTeam} options={room.players.map(p => ({ value: p.id, label: name(p), disabled: busy || (!team.includes(p.id) && team.length >= room.teamSizes[room.round]) }))} />
        <Button type="primary" disabled={busy || team.length !== room.teamSizes[room.round]} onClick={() => action('team', { team })}>提议队伍（{team.length}/{room.teamSizes[room.round]}）</Button></> : <Alert type="info" message="请一起讨论，等待队长提议队伍。" />}
    </>}
    {['vote', 'voteResult', 'mission', 'missionResult'].includes(room.phase) && <div className="avalon-proposed-team"><small className="muted">本次队伍</small><strong>{teamNames}</strong></div>}
    {room.phase === 'vote' && <><p>全员投票：{room.players.filter(p => p.voted).length}/{room.players.length} 人已提交。超过半数赞成才通过。</p>
      {room.me.vote != null ? <Alert type="success" message={`你已投${room.me.vote ? '赞成' : '反对'}，等待其他人。`} /> : <Space><Button type="primary" disabled={busy} onClick={() => action('vote', { value: true }, '赞成这支队伍？')}>赞成</Button><Button disabled={busy} onClick={() => action('vote', { value: false }, '反对这支队伍？')}>反对</Button></Space>}
    </>}
    {room.phase === 'voteResult' && <><Alert type={lastVote.approved ? 'success' : 'warning'} message={lastVote.approved ? '组队通过，准备执行使命' : `组队未通过，连续否决 ${room.rejected} 次`} /><VoteResult votes={lastVote.votes} room={room} /><Button type="primary" disabled={busy} onClick={() => action('advance')}>{lastVote.approved ? '进入使命' : '下一位队长组队'}</Button></>}
    {room.phase === 'mission' && <><p>队员提交任务牌：{room.players.filter(p => p.submitted).length}/{room.team.length} 人。只公布总票数。</p>
      {!room.team.includes(user.id) ? <Alert type="info" message="你不在本次队伍中，请等待队员完成。" /> : room.me.submitted ? <Alert type="success" message="任务牌已提交，等待结算。" /> : <Space><Button type="primary" disabled={busy} onClick={() => action('mission', { value: true }, '提交支持牌？')}>支持使命</Button>
        {room.me.role.side === 'shadow' && <Button danger disabled={busy} onClick={() => action('mission', { value: false }, '提交破坏牌？')}>暗中破坏</Button>}</Space>}
    </>}
    {room.phase === 'missionResult' && <><Alert type={lastMission.success ? 'success' : 'error'} message={`使命${lastMission.success ? '成功' : '失败'} · ${room.team.length - lastMission.fails} 张支持，${lastMission.fails} 张破坏`} /><Button type="primary" disabled={busy} onClick={() => action('advance')}>继续旅程</Button></>}
    {room.phase === 'accusation' && <><Alert type="info" message="三次使命已成功，试探者还有最后一次指认先知的机会。" />
      {room.me.role.code === 'tempter' ? <><Select aria-label="指认先知" placeholder="选择你认为的先知" value={targetId} onChange={setTargetId} options={room.players.filter(p => !room.me.knowledge.includes(p.id) && p.id !== user.id).map(p => ({ value: p.id, label: name(p) }))} /><Button type="primary" disabled={busy || !targetId} onClick={() => action('accuse', { targetId }, '确认最终指认？')}>确认指认</Button></> : <p>请等待试探者作出最终选择。</p>}
    </>}
    {room.phase === 'finished' && <><Alert showIcon type={room.winner ? 'success' : 'warning'} message={room.winner ? `${room.winner === 'light' ? '光明' : '暗影'}阵营获胜` : '本局提前结束'} description={room.reason} />
      <div className="avalon-players">{room.players.map(p => <div key={p.id} className="row-between"><strong>{name(p)}</strong><Tag color={p.role?.side === 'light' ? 'blue' : 'purple'}>{p.role?.name}</Tag></div>)}</div>
      {room.hostId === user.id && <Button type="primary" disabled={busy} onClick={() => action('restart')}>再来一局</Button>}
    </>}
  </div>;
}
function VoteResult({ votes, room }) {
  return <Space wrap className="avalon-public-votes">{Object.entries(votes).map(([id, approved]) => <Tag key={id} color={approved ? 'green' : 'default'}>{room.players.find(p => p.id === Number(id))?.name || '已离开成员'} · {approved ? '赞成' : '反对'}</Tag>)}</Space>;
}
function Rules() {
  return <Collapse ghost className="avalon-rules" items={[{ key: 'rules', label: '怎么玩？查看规则与角色', children: <div className="stack">
    <p>这是以圣经意象创作背景的聚会推理游戏，角色为虚构设定。5–10 人分为光明与暗影阵营，各自在手机上操作，可当面或语音讨论。</p>
    <ol><li>输入房间号加入，全员准备后房主开始。私密查看身份，确认后进入组队。</li><li>队长轮流提议队伍，全员各投一票。赞成超过半数通过；连续五次否决，暗影获胜。</li><li>队员秘密提交任务牌。光明只能支持，暗影可支持或破坏。一张破坏使使命失败；7–10 人的第四次使命需两张破坏。</li><li>三次使命失败，暗影获胜。三次成功后，试探者指认先知；指认正确暗影获胜，否则光明获胜。</li></ol>
    <p><strong>光明：</strong>先知知道暗影成员；守望者知道先知和迷惑者两位候选；同行者通过讨论判断。</p><p><strong>暗影：</strong>试探者负责最终指认；迷惑者干扰守望者；潜伏者协助破坏。暗影成员互相知晓。</p>
    <p className="muted">房主解散会关闭房间；游戏中成员退出会结束本局。切换页面、短暂断线后，可返回这里恢复当前房间。投票与任务牌提交后不可更改。</p>
  </div> }]} />;
}
