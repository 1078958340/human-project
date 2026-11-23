import {compileProfile, createExample, reviseProfile} from './profile.mjs';
import {prepareExample} from './trajectory.mjs';
import {createRun, readTrajectory, replay} from './recognizer.mjs';
import {actionNames} from './actions.mjs';

const isText = value => typeof value === 'string' && value.trim() !== '';
const inSpan = (time, span) => Number.isFinite(time) && time >= span.startMs && time <= span.endMs;
const validSpan = span => Number.isFinite(span?.startMs) && Number.isFinite(span?.endMs) &&
  span.startMs >= 0 && span.endMs > span.startMs;
const sameCommand = (intent, event) =>
  intent.gestureId === event.gestureId && intent.actionId === event.actionId;

function alignmentIssues(run, labels) {
  const issues = [];
  const gesturesInUse = run?.profile?.gestures;
  if (run?.version !== 2 || !Array.isArray(run.frames) || !run.frames.length ||
      !Array.isArray(run.events) || !Array.isArray(gesturesInUse) ||
      !isText(run.runId) || !isText(run.profile.revisionId)) {
    issues.push('缺少新版运行轨迹、事件或 runId。');
  } else if (run.frames.some((frame, i) => !Number.isFinite(frame?.tMs) || frame.tMs < 0 ||
      (i > 0 && frame.tMs <= run.frames[i - 1]?.tMs)) ||
      run.events.some(event => !inSpan(event?.tMs, {startMs: run.frames[0].tMs, endMs: run.frames.at(-1).tMs}))) {
    issues.push('轨迹需使用递增的媒体时间，事件也应处于该轨迹时间范围内。');
  }
  if (labels?.version !== 1 || labels.complete !== true || labels.timeline !== 'media-ms' ||
      labels.runId !== run?.runId || !isText(labels.participantId) ||
      labels.participantId !== run?.profile?.participantId) {
    issues.push('需要与本轮 runId、参与者及媒体时间轴一致的已完成标注。');
  }
  const {task, intentions} = labels ?? {};
  if (!validSpan(task) || !['command', 'natural', 'mixed'].includes(task.kind) ||
      !Array.isArray(run?.frames) || task.startMs < run.frames[0]?.tMs ||
      task.endMs > run.frames.at(-1)?.tMs) {
    issues.push('需要用轨迹内的媒体时间标明命令、自然活动或混合任务的起止。');
  }
  const ids = new Set();
  const gestures = new Map((Array.isArray(gesturesInUse) ? gesturesInUse : []).filter(Boolean)
    .map(gesture => [gesture.gestureId, gesture]));
  if (!Array.isArray(intentions) ||
      (task?.kind === 'natural' && intentions.length !== 0) ||
      (task?.kind === 'command' && intentions.length === 0) ||
      intentions.some(intent => {
        if (!validSpan(intent) || !task || !inSpan(intent.startMs, task) || !inSpan(intent.endMs, task) ||
            !isText(intent.intentId) || ids.has(intent.intentId) || !gestures.has(intent.gestureId) ||
            (intent.actionId !== null && !Object.hasOwn(actionNames, intent.actionId))) return true;
        ids.add(intent.intentId);
        return false;
      })) {
    issues.push('需要逐条填写唯一意图 ID、起止时间、目标手势及目标功能；纯自然轮填写空数组。');
  }
  return issues;
}

export function preflightStudy(run, labels) {
  const missing = alignmentIssues(run, labels);
  if (run?.source?.kind === 'synthetic' || run?.source?.synthetic === true) {
    missing.push('需要真人 run；合成轨迹只能验证机制。');
  }
  const gestures = run?.profile?.gestures;
  if (run?.mode !== 'recognition' || !Array.isArray(gestures) ||
      !gestures.some(gesture => Array.isArray(gesture?.positives) && gesture.positives.length > 0)) {
    missing.push('需要使用包含个人示范的配置运行识别。');
  }
  if (!isText(labels?.rawVideo?.file) || !Number.isFinite(labels.rawVideo.offsetMs)) {
    missing.push('需要原始摄像头视频文件名及原视频到轨迹媒体时间的偏移（毫秒）。');
  }
  return {ready: missing.length === 0, missing};
}

// Augmenting paths keep matching one-to-one even when intent windows overlap.
function match(intents, candidates, allowed) {
  const owners = new Map();
  function assign(intent, seen) {
    for (const item of candidates.get(intent.intentId)) {
      if (seen.has(item.index) || !allowed(intent, item)) continue;
      seen.add(item.index);
      const prior = owners.get(item.index);
      if (!prior || assign(prior.intent, seen)) {
        owners.set(item.index, {intent, item});
        return true;
      }
    }
    return false;
  }
  for (const intent of intents) assign(intent, new Set());
  return [...owners.values()];
}

export function alignIntentions(run, labels, {earlyMs = 0, lateMs = 350} = {}) {
  const issues = alignmentIssues(run, labels);
  if (issues.length) throw new Error(issues.join('\n'));
  if ([earlyMs, lateMs].some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('匹配的提前和延后容差需要是非负毫秒数。');
  }
  const intents = [...labels.intentions].sort((a, b) => a.startMs - b.startMs);
  const events = run.events.map((event, index) => ({event, index}))
    .filter(({event}) => inSpan(event.tMs, labels.task));
  const candidates = new Map(intents.map(intent => [
    intent.intentId,
    events.filter(({event}) => event.tMs >= intent.startMs - earlyMs && event.tMs <= intent.endMs + lateMs)
      .sort((a, b) => Math.abs(a.event.tMs - intent.endMs) - Math.abs(b.event.tMs - intent.endMs)),
  ]));

  const correct = match(intents, candidates, (intent, {event}) => sameCommand(intent, event));
  const correctIntents = new Set(correct.map(({intent}) => intent.intentId));
  const used = new Set(correct.map(({item}) => item.index));
  const wrong = match(intents.filter(intent => !correctIntents.has(intent.intentId)), candidates,
    (_intent, item) => !used.has(item.index));
  const pairedIntents = new Set([...correctIntents, ...wrong.map(({intent}) => intent.intentId)]);
  for (const {item} of wrong) used.add(item.index);

  const review = [];
  function add(kind, intent = null, item = null) {
    const reviewId = JSON.stringify([kind, intent?.intentId ?? null, item?.index ?? null]);
    review.push({reviewId, kind, intent, eventIndex: item?.index ?? null, event: item?.event ?? null});
  }
  for (const {intent, item} of wrong) {
    add(intent.gestureId === item.event.gestureId ? 'wrong_action' : 'wrong_class', intent, item);
  }
  for (const intent of intents) {
    if (!pairedIntents.has(intent.intentId)) add('missed', intent);
  }
  for (const item of events) {
    if (used.has(item.index)) continue;
    const duplicate = correct.find(({intent}) => sameCommand(intent, item.event) &&
      candidates.get(intent.intentId).includes(item));
    add(duplicate ? 'duplicate' : 'false_trigger', duplicate?.intent, item);
  }
  return {
    runId: run.runId, profileRevisionId: run.profile.revisionId, task: labels.task, earlyMs, lateMs,
    matched: correct.map(({intent, item}) => ({intentId: intent.intentId, eventIndex: item.index})),
    review,
  };
}

export function applyConfirmedReviews(input, run, labels, decisions, tolerance) {
  const {profile} = compileProfile(input);
  const {review} = alignIntentions(run, labels, tolerance);
  if (profile.participantId !== labels.participantId || !Array.isArray(decisions) || !decisions.length) {
    throw new Error('校准需要同一参与者的配置和已复核的处理决定。');
  }
  const gestures = new Map(profile.gestures.map(gesture => [gesture.gestureId, {...gesture}]));
  const edits = [];
  for (const decision of decisions) {
    const item = review.find(entry => entry.reviewId === decision?.reviewId);
    if (!item || decision.status !== 'confirmed' || !['positive', 'negative', 'ignore'].includes(decision.kind)) {
      throw new Error('每条处理决定必须引用待复核项并标记 confirmed。');
    }
    const {kind} = decision;
    if (kind === 'ignore') {
      edits.push({reviewId: item.reviewId, kind});
      continue;
    }
    const gestureId = kind === 'positive' ? item.intent?.gestureId : item.event?.gestureId;
    const gesture = gestures.get(gestureId);
    const field = kind === 'positive' ? 'positives' : 'negatives';
    if (!gesture || (kind === 'positive' && !['missed', 'wrong_class'].includes(item.kind)) ||
        (kind === 'negative' && item.kind === 'wrong_action') ||
        gesture[field].some(sample => sample.source.runId === run.runId && sample.source.reviewId === item.reviewId)) {
      throw new Error('复核项与样例类别不对应，或这条复核已加入该类。');
    }

    let frames;
    if (kind === 'negative' && decision.clip === undefined) {
      frames = item.event.frames;
      if (!Array.isArray(frames) || !frames.length) throw new Error('事件缺少候选窗口，请填写复核片段。');
    } else {
      if (!validSpan(decision.clip) || !inSpan(decision.clip.startMs, labels.task) ||
          !inSpan(decision.clip.endMs, labels.task)) {
        throw new Error('请明确标出任务区间内经人工确认的样例片段。');
      }
      frames = prepareExample(run.frames.filter(frame => inSpan(frame.tMs, decision.clip)), profile.settings);
    }
    const source = {
      kind: run.source?.synthetic === true ? 'synthetic' : run.source?.kind,
      runId: run.runId, name: run.source?.name ?? null, sourceMirrored: run.source?.sourceMirrored ?? null,
      rawVideo: labels.rawVideo ?? null, reviewId: item.reviewId, reviewKind: item.kind,
      intentId: item.intent?.intentId ?? null, eventIndex: item.eventIndex,
    };
    const sample = createExample(frames, source, 'confirmed_review');
    gesture[field] = [...gesture[field], sample];
    edits.push({reviewId: item.reviewId, gestureId, kind, sampleId: sample.sampleId});
  }
  return reviseProfile(profile, {gestures: [...gestures.values()]}, {
    kind: 'calibration', runId: run.runId, reviewedProfileRevisionId: run.profile.revisionId, edits,
  });
}

export function compareProfiles(inputRun, profiles) {
  const frames = readTrajectory(inputRun);
  if (!Array.isArray(profiles) || !profiles.length) throw new Error('需要至少一份待比较配置。');
  return profiles.map(profile => {
    const result = replay(frames, profile);
    const source = {
      kind: 'replay', inputRunId: inputRun.runId ?? null, name: inputRun.source?.name ?? null,
      sourceMirrored: inputRun.source?.sourceMirrored ?? frames[0].sourceMirrored ?? null,
      synthetic: inputRun.source?.kind === 'synthetic' || inputRun.source?.synthetic === true,
    };
    return {...createRun(result.profile, source, 'recognition'), ...result, frames};
  });
}
