import React, { useEffect, useRef, useState } from 'react';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import QRCode from 'antd/es/qr-code';
import Tabs from 'antd/es/tabs';
import { Load, useLoad } from './shared';
import { scheduleLink, scheduleLines } from './scheduleSharing.mjs';

async function poster(lines, qr) {
  await document.fonts.ready;
  const width=720,pad=36,canvas=document.createElement('canvas'),context=canvas.getContext('2d'),draw=[];
  let y=36;
  for (const {text,kind} of [{text:'时禾 · 传3:2 栽种有时',kind:'heading'},...lines]) {
    const size=kind==='title'?34:kind==='heading'?28:kind==='note'?22:26;
    const color=kind==='note'?'#64748b':kind==='heading'?'#2e59ae':'#1f2a3c';
    const font=`${['title','heading','work'].includes(kind)?700:400} ${size}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
    context.font=font;
    if (kind==='heading'||kind==='work'||kind==='title') y+=14;
    let line=''; const wrapped=[];
    for (const character of text) {
      if (character==='\n'||context.measureText(line+character).width>width-pad*2) {wrapped.push(line);line='';}
      if(character!=='\n') line+=character;
    }
    wrapped.push(line);
    const top=y;
    draw.push(()=>{context.font=font;context.fillStyle=color;wrapped.forEach((value,i)=>context.fillText(value,pad,top+i*size*1.5));});
    y+=wrapped.length*size*1.5+8;
  }
  const qrTop=y+20,height=qrTop+180+pad;
  if(height>4096) throw new Error('当天安排较多，请使用图文链接分享，避免图片文字过小');
  canvas.width=width*2;canvas.height=Math.ceil(height*2);context.scale(2,2);
  context.fillStyle='#fff';context.fillRect(0,0,width,height);context.textBaseline='top';draw.forEach(paint=>paint());
  context.fillStyle='#e3e9f3';context.fillRect(pad,y,width-pad*2,1);
  context.imageSmoothingEnabled=false;context.drawImage(qr,width-pad-160,qrTop,160,160);
  context.fillStyle='#2e59ae';context.font='700 26px system-ui, sans-serif';context.fillText('扫码查看最新安排',pad,qrTop+34);
  context.fillStyle='#64748b';context.font='21px system-ui, sans-serif';context.fillText('登录时禾后查看',pad,qrTop+84);context.fillText('图片为分享时的快照',pad,qrTop+120);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('生成图片失败，请重试');
  return new File([blob],`时禾排班-${lines[0].text.slice(0,10)}.png`,{type:'image/png'});
}
export default function ScheduleShare({ date, day, period, close }) {
  const {message}=App.useApp(),input=useRef(null),[tab,setTab]=useState('link');
  const url=scheduleLink(window.location.href,date,period?.id),lines=scheduleLines(date,day,period?.name);
  const text=`【时禾 · 排班安排】\n${lines.map(l=>l.text).join('\n')}\n${url}`;
  async function copy() {try{await navigator.clipboard.writeText(text);message.success('图文链接已复制');}catch{input.current?.focus({cursor:'all'});message.info('请复制选中的图文链接');}}
  async function share(data) {try{await navigator.share(data);}catch(e){if(e.name!=='AbortError')message.info('可复制链接或保存图片后分享');}}
  return <Modal open width={520} title={<span className="inline">分享排班<small className="muted" style={{fontWeight:400}}>注意信息安全</small></span>} onCancel={close} footer={null}>
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key:'link',label:'图文链接',children:<div className="stack"><Input.TextArea ref={input} readOnly aria-label="排班分享文字" value={text} autoSize={{minRows:4,maxRows:9}}/><div className="inline"><Button type="primary" onClick={copy}>复制图文链接</Button>{navigator.share&&<Button onClick={()=>share({text})}>系统分享</Button>}</div><small className="muted">登录后打开对应日期，查看最新生效安排。</small></div>},
      {key:'image',label:'分享图',children:tab==='image'&&<SchedulePoster lines={lines} url={url} share={share}/>},
    ]}/>
  </Modal>;
}
function SchedulePoster({lines,url,share}) {
  const qr=useRef(null),[preview,setPreview]=useState(null);
  const query=useLoad(url,()=>{const code=qr.current?.querySelector('canvas');if(!code)throw new Error('二维码生成失败，请重试');return poster(lines,code);});
  useEffect(()=>{if(!query.data)return;const src=URL.createObjectURL(query.data);setPreview({src,file:query.data});return()=>URL.revokeObjectURL(src);},[query.data]);
  return <div className="stack"><div hidden ref={qr}><QRCode value={url} size={320} bordered={false} bgColor="#fff" color="#111"/></div><Load query={query}>{file=>preview?.file===file&&<><div className="topic-share-image"><img src={preview.src} alt="当天生效排班和二维码分享图"/></div><div className="inline"><Button type="primary" href={preview.src} download={file.name}>保存图片</Button>{navigator.canShare?.({files:[file]})&&<Button onClick={()=>share({files:[file]})}>系统分享</Button>}</div><small className="muted">长按可保存图片，扫码查看最新安排。</small></>}</Load></div>;
}
