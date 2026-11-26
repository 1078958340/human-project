import {
  createFrameReader, describeMotion, describePose, palmDistance, poseDistance,
} from './hand-features.mjs';

export {coordinateSystem, featureVersion, trackerVersion} from './hand-features.mjs';

export const motionDefaults = Object.freeze({
  minMs: 125, maxMs: 1600, maxGapMs: 240,
  quietMs: 120, quietPalm: 0.11, quietPose: 0.076,
  minPalmMotion: 0.27, minPoseMotion: 0.105,
  examplePoseMs: 130, staticHoldMs: 190,
  releasePose: 0.135, releaseMs: 85,
});

export const gestureTypes = Object.freeze({static: '静态手型', dynamic: '短动态动作'});
const staticFinishGraceMs = 700;

const changed = (a, b, settings) =>
  palmDistance(a, b) >= settings.quietPalm || poseDistance(a.shape, b.shape) >= settings.quietPose;

export function createSegmenter(settings) {
  let state, seenMs = -Infinity;

  function complete(reason) {
    if (!state?.active) return null;
    const {entries, lastMotion, tooLong} = state;
    const candidate = {type: 'dynamic', startMs: state.startMs, endMs: lastMotion.tMs};
    if (reason || tooLong) return {...candidate, reason: reason || 'too_long'};
    return {...candidate, frames: entries.slice(0, lastMotion.length).map(entry => entry.frame)};
  }

  function start(frame, point) {
    state = {anchor: point, startMs: point.tMs, entries: [{frame, point}], active: false};
  }

  function push(frame, point) {
    let interrupted = null;
    const multipleHands = !point && frame.hands?.length > 1;
    if (multipleHands || frame.tMs - seenMs > settings.maxGapMs) {
      interrupted = complete(multipleHands ? 'multiple_hands' : 'tracking_gap');
      state = undefined;
    }
    if (!point) {
      if (state && !state.tooLong) state.entries.push({frame, point});
      return interrupted;
    }
    seenMs = frame.tMs;
    if (!state) {
      start(frame, point);
      return interrupted;
    }

    const moved = changed(point, state.anchor, settings);
    if (!moved && point.tMs - state.anchor.tMs >= settings.quietMs) {
      const finished = complete();
      start(frame, point);
      return finished;
    }
    if (!state.tooLong) state.entries.push({frame, point});
    if (moved) {
      if (!state.active) {
        const recent = state.entries.findLastIndex(entry => entry.point && entry.point.tMs <= point.tMs - 65);
        if (recent > 0) state.entries = state.entries.slice(recent);
        state.startMs = state.entries[0].frame.tMs;
      }
      state.active = true;
      state.anchor = point;
      state.lastMotion = {tMs: point.tMs, length: state.entries.length};
      if (point.tMs - state.startMs > settings.maxMs) {
        state.tooLong = true;
        state.entries = [];
      }
    }
    return null;
  }

  function finish() {
    const result = complete();
    state = undefined;
    return result;
  }

  return {push, finish, get active() { return Boolean(state?.active); }};
}

export function createPoseHold(settings) {
  let anchor, entries = [], generation = 0;

  function push(frame, point) {
    const last = entries.at(-1);
    if (!point || !anchor || frame.tMs - last.tMs > settings.maxGapMs ||
        poseDistance(point.shape, anchor.shape) >= settings.quietPose || palmDistance(point, anchor) >= 2.5 * settings.quietPalm) {
      anchor = point;
      entries = [];
      generation++;
    }
    if (!point) return;
    entries.push(frame);
    const keep = Math.max(settings.staticHoldMs, settings.examplePoseMs) + settings.maxGapMs;
    while (entries.length > 1 && frame.tMs - entries[1].tMs >= keep) entries.shift();
  }

  function candidate(holdMs) {
    const end = entries.at(-1);
    if (!end || entries.length < 3) return null;
    const start = entries.findLastIndex(frame => frame.tMs <= end.tMs - holdMs);
    if (start < 0) return null;
    const frames = entries.slice(Math.min(start, entries.length - 3));
    return {type: 'static', startMs: frames[0].tMs, endMs: end.tMs, frames};
  }

  return {push, candidate, get generation() { return generation; }};
}

export function describeClip(frames, type, settings) {
  if (!Array.isArray(frames) || frames.length < 3) return {reason: 'insufficient_tracking'};
  const read = createFrameReader();
  const points = frames.map(read).filter(Boolean);
  const start = points[0], end = points.at(-1);
  if (points.length < 3 || start.tMs !== frames[0].tMs || end.tMs !== frames.at(-1).tMs) {
    return {reason: 'insufficient_tracking'};
  }
  if (points.some((point, i) => i > 0 && point.tMs - points[i - 1].tMs > settings.maxGapMs)) {
    return {reason: 'tracking_gap'};
  }
  const duration = end.tMs - start.tMs;
  if (type === 'static') {
    if (duration < settings.examplePoseMs) return {reason: 'pose_not_steady'};
    return describePose(points, settings);
  }
  if (type !== 'dynamic') throw new Error('手势类型无效。');
  if (duration > settings.maxMs) return {reason: 'too_long'};
  if (duration < settings.minMs) return {reason: 'too_short'};
  return describeMotion(points, settings);
}

export const clipErrors = Object.freeze({
  insufficient_tracking: '有效手部关键点不足，请把整只手放进画面。',
  tracking_gap: '动作中手部追踪中断太久。',
  multiple_hands: '画面中检测到多只手，请一次只示范一只手。',
  too_short: '动作时间太短，请稍放慢，让完整动作进入录制。',
  too_long: '动作太长，请只示范一次短而连贯的动作。',
  too_little_motion: '手掌或手指变化幅度不足。若要保存手型，请选择静态手型。',
  pose_not_steady: '手型还没有保持稳定。摆好后再停片刻，直到结束示范。',
});

export function prepareExample(raw, type = 'dynamic', settings = motionDefaults) {
  if (!Array.isArray(raw)) throw new Error('示范应为关键点帧数组。');
  if (!Object.hasOwn(gestureTypes, type)) throw new Error('请选择有效的手势类型。');
  const effective = {...motionDefaults, ...settings};
  const read = createFrameReader();
  if (type === 'static') {
    const hold = createPoseHold(effective);
    let tracked = 0, latestStable;
    for (const frame of raw) {
      const point = read(frame);
      if (point) tracked++;
      hold.push(frame, point);
      latestStable = hold.candidate(effective.examplePoseMs) ?? latestStable;
    }
    const finishMs = raw.at(-1)?.tMs;
    const clip = latestStable && finishMs - latestStable.endMs <= staticFinishGraceMs ? latestStable.frames : null;
    const reason = clip ? describeClip(clip, type, effective).reason :
      tracked >= 3 ? 'pose_not_steady' : 'insufficient_tracking';
    if (reason) throw new Error(clipErrors[reason]);
    return clip;
  }

  const segmenter = createSegmenter(effective);
  const examples = [];
  let tracked = 0, issue, interrupted;
  function inspect(candidate) {
    if (!candidate) return;
    const reason = candidate.reason ?? describeClip(candidate.frames, type, effective).reason;
    if (['tracking_gap', 'too_long', 'multiple_hands'].includes(reason)) interrupted = reason;
    if (reason) issue = reason;
    else examples.push(candidate.frames);
  }
  for (const frame of raw) {
    const point = read(frame);
    if (point) tracked++;
    inspect(segmenter.push(frame, point));
  }
  inspect(segmenter.finish());
  if (examples.length > 1) throw new Error('检测到多个动作。每次录制只做一次短动作。');
  if (interrupted || examples.length === 0) {
    throw new Error(clipErrors[interrupted ?? issue ?? (tracked < 3 ? 'insufficient_tracking' : 'too_little_motion')]);
  }
  return examples[0];
}
