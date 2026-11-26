import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Input from 'antd/es/input';
import InputNumber from 'antd/es/input-number';
import Modal from 'antd/es/modal';
import Select from 'antd/es/select';
import Segmented from 'antd/es/segmented';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import ArrowLeftOutlined from '@ant-design/icons/es/icons/ArrowLeftOutlined';
import ReloadOutlined from '@ant-design/icons/es/icons/ReloadOutlined';
import { API, Heading, Load, personName, useLoad } from './shared';
import PartyGame from './playground/PartyGame';
import GameRecords from './playground/GameRecords';
import Harvest from './playground/Harvest';
import BibleLearning, { learningGames } from './playground/BibleLearning';
import { draw, makeGroups, parseNames, randomInt } from './playground/random.mjs';

const multiplayer = ['avalon', 'undercover', 'uno', 'sketch'];
const tools = [
  ...learningGames,
  { id: 'sketch', icon: '🎨', name: '圣经你画我猜', copy: '画里有故事 · 2–10 人联机猜词', color: 'orange' },
  { id: 'avalon', icon: '🕯️', name: '圣经版阿瓦隆', copy: '守望之旅 · 5–10 人联机推理', color: 'gold' },
  { id: 'undercover', icon: '🕊️', name: '圣经版谁是卧底', copy: '同词异心 · 4–10 人联机猜词', color: 'cyan' },
  { id: 'uno', icon: '🌈', name: '圣经版 UNO', copy: '彩约对局 · 2–10 人联机出牌', color: 'purple' },
  { id: 'draw', icon: '🎟️', name: '抽签', copy: '谁先开始？让签来决定', color: 'blue' },
  { id: 'wheel', icon: '🎡', name: '幸运大转盘', copy: '把选择交给转动的指针', color: 'purple' },
  { id: 'groups', icon: '🧩', name: '随机分组', copy: '打散顺序，认识新同伴', color: 'cyan' },
  { id: 'dice', icon: '🎲', name: '掷骰子', copy: '一到六点，快乐加倍', color: 'green' },
  { id: 'coin', icon: '🪙', name: '抛硬币', copy: '正面还是反面？', color: 'orange' },
];
export default function Playground({ user, openTopic }) {
  const [selected, setSelected] = useState(null);
  const [category, setCategory] = useState('all');
  const header = useRef(null);
  const [stickyTop, setStickyTop] = useState(0);
  const [recordsGame, setRecordsGame] = useState('all');
  function openRecords(game = 'all') { setRecordsGame(game); setSelected('records'); }
  useEffect(() => { window.scrollTo(0, 0); }, [selected]);
  useLayoutEffect(() => {
    if (selected !== null) return;
    const workspaceTop = header.current.closest('.workspace').querySelector('.workspace-top');
    const measure = () => setStickyTop(workspaceTop.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspaceTop);
    return () => observer.disconnect();
  }, [selected]);
  const tool = tools.find(item => item.id === selected);
  if (selected === 'records') return <GameRecords user={user} initialGame={recordsGame} back={() => setSelected(null)} />;
  return <div className="stack playground">
    {tool ? <>
      <Button type="text" className="playground-back" icon={<ArrowLeftOutlined />} onClick={() => setSelected(null)}>返回游乐场</Button>
      {learningGames.some(item => item.id === selected) ? <BibleLearning key={selected} game={selected} user={user} /> : multiplayer.includes(selected) ? <PartyGame key={selected} game={selected} user={user} openGame={setSelected} openRecords={openRecords} /> : <Card>
        <Heading>{tool.icon} {tool.name}</Heading><p className="muted playground-tool-copy">{tool.copy}</p>
        {selected === 'draw' && <Draw user={user} />}{selected === 'wheel' && <Wheel user={user} />}{selected === 'groups' && <Groups user={user} />}
        {(selected === 'dice' || selected === 'coin') && <QuickRandom key={selected} coin={selected === 'coin'} />}
      </Card>}
    </> : <>
      <div ref={header} className="stack playground-controls" style={{ top: stickyTop }}>
        <Card className="playground-welcome"><div className="row-between"><h1>游乐场 <span aria-hidden="true">✦</span></h1><Button onClick={() => openRecords()}>游戏记录</Button></div><p>聚会的小帮手，也是忙碌间的一点小乐趣。</p><Harvest user={user} openTopic={openTopic} /></Card>
        <Segmented className="playground-categories" block aria-label="游乐场分类" value={category} onChange={setCategory} options={[{ value: 'all', label: '全部' }, { value: 'learn', label: '圣经学习' }, { value: 'online', label: '联机游戏' }, { value: 'tools', label: '小工具' }]} />
      </div>
      <div className="playground-grid">{tools.filter(item => category === 'all' || (category === 'learn' ? learningGames.some(g => g.id === item.id) || item.id === 'sketch' : category === 'online' ? multiplayer.includes(item.id) : !learningGames.some(g => g.id === item.id) && !multiplayer.includes(item.id))).map(item => <button type="button" key={item.id} className={`playground-tile playground-${item.color}`} onClick={() => setSelected(item.id)}>
        <span className="playground-tile-icon" aria-hidden="true">{item.icon}</span><strong>{item.name}</strong><span>{item.copy}</span>
        {multiplayer.includes(item.id) ? <Tag color="gold">多人联机</Tag> : learningGames.some(g => g.id === item.id) && <Tag color="green">单人学习</Tag>}
      </button>)}</div>
      <p className="muted playground-footnote">学习进度与禾穗跟随账号保存；小工具在本机运行，联机游戏使用各自账号加入。</p>
    </>}
  </div>;
}
function Names({ value, setValue, disabled, label = '候选名单', placeholder, user, max = 50 }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState([]);
  const people = useLoad(open ? 'playground-people' : null, API.playgroundPeople);
  const list = people.data || [];
  const counts = new Map();
  list.forEach(person => counts.set(person.name, (counts.get(person.name) || 0) + 1));
  const names = new Map(list.map(person => [person.id, personName({ ...person, name: counts.get(person.name) > 1 ? `${person.name}（#${person.id}）` : person.name }, user.id)]));
  return <div className="stack playground-names"><label htmlFor="playground-names">{label}<small className="muted">每行一项，不重复，最多 80 字</small></label>
    <Button disabled={disabled} onClick={() => { setSelected([]); setOpen(true); }}>从员工选择</Button>
    <Input.TextArea id="playground-names" value={value} disabled={disabled} onChange={e => setValue(e.target.value)} rows={5} maxLength={4100} placeholder={placeholder || '小麦\n葡萄\n橄榄\n无花果'} />
    {open && <Modal open title="从员工选择" onCancel={() => setOpen(false)} okText="使用所选名单" okButtonProps={{ disabled: !selected.length }} onOk={() => { setValue(selected.map(id => names.get(id)).join('\n')); setOpen(false); }}>
      <div className="stack"><p className="muted">最多选择 {max} 人，确认后替换当前名单。</p><Load query={people}>{() => <>
        <Select aria-label="选择员工" mode="multiple" showSearch optionFilterProp="label" maxCount={max} maxTagCount="responsive" style={{ width: '100%' }} value={selected} onChange={setSelected} placeholder="搜索姓名或花名" options={list.map(p => ({ value: p.id, label: names.get(p.id) }))} />
        <Space><Button size="small" disabled={list.length > max} onClick={() => setSelected(list.map(p => p.id))}>全选</Button><Button size="small" onClick={() => setSelected([])}>清空</Button><small className="muted">已选 {selected.length} 人{list.length > max ? ` · 员工超过 ${max} 人，请分批选择` : ''}</small></Space>
      </>}</Load></div>
    </Modal>}
  </div>;
}
function Draw({ user }) {
  const [text, setText] = useState('小麦\n葡萄\n橄榄\n无花果');
  const [count, setCount] = useState(1), [remove, setRemove] = useState(false), [result, setResult] = useState([]);
  const { message } = App.useApp();
  function pick() {
    try {
      const names = parseNames(text, { min: 1 }), picked = draw(names, count);
      setResult(picked);
      if (remove) setText(names.filter(name => !picked.includes(name)).join('\n'));
    } catch (e) { message.warning(e.message); }
  }
  return <div className="stack"><Names user={user} value={text} setValue={setText} />
    <Space wrap><label htmlFor="draw-count">抽取数量</label><InputNumber id="draw-count" min={1} max={50} precision={0} value={count} onChange={setCount} /><Checkbox checked={remove} onChange={e => setRemove(e.target.checked)}>抽中后移出名单</Checkbox></Space>
    <Button type="primary" onClick={pick}>抽一签</Button>
    <div className="playground-result" role="status" aria-live="polite">{result.length ? <><small>这次抽中</small><strong>{result.join('、')}</strong></> : <span className="muted">下一位幸运儿会是谁？</span>}</div>
  </div>;
}
const wheelColors = ['#dce8ff', '#eadfff', '#d7f0e7', '#ffebc9', '#ffdedd', '#daf1fa'];
function Wheel({ user }) {
  const [text, setText] = useState('唱一首歌\n分享好消息\n讲个笑话\n再转一次');
  const [rotation, setRotation] = useState(0), [spinning, setSpinning] = useState(false), [result, setResult] = useState('');
  const timer = useRef();
  const { message } = App.useApp();
  useEffect(() => () => clearTimeout(timer.current), []);
  const names = text.split(/\r?\n/).map(name => name.trim()).filter(Boolean).slice(0, 12);
  const step = 360 / Math.max(1, names.length);
  function spin() {
    try {
      const options = parseNames(text, { max: 12 }), index = randomInt(options.length);
      setSpinning(true); setResult('');
      setRotation(previous => previous + (360 - (previous % 360)) + 1440 - (index + 0.5) * 360 / options.length);
      timer.current = setTimeout(() => { setResult(options[index]); setSpinning(false); }, 1900);
    } catch (e) { message.warning(e.message); }
  }
  return <div className="stack"><Names user={user} max={12} label="转盘选项（2–12 项）" value={text} disabled={spinning} setValue={setText} />
    <div className="wheel-area" aria-hidden="true"><span className="wheel-pointer">▼</span><div className="lucky-wheel" style={{ transform: `rotate(${rotation}deg)`, background: names.length ? `conic-gradient(${names.map((_, i) => `${wheelColors[i % wheelColors.length]} ${i * step}deg ${(i + 1) * step}deg`).join(',')})` : '#eef2f8' }}>
      {names.map((name, i) => <span className="wheel-label" key={i} style={{ transform: `rotate(${(i + 0.5) * step}deg) translateY(-90px) rotate(-90deg)` }}>{name.slice(0, 8)}</span>)}
    </div><span className="wheel-center">✦</span></div>
    <Button type="primary" block loading={spinning} onClick={spin}>转起来</Button>
    <div role="status" className="playground-result"><small>{spinning ? '幸运正在转动…' : '指针的选择'}</small><strong>{result || '期待下一次惊喜'}</strong></div>
  </div>;
}
function Groups({ user }) {
  const [text, setText] = useState('小麦\n葡萄\n橄榄\n无花果\n石榴\n百合'), [count, setCount] = useState(2), [groups, setGroups] = useState([]);
  const { message } = App.useApp();
  return <div className="stack"><Names user={user} label="参与人员（2–50 人）" value={text} setValue={setText} />
    <Space><label htmlFor="group-count">分成几组</label><InputNumber id="group-count" min={2} max={50} precision={0} value={count} onChange={setCount} /></Space>
    <Button type="primary" onClick={() => { try { setGroups(makeGroups(parseNames(text), count)); } catch (e) { message.warning(e.message); } }}>随机分组</Button>
    <div className="playground-groups" aria-live="polite">{groups.map((group, i) => <div className="playground-group" key={i}><strong>第 {i + 1} 组 <small className="muted">{group.length} 人</small></strong><Space wrap>{group.map(name => <Tag key={name}>{name}</Tag>)}</Space></div>)}</div>
  </div>;
}
function QuickRandom({ coin }) {
  const [count, setCount] = useState(1), [values, setValues] = useState([]), [round, setRound] = useState(0);
  function roll() { setValues(Array.from({ length: coin ? 1 : count }, () => randomInt(coin ? 2 : 6))); setRound(v => v + 1); }
  return <div className="stack">
    {!coin && <Space><label htmlFor="dice-count">骰子数量</label><InputNumber id="dice-count" min={1} max={6} precision={0} value={count} onChange={v => setCount(v || 1)} /></Space>}
    <div className="quick-random-result" key={round} aria-hidden="true">{values.length ? values.map((v, i) => <span key={i} className={coin ? 'playground-coin' : 'playground-die'}>{coin ? v ? '正' : '反' : ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][v]}</span>) : <span>{coin ? '🪙' : '🎲'}</span>}</div>
    <div className="playground-result" role="status">{values.length ? coin ? `第 ${round} 次：${values[0] ? '正面' : '反面'}` : `点数 ${values.map(v => v + 1).join('、')} · 合计 ${values.reduce((sum, v) => sum + v + 1, 0)} 点` : '点击按钮，试试手气'}</div>
    <Button type="primary" block icon={<ReloadOutlined />} onClick={roll}>{coin ? '抛一次' : '掷骰子'}</Button>
  </div>;
}
