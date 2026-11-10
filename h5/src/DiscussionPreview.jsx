import React, { useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Segmented from 'antd/es/segmented';
import { API, Heading, Load, option, useLoad } from './shared';

const orders = [option('recent', '最近'), option('hot', '最热')];

export function TopicHeat({ rank }) {
  if (!rank) return null;
  const label = `热门第 ${rank} 名`;
  return <span className="topic-hottest" role="img" aria-label={label} title={label}>{'🔥'.repeat(4 - rank)}</span>;
}

export function DiscussionPreview({ openDiscussions, hotTopicsQuery, hotTopicRanks }) {
  const [sort, setSort] = useState('recent');
  const recentQuery = useLoad(sort === 'recent' ? sort : null, () => API.discussionTopics(1, { sort: 'recent', pageSize: 3 }));
  const query = sort === 'hot' ? hotTopicsQuery : recentQuery;
  return <Card size="small">
    <section aria-label="互动区话题">
      <div className="inline topic-preview-heading">
        <Heading>互动区</Heading>
        <Segmented size="small" value={sort} onChange={setSort} options={orders} />
        <Button className="topic-preview-more" type="link" onClick={() => openDiscussions()}>更多话题 ›</Button>
      </div>
      <Load query={query}>{({ items }) => items.length ? <ul className="topic-preview-list">
        {items.map(topic => <li key={topic.id}>
          <button type="button" onClick={() => openDiscussions(topic.id)}>
            <span>{topic.title}</span><small>{topic.likeCount ?? 0} 赞 · {topic.replyCount} 回复</small>
            <TopicHeat rank={hotTopicRanks.get(topic.id)} />
          </button>
        </li>)}
      </ul> : <p className="muted topic-preview-empty">暂无话题</p>}</Load>
    </section>
  </Card>;
}
