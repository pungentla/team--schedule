import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Collapse from 'antd/es/collapse';
import Modal from 'antd/es/modal';
import Pagination from 'antd/es/pagination';
import Tag from 'antd/es/tag';
import Wish from './Wish';
import { API, Blank, Load, timeText, useLoad, usePageLoad } from '../shared';
export function RewardReceipt({ reward }) {
  if (!reward) return null;
  return <Alert className="harvest-receipt" showIcon type={reward.amount ? 'success' : 'info'} message={reward.amount ? `本次收获 +${reward.amount} 禾穗` : '本次未获得禾穗'} description={<div><span>{reward.reason}</span><strong className="harvest-receipt-total">当前共 {reward.balance} 禾穗</strong></div>} />;
}
export default function Harvest({ user, openTopic }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(1), [wishing, setWishing] = useState(false);
  const query = useLoad(`harvest-${user.id}`, () => API.harvest());
  return <><div className="harvest-summary"><div><span className="playground-eyebrow">我的收获</span><div className="harvest-balance"><span aria-hidden="true">🌾</span><strong>{query.data?.balance ?? '—'}</strong><span>禾穗</span></div></div><div className="inline harvest-actions"><Button type="primary" className="wish-launch" onClick={() => setWishing(true)}>🌠 许愿</Button><Button onClick={() => { setPage(1); setOpen(true); }}>收获记录</Button></div>{query.error && <Button size="small" onClick={query.refresh}>重新获取禾穗</Button>}</div>
    {wishing && <Wish balance={query.data?.balance ?? 0} close={() => setWishing(false)} saved={query.refresh} openTopic={openTopic} />}
    {open && <Modal open title="我的禾穗" width={600} onCancel={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>关闭</Button>}><HarvestDetails page={page} setPage={setPage} openTopic={id => { setOpen(false); openTopic(id); }} /></Modal>}
  </>;
}
function HarvestDetails({ page, setPage, openTopic }) {
  const query = usePageLoad(page, () => API.harvest(page));
  return <div className="stack"><Load query={query}>{data => <><div className="harvest-balance"><span aria-hidden="true">🌾</span><strong>{data.balance}</strong><span>禾穗</span></div><div className="harvest-ledger">{data.items.length ? data.items.map(item => <div className="harvest-entry" key={item.id}><div className="row-between"><strong>{item.gameName}</strong><Tag color={item.amount > 0 ? 'gold' : 'purple'}>{item.amount > 0 ? '+' : ''}{item.amount} 禾穗</Tag></div><p>{item.reason}</p><div className="row-between"><small className="muted">{timeText(item.createdAt)}</small>{item.topicId && <Button type="link" size="small" onClick={() => openTopic(item.topicId)}>查看许愿话题 ›</Button>}</div></div>) : <Blank>还没有收获，完成一场游戏试试吧</Blank>}</div><Pagination current={page} pageSize={20} total={data.total} showSizeChanger={false} hideOnSinglePage onChange={setPage} /></>}</Load>
    <Collapse items={[{ key: 'rules', label: '禾穗怎样获得？', children: <div className="stack"><p>学习游戏：同一关每天首次完成获得 2 禾穗；本轮成绩每满 10 分再获 1 禾穗；满分额外获得 3 禾穗。按北京时间每日 00:00 重置；当天重玩仅刷新成绩，不补发禾穗。</p><p>联机游戏：完整结束后，每人获得 5 禾穗，获胜者额外获得 10 禾穗；你画我猜的本局成绩每满 100 分，再获得 1 禾穗。并列优胜同样获得获胜奖励。</p><p>提前退出、解散或超时结束不发放。抽签、转盘、分组、骰子和硬币为小工具，不结算禾穗。从本功能启用后的新游戏开始累计，历史游戏不补发。</p><p>每 30 禾穗可以许愿一次，确认后自动在互动区发布许愿话题；愿望不保证实现，消耗的禾穗不退回。</p><p>禾穗跟随账号保存，刷新、重新打开结果页或删除游戏记录，都不会重复发放或扣除已有收获。</p></div> }]} />
  </div>;
}
