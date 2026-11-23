import {compileProfile, engineVersion, featureDistance, profileVersion} from './profile.mjs';
import {coordinateSystem, trackerVersion, featureVersion, legacyTrackerVersion, createFrameReader, poseDistance} from './hand-features.mjs';
import {createSegmenter, createPoseHold, describeClip} from './trajectory.mjs';

function nearest(type, feature, templates, threshold) {
  let closest = Infinity, second = Infinity, sampleId = null;
  for (const template of templates) {
    const distance = featureDistance(type, feature, template.feature);
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

function classify(candidate, evaluationMs, templates, settings, handLeft = false) {
  const {type, startMs, endMs, frames} = candidate;
  const window = {gestureType: type, tMs: evaluationMs, startMs, endMs};
  const reject = (reason, scores = []) => ({rejection: {...window, reason, scores}});
  if (candidate.reason) return reject(candidate.reason);
  const {feature, extent, reason} = describeClip(frames, type, settings);
  if (!feature) return reject(reason);

  const scores = templates.map(({gesture, positive, negative}) => {
    const {threshold, negativeMargin} = gesture.settings;
    const comparable = handLeft ? positive.filter(template => coversMotion(extent, template.extent, settings)) : positive;
    const pos = nearest(type, feature, comparable, threshold);
    const withinThreshold = pos.distance !== null && pos.distance <= (handLeft ? threshold * 0.73 : threshold);
    const neg = !handLeft || withinThreshold ? nearest(type, feature, negative) : {distance: null, sampleId: null};
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
  const {actionId} = templates.find(({gesture}) => gesture.gestureId === best.gestureId).gesture;
  const distanceMetric = type === 'static' ? 'pose_neighbors' : 'motion_dtw';
  return {event: {...window, ...best, actionId, distanceMetric, scores, frames,
    completion: handLeft ? 'matched_before_tracking_loss' : 'settled'}};
}

function coversMotion(observed, template, settings) {
  const palmRatio = template.palm / settings.minPalmMotion;
  const poseRatio = template.pose / settings.minPoseMotion;
  // Losing sight of a hand must not turn a small prefix into a completed gesture.
  return palmRatio >= poseRatio ?
    observed.palm >= template.palm * 0.62 : observed.pose >= template.pose * 0.62;
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
      const {event} = classify({type: 'dynamic', startMs: first, endMs: last, frames}, tMs, templates, settings, true);
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

export function createRecognizer(input) {
  const {profile, classes} = compileProfile(input);
  const settings = profile.settings;
  const activeClasses = classes.filter(item => item.positive.length > 0);
  const dynamic = activeClasses.filter(({gesture}) => gesture.type === 'dynamic');
  const poses = activeClasses.filter(({gesture}) => gesture.type === 'static');
  const read = createFrameReader();
  const segmenter = createSegmenter(settings);
  const hold = createPoseHold(settings);
  let history = [];
  let lastSeenMs = -Infinity, lockedPose, awaySince = null, attemptedGeneration;

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
    const motion = segmenter.push(frame, point);
    if (dynamic.length) {
      const earliest = frame.tMs - settings.maxMs - settings.maxGapMs - 300;
      history.push({frame, point});
      while (history.length && history[0].frame.tMs < earliest) history.shift();
    }
    if (poses.length) {
      trackRelease(point, frame.tMs);
      hold.push(frame, point);
    }
    if (motion && dynamic.length) {
      const canUseEnd = motion.reason === 'tracking_gap';
      const result = (canUseEnd && matchBeforeLoss(motion, history, frame.tMs, dynamic, settings)) ||
        classify(motion, frame.tMs, dynamic, settings);
      if (result.event || motion.reason) history = point ? [{frame, point}] : [];
      // A successful stroke owns its terminal pose, until the hand releases it.
      if (result.event && point) {
        lockedPose = point.shape;
        awaySince = null;
      }
      return result;
    }
    if (!poses.length || !point || lockedPose || segmenter.active ||
        attemptedGeneration === hold.generation) return null;
    const pose = hold.candidate(settings.staticHoldMs);
    if (!pose) return null;
    attemptedGeneration = hold.generation;
    const result = classify(pose, frame.tMs, poses, settings);
    if (result.event) lockedPose = point.shape;
    return result;
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
    if (result?.rejection) rejections.push(result.rejection);
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
  const legacy = [1, 2].includes(run?.version) && run.trackerVersion === legacyTrackerVersion;
  const current = run?.version === profileVersion && run.trackerVersion === trackerVersion;
  if ((!legacy && !current) || (run.version !== 1 && run.coordinateSystem !== coordinateSystem) ||
      !Array.isArray(run.frames) || !run.frames.length) {
    throw new Error('请选择包含已知坐标版本和手部关键点的轨迹文件。');
  }
  return run.frames;
}

