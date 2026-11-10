import React, { useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Segmented from 'antd/es/segmented';
import { API, Heading, Load, option, useLoad } from './shared';

const orders = [option('recent', '最近'), option('hot', '最热')];

export function DiscussionPreview({ openDiscussions }) {
  const [sort, setSort] = useState('recent');
  const query = useLoad(sort, () => API.discussionTopics(1, { sort, pageSize: 3 }));
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
          </button>
        </li>)}
      </ul> : <p className="muted topic-preview-empty">暂无话题</p>}</Load>
    </section>
  </Card>;
}
