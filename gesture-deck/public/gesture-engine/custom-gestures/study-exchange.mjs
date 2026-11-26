import {readTrajectory} from './recognizer.mjs';

export const studyGroups = Object.freeze(['A', 'B', 'C']);
export const normalizeSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

const profileHash = profile => sha256(new TextEncoder().encode(JSON.stringify(profile)));

export async function freezeStudy(results, trajectory, tolerance) {
  const calibrationVideoSha256 = normalizeSha256(trajectory.source?.sha256);
  if (!calibrationVideoSha256) throw new Error('校准轨迹需要原视频的 SHA-256 校验值。');
  const profiles = Object.fromEntries(studyGroups.map(group => [group, results[group].run.profile]));
  const hashes = Object.fromEntries(await Promise.all(studyGroups.map(async group => [group, await profileHash(profiles[group])])));
  return {version: 1, profiles, hashes, tolerance, calibrationVideoSha256};
}

export async function verifyStudyBundle(bundle, trajectory) {
  const calibrationHash = normalizeSha256(bundle?.calibrationVideoSha256);
  if (bundle?.version !== 1 || !calibrationHash ||
      studyGroups.some(group => !bundle.profiles?.[group] || !bundle.hashes?.[group])) {
    throw new Error('请选择网页导出的 A、B、C 实验包。');
  }
  const hashes = await Promise.all(studyGroups.map(group => profileHash(bundle.profiles[group])));
  if (studyGroups.some((group, index) => hashes[index] !== normalizeSha256(bundle.hashes[group]))) {
    throw new Error('冻结配置的校验值已变化。');
  }
  if (bundle.tolerance !== undefined && [bundle.tolerance?.earlyMs, bundle.tolerance?.lateMs]
    .some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('冻结实验包的时间容差需为非负毫秒数。');
  }
  if (trajectory) {
    const videoHash = normalizeSha256(trajectory.source?.sha256);
    if (!videoHash || videoHash === calibrationHash) {
      throw new Error('回放评估需要用另一段原视频或对应轨迹。');
    }
    const usedForTraining = studyGroups.some(group => bundle.profiles[group].gestures?.some(gesture =>
      [...gesture.positives, ...gesture.negatives].some(sample => normalizeSha256(sample.source?.videoSha256) === videoHash)));
    if (usedForTraining) throw new Error('这段视频已用于冻结配置的示范或学习，请选择另一段试讲。');
  }
  return bundle;
}

function resolveLabel(gestureName, profile) {
  const choices = profile.gestures.filter(gesture => gesture.name === gestureName);
  if (choices.length !== 1) throw new Error('配置中需有唯一的手势名称「' + gestureName + '」。');
  return choices[0];
}

export function buildStudyLabels(trajectory, profile, text, imported) {
  const frames = readTrajectory(trajectory);
  const videoHash = normalizeSha256(trajectory.source?.sha256);
  if (!videoHash || !trajectory.runId) throw new Error('轨迹需要包含来源视频的 SHA-256 校验值和 runId。');
  if (!profile.participantId) throw new Error('请先为配置填写参与者编号。');
  const task = {kind: 'mixed', startMs: frames[0].tMs, endMs: frames.at(-1).tMs};
  const base = {
    version: 1, complete: true, timeline: 'media-ms', participantId: profile.participantId,
    runId: trajectory.runId, task,
    rawVideo: {file: trajectory.source.name, sha256: videoHash, offsetMs: 0},
  };
  if (imported) {
    if (imported.version !== 1 || imported.timeline !== 'media-ms' || imported.complete !== true ||
        normalizeSha256(imported.rawVideo?.sha256) !== videoHash || imported.participantId !== profile.participantId) {
      throw new Error('导入的标注需与所选视频校验值和配置编号一致。');
    }
    if (!Array.isArray(imported.intentions) || !imported.task) throw new Error('上传的标注缺少任务或意图列表。');
    const startMs = Math.max(imported.task.startMs, task.startMs);
    const endMs = Math.min(imported.task.endMs, task.endMs);
    if (startMs - imported.task.startMs > 80 || imported.task.endMs - endMs > 80) {
      throw new Error('标注任务区间超出实际视频长度。');
    }
    const intentions = imported.intentions.map(intent => {
      const gesture = profile.gestures.find(s => s.gestureId === intent.gestureId) ??
        resolveLabel(intent.name, profile);
      return {...intent, gestureId: gesture.gestureId,
        actionId: Object.hasOwn(intent, 'actionId') ? intent.actionId : gesture.actionId};
    });
    return {...imported, ...base, task: {...imported.task, startMs, endMs}, intentions};
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error('请输入标注，或在无主动手势的视频中填写「无指令」。');
  if (trimmed === '无指令') return {...base, task: {...task, kind: 'natural'}, intentions: []};
  const intentions = trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const parsed = line.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)$/);
    if (!parsed) throw new Error('第 ' + (index + 1) + ' 行格式应为「开始秒数 结束秒数 手势名称」。');
    const [, start, end, name] = parsed;
    const startMs = Math.round(Number(start) * 1000), endMs = Math.round(Number(end) * 1000);
    if (startMs < task.startMs || endMs <= startMs || endMs > task.endMs) {
      throw new Error('第 ' + (index + 1) + ' 行时间必须递增并位于视频内。');
    }
    const {gestureId, actionId} = resolveLabel(name, profile);
    return {intentId: 'video-intent-' + (index + 1), name, gestureId, actionId, startMs, endMs};
  });
  return {...base, intentions};
}

export function compactStudyResults(results) {
  return Object.fromEntries(studyGroups.map(group => {
    const {run, metrics, alignment} = results[group];
    return [group, {
      profileRevisionId: run.profile.revisionId, metrics, matched: alignment.matched,
      events: run.events.map(({frames, ...event}) => event),
      errors: alignment.review.map(({event, ...item}) => ({
        ...item, event: event ? {gestureName: event.gestureName, tMs: event.tMs, actionId: event.actionId} : null,
      })),
    }];
  }));
}
