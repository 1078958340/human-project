import {createTracker,watchVideo,scanVideo} from '../tracker.mjs?v=4';
import {createRecognizer,prepareExample,replay} from './recognizer-development.mjs?v=41';

const el=id=>document.getElementById(id);
const video=el('video');
let profile={version:1,coordinateSystem:'body-right-v1',mode:'initial',positives:[],negatives:[]};
let tracker,cancel,stream,url,recording=null,recognizer=null,frames=[],events=[],busy=false,sourceMode;
function status(message){el('status').textContent=message;}
function reset(){
  recognizer=profile.positives.length?createRecognizer(profile):null;
  frames=[];events=[];recording=null;
  render();
}
function render(){
  el('state').textContent='模式 '+profile.mode+' · 正例 '+profile.positives.length+
    ' · 反例 '+profile.negatives.length+' · 已触发 '+events.length+' 次';
  el('events').textContent=events.slice(-10).map(e=>
    (e.tMs/1000).toFixed(2)+' 秒 → 下一页（DTW '+e.positiveDistance.toFixed(3)+'）').join('\n');
}
function close(){
  cancel?.(); tracker?.close(); stream?.getTracks().forEach(t=>t.stop());
  video.pause(); video.srcObject=null; video.removeAttribute('src');video.load();
  if(url) URL.revokeObjectURL(url);
  tracker=cancel=stream=url=sourceMode=undefined;
  recording=null;
}
function onFrame(frame){
  frames.push(frame);
  el('tracking').textContent=frame.hand?'已检测到右手 · 请保持完整手掌入镜':'暂未确认右手 · 请张开右手掌并保持入镜';
  if(recording){recording.push(frame);return;}
  const event=recognizer?.push(frame);
  if(event){events.push(event);render();}
}
async function start(file){
  if(busy)return;
  busy=true;
  el('camera').disabled=el('stop').disabled=el('file').disabled=true;
  try{
    close();reset();status('正在加载手部识别模型…');
    const sourceMirrored=Boolean(file && el('mirrored').checked);
    tracker=await createTracker({sourceMirrored});
    video.style.transform=sourceMirrored?'none':'scaleX(-1)';
    if(file){
      if(!recognizer)throw new Error('请先录制正例或加载配置');
      url=URL.createObjectURL(file);video.src=url;
    }else{
      stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480},audio:false});
      video.srcObject=stream;
    }
    sourceMode=file?'video':'camera';
    if(file){
      status('正在逐帧分析录像…');
      cancel=scanVideo(video,tracker,onFrame,
        (done,total)=>status('正在逐帧分析录像 '+Math.round(done/total*100)+'%'),
        ()=>{close();status('录像分析结束，可导出记录。');},
        error=>{close();status(error.message);});
    }else{
      cancel=watchVideo(video,tracker,onFrame,error=>{close();status(error.message);});
      await video.play();
      status('摄像头已启动。可录制正例或直接试翻页。');
    }
  }catch(error){close();status(error.message);}
  finally{busy=false;el('camera').disabled=el('stop').disabled=el('file').disabled=false;}
}
function install(next){
  const ready=next.positives.length?createRecognizer(next):null;
  profile=next;recognizer=ready;frames=[];events=[];render();
}
function download(name,data){
  const path=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=path;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(path),1000);
}
el('camera').onclick=()=>start();
el('file').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file)start(file);};
el('stop').onclick=()=>{close();status('已停止，可导出记录。');};
el('record').onclick=()=>{
  if(sourceMode!=='camera' || recording)return status('请启动摄像头，再录制新示范。');
  if(!frames.at(-1)?.hand)return status('请先等页面显示“已检测到右手”，再点击录制。');
  recording=[];status('正在录制。右手向身体右侧滑动一次，停住后点击结束。');
};
el('finish').onclick=()=>{
  if(!recording)return;
  const clip=recording;recording=null;
  try{
    const example=prepareExample(clip,profile.settings);
    install({...profile,positives:[...profile.positives,example]});
    status('正例已保存（选取 '+Math.round(example.at(-1).tMs-example[0].tMs)+' 毫秒动作）。建议录制 3–5 个。');
  }catch(error){
    const count=clip.filter(f=>f.hand).length;
    status(error.message+' 本次检测到手 '+count+'/'+clip.length+' 帧。');
  }
};
el('undo').onclick=()=>{if(!recording)install({...profile,positives:profile.positives.slice(0,-1)});};
el('load').onclick=()=>el('json').click();
el('json').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';
  if(!file||busy)return;
  try{
    const next=JSON.parse(await file.text());
    if(next.coordinateSystem!=='body-right-v1')throw new Error('此配置使用旧版画面方向。请刷新后按身体右侧方向重新录制并导出配置。');
    createRecognizer(next);
    close();install(next);status('配置已加载，可启动摄像头或选择录像。');
  }catch(error){status(error.message);}
};
el('save').onclick=()=>{if(profile.positives.length)download('gesture-profile.json',profile);};
el('log').onclick=()=>download('gesture-run.json',{version:1,engineVersion:'dtw-v4.1-development',
  trackerVersion:'right-hand-v4',mode:profile.mode,profile,frames,events});
el('replay').onclick=()=>el('trajectory').click();
el('trajectory').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';
  if(!file || busy)return;
  try {
    if(!profile.positives.length)throw new Error('先加载个人配置');
    const data=JSON.parse(await file.text());
    if(data.trackerVersion!=='right-hand-v4')throw new Error('请选择修订版4的右手轨迹文件');
    const results=replay(data.frames,profile);
    close();frames=data.frames;events=results;render();
    status('同一轨迹回放完成，可导出结果。');
  }catch(error){status(error.message);}
};
render();
