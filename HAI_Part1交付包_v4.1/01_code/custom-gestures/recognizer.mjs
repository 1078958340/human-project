import {compileProfile, engineVersion, matchingDistance, profileVersion} from './profile.mjs';
import {
  coordinateSystem, trackerVersion, featureVersion, archivedTrackerVersions, createFrameReader, palmDistance, poseDistance,
} from './hand-features.mjs';
import {createSegmenter, createPoseHold, describeClip} from './trajectory.mjs';
import {createHandTracks} from './hand-tracks.mjs';

function nearest(gesture, observed, templates, threshold) {
  let closest = Infinity, second = Infinity, sampleId = null;
  for (const template of templates) {
    const distance = matchingDistance(gesture, observed, template);
    if (distance < closest) {
      second = closest;
      closest = distance;
      sampleId = template.sampleId;
    } else if (distance < second) {
      second = distance;
    }
  }
  if (sampleId === null) return {distance: null, sampleId};
  // A second positive reduces dependence on a single noisy template.
  const correction = threshold && Number.isFinite(second) ? 0.25 * Math.min(second - closest, threshold / 2) : 0;
  return {distance: closest + correction, sampleId};
}

function classify(candidate, evaluationMs, templates, settings, completion = 'settled') {
  const {type, startMs, endMs, frames} = candidate;
  const window = {gestureType: type, tMs: evaluationMs, startMs, endMs};
  const reject = (reason, scores = []) => ({rejection: {...window, reason, scores}});
  if (candidate.reason) return reject(candidate.reason);
  const observed = describeClip(frames, type, settings);
  if (!observed.feature) return reject(observed.reason);
  const {extent} = observed;

  const scores = templates.map(({gesture, positive, negative}) => {
    const {threshold, negativeMargin} = gesture.settings;
    const strict = completion !== 'settled';
    const comparable = strict || gesture.motionChannel === 'pose' ? positive.filter(template => {
      const channel = gesture.motionChannel ?? dominantChannel(template.extent, settings);
      const coverage = strict ? .62 : .50;
      if (extent[channel] < template.extent[channel] * coverage) return false;
      if (completion !== 'rolling_match') return true;
      const sampleSpeed = template.extent[channel] / template.duration;
      return extent[channel] / (endMs - startMs) >= sampleSpeed * .67;
    }) : positive;
    const pos = nearest(gesture, observed, comparable, threshold);
    const acceptance = completion === 'matched_before_tracking_loss' ? .73 : completion === 'rolling_match' ? .93 : 1;
    const withinThreshold = pos.distance !== null && pos.distance <= threshold * acceptance;
    const neg = !strict || withinThreshold ? nearest(gesture, observed, negative) : {distance: null, sampleId: null};
    const blockedByNegative = withinThreshold && neg.distance !== null && neg.distance - pos.distance < negativeMargin;
    return {
      gestureId: gesture.gestureId, gestureName: gesture.name,
      positiveDistance: pos.distance, negativeDistance: neg.distance,
      positiveSampleId: pos.sampleId, negativeSampleId: neg.sampleId,
      withinThreshold, blockedByNegative,
    };
  }).sort((a, b) => (a.positiveDistance ?? Infinity) - (b.positiveDistance ?? Infinity));

  const [best, runnerUp] = scores.filter(score => score.withinThreshold && !score.blockedByNegative);
  if (!best) {
    return reject(scores.some(score => score.blockedByNegative) ? 'negative_match' : 'unknown', scores);
  }
  const margin = type === 'static' ? settings.staticAmbiguityMargin : settings.dynamicAmbiguityMargin;
  if (runnerUp && runnerUp.positiveDistance - best.positiveDistance < margin) {
    return reject('ambiguous', scores);
  }
  const {actionId, motionChannel} = templates.find(({gesture}) => gesture.gestureId === best.gestureId).gesture;
  const distanceMetric = type === 'static' ? 'pose_neighbors' : motionChannel ? 'motion_' + motionChannel + '_dtw' : 'motion_dtw';
  return {event: {...window, ...best, actionId, distanceMetric, scores, frames, completion}};
}

function dominantChannel(extent, settings) {
  return extent.palm / settings.minPalmMotion >= extent.pose / settings.minPoseMotion ? 'palm' : 'pose';
}

function rollingTemplates(classes, settings) {
  const returning = new Set();
  for (const {gesture, positive} of classes) {
    for (const {extent} of positive) {
      const channel = gesture.motionChannel ?? dominantChannel(extent, settings);
      if (extent[channel + 'End'] < extent[channel] * .42) returning.add(channel);
    }
  }
  // A straight prefix can belong to a loop or to the first half of a finger gesture.
  return classes.map(item => ({
    ...item, positive: item.positive.filter(({extent}) =>
      !returning.has(item.gesture.motionChannel ?? dominantChannel(extent, settings))),
  })).filter(({positive}) => positive.length);
}

function matchBeforeLoss(motion, history, tMs, templates, settings) {
  if (motion.endMs - motion.startMs + 80 < settings.minMs) return null;
  const choices = new Map();
  const seen = new Set();
  // A hand can leave the frame during the return, so check the recent stroke as well as the final point.
  for (const endOffset of [0, 64, 128, 192, 256]) {
    const end = history.findLastIndex(({point}) => point && point.tMs <= motion.endMs - endOffset);
    if (end < 0 || history[end].frame.tMs < motion.startMs + settings.minMs) continue;
    for (const startOffset of [0, 80, 160, 240, 320, 400]) {
      const start = history.findIndex(({point}) => point && point.tMs >= motion.startMs - startOffset);
      if (start < 0 || start >= end) continue;
      const first = history[start].frame.tMs, last = history[end].frame.tMs;
      if (last - first < settings.minMs || last - first > settings.maxMs) continue;
      const key = first + '/' + last;
      if (seen.has(key)) continue;
      seen.add(key);
      const frames = history.slice(start, end + 1).map(item => item.frame);
      const {event} = classify({type: 'dynamic', startMs: first, endMs: last, frames}, tMs, templates, settings,
        'matched_before_tracking_loss');
      if (event && (!choices.has(event.gestureId) ||
          event.positiveDistance < choices.get(event.gestureId).positiveDistance)) {
        choices.set(event.gestureId, event);
      }
    }
  }
  const [best, next] = [...choices.values()].sort((a, b) => a.positiveDistance - b.positiveDistance);
  if (!best) return null;
  if (next && next.positiveDistance - best.positiveDistance < settings.dynamicAmbiguityMargin) {
    return {rejection: {gestureType: 'dynamic', tMs, startMs: best.startMs, endMs: best.endMs,
      reason: 'ambiguous', scores: [best.scores.find(item => item.gestureId === best.gestureId),
        next.scores.find(item => item.gestureId === next.gestureId)]}};
  }
  return {event: best};
}

function templateDurations(classes, settings) {
  const rounded = new Set();
  for (const {positive} of classes) {
    const lengths = positive.map(sample => sample.duration).sort((a, b) => a - b);
    const mid = lengths[Math.floor(lengths.length / 2)];
    for (const candidate of [lengths[0], mid * .78, mid, mid * 1.24]) {
      const bounded = Math.max(settings.minMs, Math.min(settings.maxMs, Math.round(candidate / 50) * 50));
      rounded.add(bounded);
    }
  }
  return [...rounded].sort((a, b) => a - b);
}

function rollingMatch(history, durations, templates, settings, endMs) {
  const choices = new Map();
  for (const duration of durations) {
    const start = history.findIndex(({point}) => point && point.tMs >= endMs - duration - 17);
    if (start < 0) continue;
    const startMs = history[start].frame.tMs;
    if (endMs - startMs < Math.min(duration * .82, settings.minMs)) continue;
    const frames = history.slice(start).map(item => item.frame);
    const {event} = classify({type: 'dynamic', startMs, endMs, frames}, endMs, templates, settings, 'rolling_match');
    if (event && (!choices.has(event.gestureId) || event.positiveDistance < choices.get(event.gestureId).positiveDistance)) {
      choices.set(event.gestureId, event);
    }
  }
  const [best, runner] = [...choices.values()].sort((a, b) => a.positiveDistance - b.positiveDistance);
  if (best && (!runner || runner.positiveDistance - best.positiveDistance >= settings.dynamicAmbiguityMargin)) {
    return {event: best};
  }
  return null;
}

function createHandRecognizer(profile, classes) {
  const settings = profile.settings;
  const activeClasses = classes.filter(item => item.positive.length > 0);
  const dynamic = activeClasses.filter(({gesture}) => gesture.type === 'dynamic');
  const poses = activeClasses.filter(({gesture}) => gesture.type === 'static');
  const earlyTemplates = rollingTemplates(dynamic, settings);
  const durations = templateDurations(earlyTemplates, settings);
  const read = createFrameReader();
  const segmenter = createSegmenter(settings);
  const hold = createPoseHold(settings);
  let history = [];
  let lastSeenMs = -Infinity, lockedPose, awaySince = null, attemptedGeneration;
  let nextMotionScan = -Infinity, lastMotionEvent = -Infinity, motionLatch;

  function finishMotion(result, frame, point) {
    history = point ? [{frame, point}] : [];
    segmenter.finish();
    if (result.event) {
      lockedPose = point?.shape;
      awaySince = null;
      lastMotionEvent = frame.tMs;
      motionLatch = point ? {anchor: point, seenMs: point.tMs} : null;
    }
    return result;
  }

  function isMotionLatched(point, tMs) {
    if (!motionLatch) return false;
    if (tMs - motionLatch.seenMs > settings.maxGapMs) {
      motionLatch = null;
      return false;
    }
    if (!point) return true;
    motionLatch.seenMs = tMs;
    const anchor = motionLatch.anchor;
    const moving = palmDistance(point, anchor) >= settings.quietPalm ||
      poseDistance(point.shape, anchor.shape) >= settings.quietPose;
    if (moving) motionLatch.anchor = point;
    if (!moving && tMs - anchor.tMs >= settings.quietMs) {
      motionLatch = null;
      lockedPose = point.shape;
      awaySince = null;
      return false;
    }
    return true;
  }

  function trackRelease(point, tMs) {
    if (tMs - lastSeenMs > settings.maxGapMs) lockedPose = undefined;
    if (!point || !lockedPose || poseDistance(lockedPose, point.shape) < settings.releasePose) {
      awaySince = null;
    } else {
      awaySince ??= tMs;
      if (tMs - awaySince >= settings.releaseMs) lockedPose = undefined;
    }
    if (point) lastSeenMs = tMs;
  }

  function push(frame) {
    const point = read(frame);
    const latched = isMotionLatched(point, frame.tMs);
    const motion = latched ? null : segmenter.push(frame, point);
    if (dynamic.length && !latched) {
      const earliest = frame.tMs - settings.maxMs - settings.maxGapMs - 300;
      history.push({frame, point});
      while (history.length && history[0].frame.tMs < earliest) history.shift();
    }
    if (poses.length) {
      trackRelease(point, frame.tMs);
      hold.push(frame, point);
    }
    if (motion && dynamic.length && frame.tMs - lastMotionEvent >= 260) {
      const canUseEnd = motion.reason === 'tracking_gap';
      const result = (canUseEnd && matchBeforeLoss(motion, history, frame.tMs, dynamic, settings)) ||
        classify(motion, frame.tMs, dynamic, settings);
      if (result.event) return finishMotion(result, frame, point);
      if (motion.reason === 'tracking_gap') history = point ? [{frame, point}] : [];
      return result;
    }
    if (point && earlyTemplates.length && segmenter.active && frame.tMs >= nextMotionScan &&
        frame.tMs - lastMotionEvent >= 260) {
      nextMotionScan = frame.tMs + 90;
      const result = rollingMatch(history, durations, earlyTemplates, settings, frame.tMs);
      if (result) return finishMotion(result, frame, point);
    }
    if (!poses.length || !point || lockedPose || latched ||
        attemptedGeneration === hold.generation) return null;
    const pose = hold.candidate(settings.staticHoldMs + (segmenter.active ? 90 : 0));
    if (!pose) return null;
    attemptedGeneration = hold.generation;
    const result = classify(pose, frame.tMs, poses, settings);
    if (result.event) lockedPose = point.shape;
    return result;
  }
  return {push};
}

const shorterOverlap = (a, b) => {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  return overlap >= Math.max(45, .28 * Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
};

export function createRecognizer(input) {
  const {profile, classes} = compileProfile(input);
  const tracking = createHandTracks(profile.settings);
  const recognizers = new Map();
  const thresholds = new Map(classes.map(({gesture}) => [gesture.gestureId, gesture.settings.threshold]));
  let recent = [];

  function push(frame) {
    const tracked = tracking.push(frame);
    const present = new Set(tracked.map(({handTrackId}) => handTrackId));
    for (const id of recognizers.keys()) if (!present.has(id)) recognizers.delete(id);
    const events = [], rejections = [];
    for (const projected of tracked) {
      const {handTrackId, side} = projected;
      if (!recognizers.has(handTrackId)) recognizers.set(handTrackId, createHandRecognizer(profile, classes));
      const result = recognizers.get(handTrackId).push(projected);
      if (result?.event) events.push({...result.event, handTrackId, side: side ?? result.event.frames.at(-1)?.side ?? null});
      if (result?.rejection) rejections.push({...result.rejection, handTrackId});
    }
    recent = recent.filter(event => frame.tMs - event.tMs <= 360);
    events.sort((a, b) => a.positiveDistance / thresholds.get(a.gestureId) -
      b.positiveDistance / thresholds.get(b.gestureId));
    let event;
    for (const proposed of events) {
      if (event || recent.some(item => item.handTrackId !== proposed.handTrackId && shorterOverlap(item, proposed))) {
        const {gestureType, tMs, startMs, endMs, scores, handTrackId} = proposed;
        rejections.push({gestureType, tMs, startMs, endMs, scores, handTrackId, reason: 'concurrent_gesture'});
        continue;
      }
      event = proposed;
      recent.push(event);
    }
    if (!event && !rejections.length) return null;
    return {event, rejection: rejections[0], rejections};
  }
  return {push, profile};
}

export function replay(frames, input) {
  if (!Array.isArray(frames)) throw new Error('回放需要 frames 轨迹数组。');
  const recognizer = createRecognizer(input);
  const events = [], rejections = [];
  for (const frame of frames) {
    const result = recognizer.push(frame);
    if (result?.event) events.push(result.event);
    if (result?.rejections) rejections.push(...result.rejections);
  }
  return {profile: recognizer.profile, events, rejections};
}

export function createRun(profile, source, mode, runId = crypto.randomUUID()) {
  return {
    version: profileVersion, engineVersion, trackerVersion, featureVersion, coordinateSystem,
    runId, startedAt: new Date().toISOString(), source, mode, profile,
    frames: [], events: [], rejections: [],
  };
}

export function readTrajectory(run) {
  const legacy = [1, 2, 3].includes(run?.version) && archivedTrackerVersions.includes(run.trackerVersion);
  const current = run?.version === profileVersion && run.trackerVersion === trackerVersion;
  if ((!legacy && !current) || (run.version !== 1 && run.coordinateSystem !== coordinateSystem) ||
      !Array.isArray(run.frames) || !run.frames.length) {
    throw new Error('请选择包含已知坐标版本和手部关键点的轨迹文件。');
  }
  return run.frames;
}

