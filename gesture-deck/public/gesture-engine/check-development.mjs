import assert from 'node:assert/strict';
import {replay,createRecognizer,dtw} from './development-v41/recognizer-development.mjs';
function clip(start,direction=1,y=0){
  return Array.from({length:13},(_,i)=>({tMs:start+i*50,aspect:1.33,
    side:'Right',hand:Array.from({length:21},(_,k)=>({x:0.3+direction*i*0.01,
      y:0.5-k*0.008+y*i/12,z:0}))}));
}
const positive=clip(0), negative=clip(0,1,0.04);
const profile={version:1,mode:'initial',positives:[positive],settings:{threshold:0.55}};
assert.equal(dtw([[0,0],[1,0]],[[0,0],[1,0]]),0);
assert.equal(replay(clip(0,-1),profile).length,0);
const blank=Array.from({length:10},(_,i)=>({tMs:650+i*50,aspect:1.33,hand:null}));
const events=replay([...positive,...blank,...clip(1200)],profile);
assert.equal(events.length,2);
assert.equal(events[0].type,'next_page');
assert.equal(events[0].frames.at(-1).tMs,events[0].tMs);
const calibration={...profile,mode:'calibrated',negatives:[negative]};
assert.equal(replay(positive,calibration).length,1);
assert.equal(replay(negative,profile).length,1);
assert.equal(replay(negative,calibration).length,0);
const r=createRecognizer(profile);r.push(positive[0]);assert.throws(()=>r.push(positive[0]));
console.log('PASS DTW, direction, event/windows, lock/rearm, negative rejection, timestamp checks');


const {prepareExample}=await import('./development-v41/recognizer-development.mjs');
const imperfect=clip(0);
imperfect[5]={...imperfect[5],hand:null};
imperfect[8]={...imperfect[8],side:'Left'};
const trimmed=prepareExample([{tMs:-50,aspect:1.33,hand:null},...imperfect]);
assert.ok(trimmed.length>=4);
assert.equal(replay(imperfect,profile).length,1);
assert.ok(createRecognizer({...profile,positives:[trimmed]}));
assert.throws(()=>prepareExample(imperfect.map(f=>({...f,hand:null}))),/检测到手/);
assert.throws(()=>prepareExample(clip(0,-1)),/向右位移/);
const broken=clip(0).map(f=>({...f,tMs:f.tMs*10}));
assert.throws(()=>prepareExample(broken),/追踪中断/);
assert.equal(replay(broken,profile).length,0);
console.log('PASS brief dropout, handedness jitter, example trimming, long-gap rejection');

const {bodyCoordinates}=await import('./coordinates.mjs');
const physicalRight=clip(0,-1).map(f=>({...f,hand:bodyCoordinates(f.hand)}));
const physicalLeft=clip(0).map(f=>({...f,hand:bodyCoordinates(f.hand)}));
const bodyProfile={...profile,coordinateSystem:'body-right-v1',positives:[physicalRight]};
assert.equal(replay(physicalRight,bodyProfile).length,1);
assert.equal(replay(physicalLeft,bodyProfile).length,0);
const mirrored=physicalRight.map(f=>({...f,hand:bodyCoordinates(f.hand,true)}));
assert.deepEqual(replay(mirrored,bodyProfile),replay(physicalRight,bodyProfile));
assert.equal(bodyCoordinates(null),null);
console.log('PASS body-right trigger, reverse rejection, mirrored video consistency');

const {selectRightHand}=await import('./hand-selection.mjs');
const left={label:'Left',score:0.99,landmarks:[1]},right={label:'Right',score:0.95,landmarks:[2]};
assert.equal(selectRightHand([left,right]),right);
assert.equal(selectRightHand([left]),null);
assert.equal(selectRightHand([left,right],true),left);
assert.equal(selectRightHand([{...right,score:0.55}]),null);
const hold=Array.from({length:16},(_,i)=>({...positive.at(-1),tMs:650+i*50,
 hand:positive.at(-1).hand.map(p=>({...p,x:p.x+(i%2)*0.0001}))}));
const second=clip(1500).map(f=>({...f,hand:f.hand.map(p=>({...p,x:p.x+0.12}))}));
assert.equal(replay([...positive,...hold,...second],profile).length,2);
const longStroke=Array.from({length:65},(_,i)=>({tMs:i*50,aspect:1.33,side:'Right',
 hand:positive[0].hand.map(p=>({...p,x:p.x+i*.01}))}));
assert.equal(replay(longStroke,profile).length,1);
console.log('PASS anatomical right-hand selection, mirrored labels, rearm while visible, one trigger per continuous stroke');
