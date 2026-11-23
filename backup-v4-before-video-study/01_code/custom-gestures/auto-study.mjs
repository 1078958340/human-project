import {alignIntentions} from './study.mjs';
import {compileProfile, createExample, featureDistance, importProfile, reviseProfile} from './profile.mjs';
import {createRun, readTrajectory, replay} from './recognizer.mjs';
import {describeClip} from './trajectory.mjs';
import {projectHandTracks} from './hand-tracks.mjs';

export const studyTolerance = Object.freeze({earlyMs: 100, lateMs: 350});

const countBy = (items, key) => {
  const fields = {};
  for (const item of items) {
    const field = item[key];
    fields[field] = (fields[field] ?? 0) + 1;
  }
  return fields;
};

export function evaluateStudy(trajectory, profile, labels, tolerance = studyTolerance) {
  const frames = readTrajectory(trajectory);
  const result = replay(frames, profile);
  const run = {
    ...createRun(result.profile, {
      ...trajectory.source, inputRunId: trajectory.runId ?? null,
    }, 'recognition'), ...result, frames,
  };
  if (labels.runId !== trajectory.runId) throw new Error('标注的 runId 与原轨迹不一致。');
  const alignment = alignIntentions(run, {...labels, runId: run.runId}, tolerance);
  const errors = countBy(alignment.review, 'kind');
  return {
    run, alignment,
    metrics: {
      intended: labels.intentions.length, correct: alignment.matched.length,
      missed: errors.missed ?? 0, wrongClass: errors.wrong_class ?? 0, wrongAction: errors.wrong_action ?? 0,
      duplicate: errors.duplicate ?? 0, falseTrigger: errors.false_trigger ?? 0,
      totalTriggers: run.events.length, rejectionReasons: countBy(run.rejections, 'reason'),
    },
  };
}

function sampleDurations(gesture, settings) {
  if (gesture.type === 'static') return [settings.examplePoseMs, settings.staticHoldMs, 255, 330];
  const prior = gesture.positives.map(sample => sample.source.endMs - sample.source.startMs);
  return [...new Set([...prior.map(value => Math.round(value / 50) * 50), 165, 230, 300, 380, 470, 580, 700, 850])]
    .filter(duration => duration >= settings.minMs && duration <= settings.maxMs);
}

function handMatches(frames, hint) {
  if (!hint) return true;
  if (!Number.isFinite(hint.atMs) || !Number.isFinite(hint.imageX) || hint.imageX < 0 || hint.imageX > 1) {
    throw new Error('手部位置提示需要视频媒体毫秒和 0–1 范围内的画面横坐标。');
  }
  const closest = frames.filter(frame => frame.hand).reduce((best, frame) => {
    const difference = Math.abs(frame.tMs - hint.atMs);
    return difference < best.difference ? {frame, difference} : best;
  }, {difference: Infinity});
  if (closest.difference > 220) return false;
  const {frame} = closest;
  const x = frame.sourceMirrored ? frame.hand[0].x : 1 - frame.hand[0].x;
  return Math.abs(x - hint.imageX) <= .16;
}

function findAnnotatedPositive(tracks, item, trainingClass, settings) {
  const {intent} = item;
  const {gesture, positive} = trainingClass;
  const start = intent.sampleStartMs ?? intent.startMs;
  const end = intent.sampleEndMs ?? intent.endMs;
  if (start < intent.startMs || end > intent.endMs || end <= start) {
    throw new Error('样例截取范围必须位于对应的意图区间内。');
  }
  const durations = sampleDurations(gesture, settings);
  let best = null;
  for (const [handTrackId, projected] of tracks) {
    const frames = projected.filter(frame => frame.tMs >= start && frame.tMs <= end);
    if (frames.length < 3 || !handMatches(frames, intent.activeHandHint)) continue;
    for (let i = 0; i < frames.length - 2; i += 2) {
      if (!frames[i].hand) continue;
      const startMs = frames[i].tMs;
      for (const duration of durations) {
        const j = frames.findLastIndex(frame => frame.hand && frame.tMs <= startMs + duration + 30);
        if (j <= i + 1 || frames[j].tMs - startMs < duration - 36) continue;
        const clip = frames.slice(i, j + 1);
        const {feature} = describeClip(clip, gesture.type, settings);
        if (!feature) continue;
        const distance = Math.min(...positive.map(template => featureDistance(gesture.type, feature, template.feature)));
        const center = (startMs + frames[j].tMs) / 2;
        const rank = distance + .045 * Math.abs(center - (start + end) / 2) / (end - start);
        if (!best || rank < best.rank) best = {rank, distance, frames: clip, handTrackId};
      }
    }
  }
  const maximum = Math.min(gesture.type === 'static' ? .34 : .69, gesture.settings.threshold * 2.25);
  return best && best.distance <= maximum ? {clip: best} :
    {reason: best ? 'too_far_from_existing_examples' : 'insufficient_usable_frames', distance: best?.distance ?? null};
}

function applyExamples(profile, additions, change) {
  if (!additions.length) return profile;
  const gestures = profile.gestures.map(gesture => {
    const local = additions.filter(item => item.gestureId === gesture.gestureId);
    return {
      ...gesture,
      positives: [...gesture.positives, ...local.filter(item => item.kind === 'positive').map(item => item.sample)],
      negatives: [...gesture.negatives, ...local.filter(item => item.kind === 'negative').map(item => item.sample)],
    };
  });
  return reviseProfile(profile, {gestures}, {
    ...change, edits: additions.map(({gestureId, kind, sample}) => ({gestureId, kind, sampleId: sample.sampleId})),
  });
}

function sourceFor(trajectory, item, extra = {}) {
  return {
    kind: trajectory.source.kind, runId: trajectory.runId, name: trajectory.source.name ?? null,
    sourceMirrored: trajectory.source.sourceMirrored ?? null, videoSha256: trajectory.source.sha256 ?? null,
    reviewKind: item.kind, reviewId: item.reviewId, intentId: item.intent?.intentId ?? null, ...extra,
  };
}

function negativeCandidates(trajectory, evaluations, base) {
  const {classes} = compileProfile(base);
  const templates = new Map(classes.map(entry => [entry.gesture.gestureId, {
    type: entry.gesture.type, previous: entry.negative.map(sample => sample.feature),
  }]));
  const extracted = [], skipped = [];
  for (const {stage, alignment} of evaluations) {
    for (const item of alignment.review.filter(item => ['false_trigger', 'wrong_class'].includes(item.kind))) {
      const event = item.event;
      const {type, previous} = templates.get(event.gestureId);
      const {feature, reason} = describeClip(event.frames, type, base.settings);
      const audit = {stage, gestureId: event.gestureId, reviewId: item.reviewId, tMs: event.tMs};
      if (!feature || previous.some(other => featureDistance(type, feature, other) <= (type === 'static' ? .024 : .035))) {
        skipped.push({...audit, reason: reason ?? 'similar_negative_already_extracted'});
        continue;
      }
      previous.push(feature);
      const sample = createExample(event.frames, sourceFor(trajectory, item, {
        eventIndex: item.eventIndex, tMs: event.tMs, handTrackId: event.handTrackId ?? null, stage,
      }), 'annotated_false_trigger');
      extracted.push({...audit, kind: 'negative', sample});
    }
  }
  return {extracted, skipped};
}

const extraEvents = evaluation => evaluation.metrics.falseTrigger + evaluation.metrics.duplicate +
  evaluation.metrics.wrongClass + evaluation.metrics.wrongAction;

export function calibrateStudy(trajectory, submitted, labels, tolerance = studyTolerance) {
  if (trajectory.source?.kind !== 'video' || !trajectory.source.sha256) {
    throw new Error('自动校准需要含原始视频校验值的轨迹。');
  }
  const aProfile = importProfile(submitted);
  const A = evaluateStudy(trajectory, aProfile, labels, tolerance);
  const {classes} = compileProfile(aProfile);
  const tracks = projectHandTracks(A.run.frames, aProfile.settings);
  const positives = [], skippedPositives = [];
  for (const item of A.alignment.review.filter(item => ['missed', 'wrong_class'].includes(item.kind))) {
    const gestureId = item.intent.gestureId;
    const entry = classes.find(({gesture}) => gesture.gestureId === gestureId);
    const found = findAnnotatedPositive(tracks, item, entry, aProfile.settings);
    if (!found.clip) {
      skippedPositives.push({intentId: item.intent.intentId, gestureId, ...found});
      continue;
    }
    const {frames, handTrackId, distance} = found.clip;
    const sample = createExample(frames, sourceFor(trajectory, item, {
      handTrackId, selectionDistance: distance, startIntentMs: item.intent.startMs, endIntentMs: item.intent.endMs,
    }), 'annotated_intent');
    positives.push({gestureId, kind: 'positive', sample});
  }
  const provenance = {videoSha256: trajectory.source.sha256, runId: trajectory.runId};
  const bProfile = applyExamples(aProfile, positives, {...provenance, kind: 'annotated_positives'});
  const B = evaluateStudy(trajectory, bProfile, labels, tolerance);
  const candidates = negativeCandidates(trajectory, [{stage: 'A', alignment: A.alignment}, {stage: 'B', alignment: B.alignment}], bProfile);
  const accepted = [], skippedNegatives = [...candidates.skipped];
  let C = B;
  const protectedIntents = new Set(B.alignment.matched.map(item => item.intentId));
  for (const candidate of candidates.extracted) {
    const test = evaluateStudy(trajectory, applyExamples(bProfile, [...accepted, candidate], {
      ...provenance, kind: 'annotated_negatives',
    }), labels, tolerance);
    const matches = new Set(test.alignment.matched.map(item => item.intentId));
    if ([...protectedIntents].some(id => !matches.has(id)) || extraEvents(test) > extraEvents(C)) {
      skippedNegatives.push({
        reviewId: candidate.reviewId, gestureId: candidate.gestureId, sampleId: candidate.sample.sampleId,
        reason: 'degrades_calibration_replay',
      });
      continue;
    }
    accepted.push(candidate);
    C = test;
  }
  return {
    A, B, C, positives, skippedPositives, proposedNegatives: candidates.extracted, accepted, skippedNegatives,
  };
}
