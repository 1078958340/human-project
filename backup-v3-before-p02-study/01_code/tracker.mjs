import {bodyCoordinates} from './coordinates.mjs?v=4';
import {selectRightHand, selectSingleHand} from './hand-selection.mjs?v=5';

export const singleHandTrackerVersion = 'single-hand-v5';

export async function createTracker({sourceMirrored = false, handMode = 'right'} = {}) {
  if (handMode !== 'right' && handMode !== 'single') throw new Error('无效的手部追踪模式。');
  const single = handMode === 'single';
  const {FilesetResolver,HandLandmarker}=await import('./vendor/vision_bundle.mjs');
  const files=await FilesetResolver.forVisionTasks(new URL('./vendor/wasm',import.meta.url).href);
  const detector=await HandLandmarker.createFromOptions(files,{
    baseOptions:{modelAssetPath:new URL('./vendor/hand_landmarker.task',import.meta.url).href},runningMode:'VIDEO',numHands:2,
  });
  let previous=-Infinity;
  return {
    read(video,tMs){
      if(tMs<=previous) throw new Error('每个视频源需新建追踪器，时间必须递增');
      const result=detector.detectForVideo(video,tMs);
      previous=tMs;
      const handedness=result.handedness ?? result.handednesses;
      const hands=result.landmarks.map((landmarks,i)=>{
        const label=handedness?.[i]?.[0];
        return {landmarks,label:label?.categoryName ?? null,score:label?.score ?? null};
      });
      const selected=single ? selectSingleHand(hands,sourceMirrored) : selectRightHand(hands,sourceMirrored);
      return {tMs,aspect:video.videoWidth/video.videoHeight,
        hand:bodyCoordinates(selected?.landmarks,sourceMirrored),
        side:single ? selected?.side ?? null : selected ? 'Right' : null,handScore:selected?.score ?? null,
        coordinateSystem:'body-right-v1',sourceMirrored,
        trackerVersion:single ? singleHandTrackerVersion : 'right-hand-v4',hands};
    },
    close(){detector.close();},
  };
}

export function watchVideo(video,tracker,onFrame,onError) {
  let id,previous=-Infinity,stopped=false;
  function frame(_,meta) {
    if(stopped)return;
    try {
      const tMs=meta.mediaTime*1000;
      if(tMs>previous){previous=tMs;onFrame(tracker.read(video,tMs));}
      if(!stopped)id=video.requestVideoFrameCallback(frame);
    } catch(error){stopped=true;onError(error);}
  }
  id=video.requestVideoFrameCallback(frame);
  return ()=>{stopped=true;video.cancelVideoFrameCallback(id);};
}

function waitForVideo(video,eventName,signal,action) {
  return new Promise((resolve,reject)=>{
    let timeout;
    const cleanup=()=>{
      clearTimeout(timeout);video.removeEventListener(eventName,ready);
      video.removeEventListener('error',failed);signal.removeEventListener('abort',aborted);
    };
    const ready=()=>{cleanup();resolve();};
    const failed=()=>{cleanup();reject(new Error('录像解码失败，请检查文件格式'));};
    const aborted=()=>{cleanup();reject(new DOMException('Stopped','AbortError'));};
    if(signal.aborted){aborted();return;}
    video.addEventListener(eventName,ready,{once:true});video.addEventListener('error',failed,{once:true});
    signal.addEventListener('abort',aborted,{once:true});
    timeout=setTimeout(()=>{cleanup();reject(new Error('读取录像超时，请重新选择视频'));},15000);
    try{action?.();}catch(error){cleanup();reject(error);}
  });
}

// Uploaded files are sampled identically, independently of playback or inference speed.
export function scanVideo(video,tracker,onFrame,onProgress,onComplete,onError) {
  const controller=new AbortController(),signal=controller.signal;
  (async()=>{
    try{
      if(video.readyState<2)await waitForVideo(video,'loadeddata',signal,()=>video.load());
      const total=Math.floor(video.duration*30);
      if(!Number.isFinite(total)||total<1)throw new Error('录像时长无效');
      for(let i=0;i<total;i++){
        if(signal.aborted)return;
        const time=i/30;
        if(Math.abs(video.currentTime-time)>0.00001)
          await waitForVideo(video,'seeked',signal,()=>{video.currentTime=time;});
        if(signal.aborted)return;
        if(Math.abs(video.currentTime-time)>0.05)throw new Error('录像定位失败');
        onFrame(tracker.read(video,time*1000));
        if(i%15===0)onProgress(i+1,total);
      }
      onComplete();
    }catch(error){if(error.name!=='AbortError')onError(error);}
  })();
  return ()=>controller.abort();
}
