export const coordinateSystem = 'body-right-v1';
export const trackerVersion = 'right-hand-v4';
export const featureVersion = 'palm-path-20-v1';

export const motionDefaults = Object.freeze({
  minMs: 240, maxMs: 1500, maxGapMs: 180,
  quietMs: 230, quietDistance: 0.12, minExcursion: 0.65,
});

const palmPoints = [0, 5, 9, 13, 17];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const relativeDistance = (a, b) => distance(a, b) / Math.max(a.scale, b.scale);

function observe(frame) {
  if (!Number.isFinite(frame?.tMs) || frame.tMs < 0 ||
      !Number.isFinite(frame.aspect) || frame.aspect <= 0 ||
      (frame.coordinateSystem !== undefined && frame.coordinateSystem !== coordinateSystem) ||
      (frame.trackerVersion !== undefined && frame.trackerVersion !== trackerVersion) ||
      (frame.sourceMirrored !== undefined && typeof frame.sourceMirrored !== 'boolean')) {
    throw new Error('轨迹帧需要有效的媒体时间、宽高比和右手坐标版本。');
  }
  if (frame.hand === null) return null;
  if (!Array.isArray(frame.hand) || frame.hand.length !== 21 ||
      frame.hand.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) {
    throw new Error('hand 必须为 21 个有效关键点或 null。');
  }
  if (frame.side != null && frame.side !== 'Right') return null;
  const scale = Math.hypot((frame.hand[0].x - frame.hand[9].x) * frame.aspect,
    frame.hand[0].y - frame.hand[9].y);
  if (scale < 0.015) return null;
  const x = palmPoints.reduce((sum, i) => sum + frame.hand[i].x, 0) * frame.aspect / palmPoints.length;
  const y = palmPoints.reduce((sum, i) => sum + frame.hand[i].y, 0) / palmPoints.length;
  return {x, y, scale, tMs: frame.tMs};
}

function assertTime(frame, previousMs) {
  if (!Number.isFinite(frame?.tMs) || frame.tMs <= previousMs) {
    throw new Error('同一来源的媒体时间 tMs 必须严格递增。');
  }
}

export function describeClip(frames, settings) {
  if (!Array.isArray(frames) || frames.length < 4) return {reason: 'insufficient_tracking'};
  let previousMs = -Infinity;
  const points = [];
  for (const frame of frames) {
    assertTime(frame, previousMs);
    previousMs = frame.tMs;
    const point = observe(frame);
    if (point) points.push(point);
  }
  const start = points[0], end = points.at(-1);
  if (points.length < 4 || start.tMs !== frames[0].tMs || end.tMs !== frames.at(-1).tMs) {
    return {reason: 'insufficient_tracking'};
  }
  const duration = end.tMs - start.tMs;
  if (duration > settings.maxMs) return {reason: 'too_long'};
  if (duration < settings.minMs) return {reason: 'too_short'};
  if (points.some((point, i) => i > 0 && point.tMs - points[i - 1].tMs > settings.maxGapMs)) {
    return {reason: 'tracking_gap'};
  }
  const scales = points.map(p => p.scale).sort((a, b) => a - b);
  const scale = scales[Math.floor(scales.length / 2)];
  if (points.every(point => distance(start, point) < settings.minExcursion * scale)) {
    return {reason: 'too_little_motion'};
  }

  let index = 0;
  const sequence = Array.from({length: 20}, (_, i) => {
    const time = start.tMs + duration * i / 19;
    while (index < points.length - 2 && points[index + 1].tMs < time) index++;
    const a = points[index], b = points[index + 1];
    const mix = (time - a.tMs) / (b.tMs - a.tMs);
    return [(a.x + (b.x - a.x) * mix - start.x) / scale,
      (a.y + (b.y - a.y) * mix - start.y) / scale];
  });
  return {sequence};
}

// A completed stroke is evaluated once, after its palm position settles.
// Short tracking gaps stay inside the window. Long gaps cancel the stroke.
export function createSegmenter(settings) {
  let state, previousMs = -Infinity, seenMs = -Infinity;

  function complete(reason) {
    if (!state?.active) return null;
    const {frames, lastMotion, tooLong} = state;
    return {
      startMs: state.startMs,
      endMs: lastMotion.tMs,
      ...(reason || tooLong ? {reason: reason || 'too_long'} : {frames: frames.slice(0, lastMotion.length)}),
    };
  }

  function start(frame, point) {
    state = {anchor: point, startMs: point.tMs, frames: [frame], active: false};
  }

  function push(frame) {
    assertTime(frame, previousMs);
    const point = observe(frame);
    previousMs = frame.tMs;
    let interrupted = null;
    if (frame.tMs - seenMs > settings.maxGapMs) {
      interrupted = complete('tracking_gap');
      state = undefined;
    }
    if (!point) {
      if (state && !state.tooLong) state.frames.push(frame);
      return interrupted;
    }
    seenMs = frame.tMs;
    if (!state) {
      start(frame, point);
      return interrupted;
    }

    const moved = relativeDistance(point, state.anchor) >= settings.quietDistance;
    if (!moved && point.tMs - state.anchor.tMs >= settings.quietMs) {
      const finished = complete();
      start(frame, point);
      return finished;
    }
    if (!state.tooLong) state.frames.push(frame);
    if (moved) {
      if (!state.active) {
        const recentStart = state.frames.findLastIndex(f => f.tMs <= point.tMs - 80 && observe(f));
        if (recentStart > 0) state.frames = state.frames.slice(recentStart);
        state.startMs = state.frames[0].tMs;
      }
      state.active = true;
      state.anchor = point;
      state.lastMotion = {tMs: point.tMs, length: state.frames.length};
      if (point.tMs - state.startMs > settings.maxMs) {
        state.tooLong = true;
        state.frames = [];
      }
    }
    return null;
  }

  function finish() {
    const result = complete();
    state = undefined;
    return result;
  }

  return {push, finish};
}

export const clipErrors = Object.freeze({
  insufficient_tracking: '有效右手关键点不足。',
  tracking_gap: '动作中右手追踪中断太久。',
  too_short: '动作太短，请放慢并连续移动手掌。',
  too_long: '动作太长，请只做一次短而连贯的动作。',
  too_little_motion: '手掌移动幅度不足。',
});

export function prepareExample(raw, settings = motionDefaults) {
  if (!Array.isArray(raw)) throw new Error('示范应为关键点帧数组。');
  const effective = {...motionDefaults, ...settings};
  const segmenter = createSegmenter(effective);
  const examples = [];
  let issue = 'insufficient_tracking';
  let interrupted;
  function inspect(candidate) {
    if (!candidate) return;
    const reason = candidate.reason ?? describeClip(candidate.frames, effective).reason;
    if (reason === 'tracking_gap' || reason === 'too_long') interrupted = reason;
    if (reason) issue = reason;
    else examples.push(candidate.frames);
  }
  for (const frame of raw) inspect(segmenter.push(frame));
  inspect(segmenter.finish());
  if (examples.length > 1) throw new Error('检测到多个动作。每次录制只做一次，结束并保存后再移回起点。');
  if (interrupted || examples.length === 0) throw new Error(clipErrors[interrupted ?? issue]);
  return examples[0];
}
