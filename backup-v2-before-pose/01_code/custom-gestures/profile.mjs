import {dtw} from '../development-v41/recognizer-development.mjs';
import {actionNames} from './actions.mjs';
import {
  coordinateSystem, trackerVersion, featureVersion, motionDefaults, describeClip, clipErrors,
} from './trajectory.mjs';

export const engineVersion = 'dtw-custom-v2';
export const profileVersion = 2;
export const defaults = Object.freeze({...motionDefaults, ambiguityMargin: 0.10});
export const classDefaults = Object.freeze({threshold: 0.30, negativeMargin: 0.08});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && value.trim().length > 0;

export function createProfile(participantId = null) {
  return {
    version: profileVersion, engineVersion, trackerVersion, featureVersion, coordinateSystem,
    participantId, revisionId: crypto.randomUUID(), parentRevisionId: null,
    settings: {...defaults}, gestures: [], history: [],
  };
}

export function reviseProfile(profile, patch, change) {
  return compileProfile({
    ...profile, ...patch,
    parentRevisionId: profile.revisionId, revisionId: crypto.randomUUID(),
    history: [...profile.history, {
      ...change, at: new Date().toISOString(), parentRevisionId: profile.revisionId,
    }],
  }).profile;
}

export function createGesture(name, actionId = null) {
  return {
    gestureId: crypto.randomUUID(), name, type: 'right_hand_dynamic', actionId,
    settings: {...classDefaults}, positives: [], negatives: [],
  };
}

function effectiveSettings(overrides, base, label) {
  if (!isRecord(overrides) || Object.keys(overrides).some(key => !Object.hasOwn(base, key))) {
    throw new Error(label + '含未知或无效参数。');
  }
  const settings = {...base, ...overrides};
  if (Object.values(settings).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error(label + '参数必须为有限正数。');
  }
  return settings;
}

function compileExamples(examples, settings, sampleIds, label) {
  if (!Array.isArray(examples)) throw new Error(label + '应为数组。');
  return examples.map(example => {
    const {sampleId, frames, source, confirmation} = example ?? {};
    if (!hasText(sampleId) || sampleIds.has(sampleId) || !isRecord(source) ||
        !hasText(source.runId) || !['camera', 'video', 'replay', 'synthetic'].includes(source.kind) ||
        !['registration', 'confirmed_review'].includes(confirmation) ||
        !Array.isArray(frames) || !Number.isFinite(source.startMs) || !Number.isFinite(source.endMs) ||
        source.startMs !== frames[0]?.tMs || source.endMs !== frames.at(-1)?.tMs) {
      throw new Error(label + '的样例 ID、来源、时间或确认状态无效。');
    }
    const result = describeClip(frames, settings);
    if (!result.sequence) throw new Error(label + '的样例无效。' + clipErrors[result.reason]);
    sampleIds.add(sampleId);
    return {sampleId, sequence: result.sequence};
  });
}

export function compileProfile(input) {
  if (input?.version === 1) {
    throw new Error('这是旧版配置。请在开发版 4.1 页面加载原配置；新版可另外加载旧 run 的轨迹。');
  }
  if (input?.version !== profileVersion || input.engineVersion !== engineVersion ||
      input.trackerVersion !== trackerVersion || input.featureVersion !== featureVersion ||
      input.coordinateSystem !== coordinateSystem) {
    throw new Error('配置版本不兼容，需要自定义手势 v2 的识别、追踪、特征和坐标版本。');
  }
  if ((input.participantId !== null && !hasText(input.participantId)) ||
      !hasText(input.revisionId) || (input.parentRevisionId !== null && !hasText(input.parentRevisionId)) ||
      !Array.isArray(input.history) || !Array.isArray(input.gestures)) {
    throw new Error('配置缺少参与者字段、修订信息或手势列表。');
  }
  const settings = effectiveSettings(input.settings, defaults, '全局');
  if (settings.maxMs < settings.minMs || settings.quietDistance >= settings.minExcursion) {
    throw new Error('最长动作时长须不小于最短时长，静止半径须小于有效移动幅度。');
  }

  const ids = new Set(), sampleIds = new Set();
  const classes = input.gestures.map(gesture => {
    const {gestureId, name, type, actionId} = gesture ?? {};
    if (!hasText(gestureId) || ids.has(gestureId) || !hasText(name) || type !== 'right_hand_dynamic' ||
        (actionId !== null && !Object.hasOwn(actionNames, actionId))) {
      throw new Error('手势 ID 必须唯一，且名称、动态手势类型及功能绑定必须有效。');
    }
    ids.add(gestureId);
    const classSettings = effectiveSettings(gesture.settings, classDefaults, name + '：');
    return {
      gesture: {...gesture, settings: classSettings},
      positive: compileExamples(gesture.positives, settings, sampleIds, name + '正例'),
      negative: compileExamples(gesture.negatives, settings, sampleIds, name + '反例'),
    };
  });
  return {profile: {...input, settings, gestures: classes.map(item => item.gesture)}, classes};
}

export function createExample(frames, source, confirmation = 'registration') {
  return {
    sampleId: crypto.randomUUID(), confirmation,
    source: {...source, startMs: frames[0].tMs, endMs: frames.at(-1).tMs}, frames,
  };
}

export function findSimilarClasses(profile, gestureId, frames) {
  const {profile: effective, classes} = compileProfile(profile);
  const {sequence, reason} = describeClip(frames, effective.settings);
  if (!sequence) throw new Error(clipErrors[reason]);
  const current = effective.gestures.find(gesture => gesture.gestureId === gestureId);
  if (!current) throw new Error('请选择手势。');
  return classes.filter(({gesture, positive}) => gesture.gestureId !== gestureId &&
    positive.some(template => dtw(sequence, template.sequence) <= Math.max(effective.settings.ambiguityMargin,
      Math.min(current.settings.threshold, gesture.settings.threshold) * 0.6)))
    .map(({gesture}) => gesture.name);
}
