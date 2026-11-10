import React, { useEffect, useRef, useState } from 'react';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import QRCode from 'antd/es/qr-code';
import Tabs from 'antd/es/tabs';
import { API, Load, discussionName, timeText, useLoad } from './shared';

const fontFamily = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
const width = 720;
const inset = 36;
const textWidth = width - inset * 2;
const qrSize = 144;
const exportScale = 2;
const maxCanvasHeight = 4096;

function excerpt(value, maxLength) {
  const characters = Array.from(value);
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join('').trimEnd()}…` : value;
}

function wrapText(context, value, maxLines) {
  const lines = [];
  paragraphs: for (const paragraph of value.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (context.measureText(line + character).width > textWidth) {
        lines.push(line);
        if (lines.length > maxLines) break paragraphs;
        line = '';
      }
      line += character;
    }
    lines.push(line);
    if (lines.length > maxLines) break;
  }
  if (lines.length <= maxLines) return lines;
  const result = lines.slice(0, maxLines);
  const last = Array.from(result.at(-1));
  while (context.measureText(`${last.join('')}…`).width > textWidth) last.pop();
  result[result.length - 1] = `${last.join('').trimEnd()}…`;
  return result;
}

async function renderPoster(topic, category, replies, images, qr) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  const context = canvas.getContext('2d');
  const draw = [];
  let y = inset;

  function addText(value, size, { color = '#1f2a3c', weight = 400, maxLines = 1 } = {}) {
    const font = `${weight} ${size}px ${fontFamily}`;
    const lineHeight = Math.ceil(size * 1.4);
    context.font = font;
    const lines = wrapText(context, value, maxLines);
    const top = y;
    draw.push(() => {
      context.font = font;
      context.fillStyle = color;
      lines.forEach((line, index) => context.fillText(line, inset, top + index * lineHeight));
    });
    y += lines.length * lineHeight;
  }

  addText(`时禾 · ${category}${topic.anonymous ? ' · 匿名' : ''}`, 24, { color: '#2e59ae', weight: 700 });
  y += 12;
  addText(topic.title, 40, { weight: 700, maxLines: 4 });
  addText(`${discussionName(topic)} · ${timeText(topic.createdAt)}`, 22, { color: '#58677e' });
  y += 16;
  if (topic.content) addText(topic.content, 28, { maxLines: 12 });
  if (topic.articleUrl) addText(topic.articleUrl, 22, { color: '#2e59ae', maxLines: 2 });
  for (const option of topic.poll?.options ?? topic.pollOptions ?? []) addText(`○ ${option.label}`, 25, { maxLines: 3 });

  if (images.length) {
    const top = y + 12;
    const side = (textWidth - (images.length - 1) * 12) / images.length;
    const height = 190;
    draw.push(() => images.forEach((image, index) => {
      const left = inset + index * (side + 12);
      context.fillStyle = '#f2f5f9';
      context.fillRect(left, top, side, height);
      const scale = Math.min(side / image.naturalWidth, height / image.naturalHeight);
      const imageWidth = image.naturalWidth * scale;
      const imageHeight = image.naturalHeight * scale;
      context.drawImage(image, left + (side - imageWidth) / 2, top + (height - imageHeight) / 2, imageWidth, imageHeight);
    }));
    y = top + height;
  }

  if (replies.length) {
    y += 24;
    addText('话题评论', 28, { weight: 700 });
    for (const reply of replies) {
      y += 12;
      const author = discussionName(reply, topic.anonymous);
      addText(`${author} · ${timeText(reply.createdAt)}`, 21, { color: '#58677e' });
      addText(reply.content, 25, { maxLines: 4 });
    }
  }

  y += 28;
  const qrTop = y + 12;
  draw.push(() => {
    context.fillStyle = '#dce4ef';
    context.fillRect(inset, y, textWidth, 2);
    context.imageSmoothingEnabled = false;
    context.drawImage(qr, width - inset - qrSize - 12, qrTop + 12, qrSize, qrSize);
  });
  const height = qrTop + qrSize + 24 + inset;
  const scale = Math.min(exportScale, maxCanvasHeight / height);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.imageSmoothingQuality = 'high';
  context.textBaseline = 'top';
  draw.forEach(paint => paint());
  context.fillStyle = '#2e59ae';
  context.font = `700 28px ${fontFamily}`;
  context.fillText('扫码查看完整话题', inset, qrTop + 42);
  context.fillStyle = '#58677e';
  context.font = `22px ${fontFamily}`;
  context.fillText('登录时禾后查看', inset, qrTop + 90);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('生成分享图失败，请重试');
  return new File([blob], '时禾话题.png', { type: 'image/png' });
}

export function TopicShare({ topic, category, close }) {
  const { message } = App.useApp();
  const textInput = useRef(null);
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('topic', topic.id);
  const summary = topic.content.trim() || (topic.category === 'poll' ? '邀请你参与投票' : category);
  const text = `【时禾 · ${category}】${topic.title}\n${excerpt(summary, 120)}\n${url.href}`;
  const [tab, setTab] = useState('link');

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      message.success('图文链接已复制');
    } catch {
      textInput.current?.focus({ cursor: 'all' });
      message.info('请复制选中的图文链接');
    }
  }

  async function share(data, fallback) {
    try {
      await navigator.share(data);
    } catch (error) {
      if (error.name !== 'AbortError') message.info(fallback);
    }
  }

  return <Modal open title={
    <span className="inline">
      <span>分享话题</span>
      <small className="muted" style={{ fontWeight: 400 }}>注意信息安全</small>
    </span>
  } onCancel={close} footer={null} width={520}>
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'link', label: '图文链接', children: <div className="stack">
        <Input.TextArea ref={textInput} readOnly aria-label="分享文字" value={text} autoSize={{ minRows: 3, maxRows: 6 }} />
        <div className="inline">
          <Button type="primary" onClick={copyText}>复制图文链接</Button>
          {navigator.share && <Button onClick={() => share({ text }, '可复制图文链接后分享')}>系统分享</Button>}
        </div>
      </div> },
      { key: 'image', label: '分享图', children: tab === 'image' && <SharePoster topic={topic} category={category} url={url.href} share={share} /> },
    ]} />
  </Modal>;
}

function SharePoster({ topic, category, url, share }) {
  const qr = useRef(null);
  const [preview, setPreview] = useState(null);
  const query = useLoad(topic.id, async () => {
    const code = qr.current?.querySelector('canvas');
    if (!code) throw new Error('二维码生成失败，请重试');
    const [{ items }, attachments] = await Promise.all([
      API.topicReplies(topic.id, 1),
      topic.imageCount ? API.topicImages(topic.id) : [],
    ]);
    const images = await Promise.all(attachments.map(async ({ src }) => {
      const image = new window.Image();
      image.src = src;
      await image.decode();
      return image;
    }));
    return renderPoster(topic, category, items.slice(0, 5), images, code);
  });
  useEffect(() => {
    if (!query.data) return;
    const src = URL.createObjectURL(query.data);
    setPreview({ src, file: query.data });
    return () => URL.revokeObjectURL(src);
  }, [query.data]);

  return <div className="stack">
    <div hidden ref={qr}><QRCode value={url} size={qrSize * exportScale} bordered={false} bgColor="#ffffff" color="#111111" /></div>
    <Load query={query}>{file => {
      if (preview?.file !== file) return null;
      const data = { files: [file] };
      return <>
        <div className="topic-share-image"><img src={preview.src} alt="话题正文、评论和二维码分享图" /></div>
        <div className="inline">
          <Button type="primary" href={preview.src} download={file.name}>保存图片</Button>
          {navigator.canShare?.(data) && <Button onClick={() => share(data, '可保存图片后分享')}>系统分享</Button>}
        </div>
        <small className="muted">长按可保存图片，扫码可打开话题。</small>
      </>;
    }}</Load>
  </div>;
}
