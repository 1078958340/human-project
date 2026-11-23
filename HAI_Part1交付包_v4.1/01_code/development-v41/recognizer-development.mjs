export const defaults = { minMs: 300, maxMs: 1100, stepMs: 100, maxGapMs: 180,
  minDx: 0.55, threshold: 0.36, margin: 0.08, resetMs: 400, evaluationMs:25, strongDistance:0.08, relativeRatio:0.75 };
const norm = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));

function features(frames) {
  const center = f => [0,5,9,13,17].reduce((p,i)=>[
    p[0]+f.hand[i].x*f.aspect/5, p[1]+f.hand[i].y/5], [0,0]);
  const centers = frames.map(center);
  const scale = frames.map(f=>Math.hypot((f.hand[0].x-f.hand[9].x)*f.aspect,
    f.hand[0].y-f.hand[9].y)).sort((a,b)=>a-b)[Math.floor(frames.length/2)];
  if (scale < 0.015) return null;
  let index = 0;
  const start = frames[0].tMs, end = frames.at(-1).tMs;
  return Array.from({length: 20}, (_,i)=>{
    const time = start + (end-start)*i/19;
    while(index+1 < frames.length-1 && frames[index+1].tMs < time) index++;
    const mix = (time-frames[index].tMs)/(frames[index+1].tMs-frames[index].tMs);
    return centers[index].map((v,j)=>(v+(centers[index+1][j]-v)*mix-centers[0][j])/scale);
  });
}

export function dtw(a,b) {
  let prev = Array(b.length+1).fill(Infinity);
  prev[0]=0;
  for(let i=1;i<=a.length;i++){
    const row = Array(b.length+1).fill(Infinity);
    for(let j=Math.max(1,i-4);j<=Math.min(b.length,i+4);j++)
      row[j] = norm(a[i-1],b[j-1])+Math.min(prev[j],row[j-1],prev[j-1]);
    prev=row;
  }
  return prev[b.length]/a.length;
}

function validFrame(f) {
  return Number.isFinite(f.tMs) && f.aspect>0 && Number.isFinite(f.aspect) &&
    f.hand?.length===21 && f.hand.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
}
function segment(frames, maxGapMs) {
  return Array.isArray(frames) && frames.length>=4 && frames.every((f,i)=>
    validFrame(f) && (!i || (f.tMs>frames[i-1].tMs && f.tMs-frames[i-1].tMs<=maxGapMs)));
}

export function prepareExample(raw, overrides = {}) {
  const settings = {...defaults, ...overrides};
  const valid = raw.filter(validFrame);
  if(valid.length<4) throw new Error('检测到手的画面不足。请把完整手掌放进画面，等待“已检测到手”后再录制。');
  let best=null, bestDx=-Infinity;
  for(let i=0;i<valid.length-3;i++) {
    for(let j=i+3;j<valid.length;j++) {
      const duration=valid[j].tMs-valid[i].tMs;
      if(duration>settings.maxMs) break;
      if(duration<settings.minMs) continue;
      const clip=valid.slice(i,j+1);
      if(!segment(clip,settings.maxGapMs)) break;
      const seq=features(clip);
      if(seq && seq.at(-1)[0]>bestDx){best=clip;bestDx=seq.at(-1)[0];}
    }
  }
  if(!best) throw new Error('手部追踪中断太久，或动作太短。保持手掌完整入镜，用约 0.6–0.8 秒向画面右侧平移。');
  if(bestDx<settings.minDx) throw new Error('没有找到足够的向右位移。请看预览，让整只手从画面左侧移到右侧。');
  return best;
}

export function createRecognizer(profile) {
  if(profile?.version!==1 || !['initial','calibrated'].includes(profile.mode) ||
     !Array.isArray(profile.positives) || !profile.positives.length ||
     (profile.negatives!==undefined && !Array.isArray(profile.negatives))) {
    throw new Error('需要 version:1、mode 和至少一个正例');
  }
  const settings = {...defaults,...profile.settings};
  if(Object.keys(defaults).some(k=>!Number.isFinite(settings[k]) || settings[k]<=0) ||
    settings.maxMs<settings.minMs || settings.maxMs/settings.stepMs>100) throw new Error('参数无效');
  const compile = clips => clips.map(clip=>{
    const seq = segment(clip,settings.maxGapMs) && features(clip);
    if(!seq) throw new Error('示范需包含连续、有效的单手关键点，请缩短到动作本身');
    return seq;
  });
  const positive = compile(profile.positives);
  if(positive.some(seq=>seq.at(-1)[0]<settings.minDx)) throw new Error('正例需在画面中从左向右移动');
  const negative = profile.mode==='calibrated' ? compile(profile.negatives || []) : [];
  let buffer=[], lastTime=-Infinity, locked=false, stillSince=null, lastEval=-Infinity;
  let lastObserved=null, triggerTime=-Infinity, peakX=-Infinity;
  const center=f=>[0,5,9,13,17].reduce((s,k)=>s+f.hand[k].x*f.aspect/5,0);
  function push(frame) {
    if(!Number.isFinite(frame.tMs) || frame.tMs<=lastTime) throw new Error('时间必须严格递增');
    const previous = buffer.at(-1);
    const observed=lastObserved;
    const gap = frame.tMs-lastTime;
    lastTime=frame.tMs;
    lastObserved=frame;
    if(previous && frame.tMs-previous.tMs>settings.maxGapMs) buffer=[];
    if(frame.hand) buffer.push(frame);
    while(buffer.length && buffer[0].tMs<frame.tMs-settings.maxMs-settings.maxGapMs) buffer.shift();
    if(locked){
      const scale=frame.hand ? Math.hypot((frame.hand[0].x-frame.hand[9].x)*frame.aspect,
        frame.hand[0].y-frame.hand[9].y) : 0;
      if(frame.hand)peakX=Math.max(peakX,center(frame));
      const returned=frame.hand && peakX-center(frame)>=0.45*scale;
      const quiet = !frame.hand || (gap<=settings.maxGapMs && observed?.hand &&
        Math.hypot((frame.hand[0].x-observed.hand[0].x)*frame.aspect,
          frame.hand[0].y-observed.hand[0].y)<=0.8*scale*gap/1000);
      stillSince = quiet ? (stillSince ?? frame.tMs) : null;
      if(frame.tMs-triggerTime>=settings.resetMs &&
        (returned || (stillSince!==null && frame.tMs-stillSince>=200))) {
        locked=false; stillSince=null; buffer=[];
      }
      return null;
    }
    if(!frame.hand || frame.tMs-lastEval<settings.evaluationMs) return null;
    lastEval=frame.tMs;
    let best=null, lastStart=-1;
    for(let duration=settings.minMs;duration<=settings.maxMs;duration+=settings.stepMs){
      const start=buffer.findIndex(f=>f.tMs>=frame.tMs-duration-1);
      if(start<0 || start===lastStart) continue;
      lastStart=start;
      const clip=buffer.slice(start);
      if(frame.tMs-clip[0].tMs<settings.minMs || !segment(clip,settings.maxGapMs)) continue;
      const seq=features(clip);
      if(!seq || seq.at(-1)[0]<settings.minDx) continue;
      const pos=Math.min(...positive.map(template=>dtw(seq,template)));
      const neg=negative.length ? Math.min(...negative.map(template=>dtw(seq,template))) : null;
      if(pos<=settings.threshold && (neg===null || (neg-pos>=settings.margin || (neg>1e-6 && pos<=settings.strongDistance && pos<=settings.relativeRatio*neg))) && (!best || pos<best.positiveDistance))
        best={type:'next_page', tMs:frame.tMs, startMs:clip[0].tMs, endMs:frame.tMs,
          positiveDistance:pos, negativeDistance:neg, frames:clip};
    }
    if(best){locked=true;stillSince=null;triggerTime=frame.tMs;peakX=center(frame);buffer=[];}
    return best;
  }
  return {push};
}

export function replay(frames,profile) {
  const recognizer=createRecognizer(profile), events=[];
  for(const frame of frames) {
    const event=recognizer.push(frame);
    if(event) events.push(event);
  }
  return events;
}





