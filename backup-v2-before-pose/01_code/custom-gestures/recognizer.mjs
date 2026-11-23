import {dtw} from '../development-v41/recognizer-development.mjs';
import {compileProfile, engineVersion} from './profile.mjs';
import {coordinateSystem, trackerVersion, featureVersion, createSegmenter, describeClip} from './trajectory.mjs';

function nearest(sequence, templates) {
  let distance = Infinity, sampleId = null;
  for (const template of templates) {
    const candidate = dtw(sequence, template.sequence);
    if (candidate < distance) {
      distance = candidate;
      sampleId = template.sampleId;
    }
  }
  return {distance: sampleId ? distance : null, sampleId};
}

export function createRecognizer(input) {
  const {profile, classes} = compileProfile(input);
  const templates = classes.filter(item => item.positive.length > 0);
  const segmenter = createSegmenter(profile.settings);

  function push(frame) {
    const candidate = segmenter.push(frame);
    if (!candidate) return null;
    const {startMs, endMs} = candidate;
    const window = {tMs: frame.tMs, startMs, endMs};
    const reject = (reason, scores = []) => ({rejection: {...window, reason, scores}});
    if (candidate.reason) return reject(candidate.reason);
    const {sequence, reason} = describeClip(candidate.frames, profile.settings);
    if (!sequence) return reject(reason);
    if (!templates.length) return reject('no_templates');

    const scores = templates.map(({gesture, positive, negative}) => {
      const pos = nearest(sequence, positive);
      const neg = nearest(sequence, negative);
      const withinThreshold = pos.distance <= gesture.settings.threshold;
      const blockedByNegative = withinThreshold && neg.distance !== null &&
        neg.distance - pos.distance < gesture.settings.negativeMargin;
      return {
        gestureId: gesture.gestureId, gestureName: gesture.name,
        positiveDistance: pos.distance, negativeDistance: neg.distance,
        positiveSampleId: pos.sampleId, negativeSampleId: neg.sampleId,
        withinThreshold, blockedByNegative,
      };
    }).sort((a, b) => a.positiveDistance - b.positiveDistance);

    const [best, runnerUp] = scores.filter(score => score.withinThreshold && !score.blockedByNegative);
    if (!best) {
      return reject(scores.some(score => score.blockedByNegative) ? 'negative_match' : 'unknown', scores);
    }
    if (runnerUp && runnerUp.positiveDistance - best.positiveDistance < profile.settings.ambiguityMargin) {
      return reject('ambiguous', scores);
    }
    const gesture = profile.gestures.find(item => item.gestureId === best.gestureId);
    return {event: {...window, ...best, actionId: gesture.actionId, scores, frames: candidate.frames}};
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
    version: 2, engineVersion, trackerVersion, featureVersion, coordinateSystem,
    runId, startedAt: new Date().toISOString(), source, mode, profile,
    frames: [], events: [], rejections: [],
  };
}

export function readTrajectory(run) {
  if (![1, 2].includes(run?.version) || run.trackerVersion !== trackerVersion ||
      (run.version === 2 && run.coordinateSystem !== coordinateSystem) ||
      !Array.isArray(run.frames) || !run.frames.length) {
    throw new Error('请选择含 right-hand-v4 轨迹的旧版 run 或自定义手势 v2 run。');
  }
  return run.frames;
}
