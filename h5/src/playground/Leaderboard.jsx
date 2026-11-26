import React, { useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Pagination from 'antd/es/pagination';
import Segmented from 'antd/es/segmented';
import ArrowLeftOutlined from '@ant-design/icons/es/icons/ArrowLeftOutlined';
import TrophyOutlined from '@ant-design/icons/es/icons/TrophyOutlined';
import { API, Blank, Heading, Load, personName, usePageLoad } from '../shared';

export default function Leaderboard({ user, back }) {
  const [sort, setSort] = useState('balance'), [page, setPage] = useState(1);
  const query = usePageLoad(`playground-leaderboard-${user.id}-${sort}-${page}`, () => API.playgroundLeaderboard({ sort, page }));
  const wishes = sort === 'wishes', unit = wishes ? '次许愿' : '禾穗';
  const score = person => wishes ? person.wishCount : person.balance;
  return <div className="stack playground-leaderboard">
    <Button className="playground-back" type="text" icon={<ArrowLeftOutlined />} onClick={back}>返回游乐场</Button>
    <Card className="leaderboard-heading"><Heading><TrophyOutlined /> 游乐场排行榜</Heading><p className="muted">一起积攒收获，让心愿慢慢发芽。</p><Segmented block aria-label="排行榜类型" value={sort} onChange={value => { setSort(value); setPage(1); }} options={[{ value: 'balance', label: '🌾 禾穗榜' }, { value: 'wishes', label: '🌠 许愿榜' }]} /><p className="leaderboard-rule muted">{wishes ? '按累计许愿次数排名，删除话题仍保留次数。' : '按当前禾穗余额排名，许愿消耗后余额会减少。'}</p></Card>
    <Load query={query}>{data => <>
      {data.me && <div className="leaderboard-mine"><div><span>我的排名</span><strong>第 {data.me.rank} 名</strong></div><div><b>{score(data.me)}</b><span>{unit}</span></div></div>}
      {!data.items.length ? <Card><Blank>暂无排行数据</Blank></Card> : <Card className="leaderboard-results">
        {page === 1 && <div className="leaderboard-podium">{data.items.slice(0, 3).map(person => <div key={person.id} className={`leaderboard-medalist leaderboard-place-${person.rank}${person.id === user.id ? ' leaderboard-self' : ''}`}>
          <span className="leaderboard-medal" role="img" aria-label={`第 ${person.rank} 名`}>{['🥇', '🥈', '🥉'][person.rank - 1]}</span><strong className="leaderboard-name">{personName(person, user.id)}</strong><div className="leaderboard-score"><b>{score(person)}</b><span>{unit}</span></div>
        </div>)}</div>}
        <ol className="leaderboard-list" start={page === 1 ? 4 : (page - 1) * 20 + 1}>{(page === 1 ? data.items.slice(3) : data.items).map(person => <li key={person.id} className={person.id === user.id ? 'leaderboard-self' : ''}><span className="leaderboard-rank" aria-label={`第 ${person.rank} 名`}>{person.rank}</span><strong className="leaderboard-name">{personName(person, user.id)}</strong><div className="leaderboard-score"><b>{score(person)}</b><span>{unit}</span></div></li>)}</ol>
      </Card>}
      <Pagination current={page} pageSize={20} total={data.total} showSizeChanger={false} hideOnSinglePage onChange={value => { setPage(value); window.scrollTo(0, 0); }} />
    </>}</Load>
  </div>;
}
