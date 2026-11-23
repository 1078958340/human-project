import {dtw} from '../development-v41/recognizer-development.mjs';
import {actionNames} from './actions.mjs';
import {coordinateSystem, trackerVersion, featureVersion, legacyTrackerVersion, poseDistance} from './hand-features.mjs';
import {motionDefaults, gestureTypes, describeClip, clipErrors} from './trajectory.mjs';

export const engineVersion = 'pose-knn-motion-dtw-v3';
export const profileVersion = 3;
export const defaults = Object.freeze({
  ...motionDefaults, staticAmbiguityMargin: 0.035, dynamicAmbiguityMargin: 0.070,
});
const classDefaults = Object.freeze({
  static: Object.freeze({threshold: 0.145, negativeMargin: 0.036}),
  dynamic: Object.freeze({threshold: 0.30, negativeMargin: 0.070}),
});

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

export function createGesture(name, actionId = null, type = 'dynamic') {
  if (!Object.hasOwn(gestureTypes, type)) throw new Error('请选择有效的手势类型。');
  return {
    gestureId: crypto.randomUUID(), name, type, actionId,
    settings: {...classDefaults[type]}, positives: [], negatives: [],
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

function compileExamples(examples, type, settings, sampleIds, label) {
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
    const result = describeClip(frames, type, settings);
    if (!result.feature) throw new Error(label + '的样例无效。' + clipErrors[result.reason]);
    sampleIds.add(sampleId);
    return {sampleId, feature: result.feature, extent: result.extent};
  });
}

export function compileProfile(input) {
  if (input?.version === 1) {
    throw new Error('这是 4.1 配置。请在开发版 4.1 页面加载原配置；新版可另外回放旧 run 的轨迹。');
  }
  if (input?.version === 2) {
    throw new Error('这是 v2 配置，请先通过新版页面导入，或用 importProfile 升级。');
  }
  if (input?.version !== profileVersion || input.engineVersion !== engineVersion ||
      input.trackerVersion !== trackerVersion || input.featureVersion !== featureVersion ||
      input.coordinateSystem !== coordinateSystem) {
    throw new Error('配置版本不兼容，需要自定义手势 v3 的识别、追踪、特征和坐标版本。');
  }
  if ((input.participantId !== null && !hasText(input.participantId)) ||
      !hasText(input.revisionId) || (input.parentRevisionId !== null && !hasText(input.parentRevisionId)) ||
      !Array.isArray(input.history) || !Array.isArray(input.gestures)) {
    throw new Error('配置缺少参与者字段、修订信息或手势列表。');
  }
  const settings = effectiveSettings(input.settings, defaults, '全局');
  if (settings.maxMs < settings.minMs || settings.quietPalm >= settings.minPalmMotion ||
      settings.quietPose >= settings.minPoseMotion || settings.releasePose <= settings.quietPose ||
      settings.staticHoldMs < settings.examplePoseMs) {
    throw new Error('全局动作时长、静止阈值或手型释放参数无效。');
  }

  const ids = new Set(), sampleIds = new Set();
  const classes = input.gestures.map(gesture => {
    const {gestureId, name, type, actionId} = gesture ?? {};
    if (!hasText(gestureId) || ids.has(gestureId) || !hasText(name) || !Object.hasOwn(gestureTypes, type) ||
        (actionId !== null && !Object.hasOwn(actionNames, actionId))) {
      throw new Error('手势 ID 必须唯一，且名称、手势类型及功能绑定必须有效。');
    }
    ids.add(gestureId);
    const classSettings = effectiveSettings(gesture.settings, classDefaults[type], name + '：');
    return {
      gesture: {...gesture, settings: classSettings},
      positive: compileExamples(gesture.positives, type, settings, sampleIds, name + '正例'),
      negative: compileExamples(gesture.negatives, type, settings, sampleIds, name + '反例'),
    };
  });
  return {profile: {...input, settings, gestures: classes.map(item => item.gesture)}, classes};
}

export function importProfile(input) {
  if (input?.version !== 2) return compileProfile(input).profile;
  if (input.engineVersion !== 'dtw-custom-v2' || input.featureVersion !== 'palm-path-20-v1' ||
      input.trackerVersion !== legacyTrackerVersion || input.coordinateSystem !== coordinateSystem ||
      !hasText(input.revisionId) || !Array.isArray(input.gestures) ||
      !Array.isArray(input.history) || input.gestures.some(gesture => gesture?.type !== 'right_hand_dynamic')) {
    throw new Error('v2 配置缺少原版本信息或示范，无法升级。');
  }
  const versioned = {
    ...input, version: profileVersion, engineVersion, trackerVersion, featureVersion,
    settings: {...defaults},
    gestures: input.gestures.map(gesture => ({...gesture, type: 'dynamic', settings: {...classDefaults.dynamic}})),
  };
  return reviseProfile(versioned, {}, {
    kind: 'migrate_v2', fromEngineVersion: input.engineVersion, fromFeatureVersion: input.featureVersion,
    previousSettings: input.settings, previousClassSettings: input.gestures.map(({gestureId, settings}) => ({gestureId, settings})),
  });
}

export function createExample(frames, source, confirmation = 'registration') {
  return {
    sampleId: crypto.randomUUID(), confirmation,
    source: {...source, startMs: frames[0].tMs, endMs: frames.at(-1).tMs}, frames,
  };
}

export function featureDistance(type, a, b) {
  return type === 'static' ? poseDistance(a, b) : dtw(a, b);
}

export function findSimilarClasses(profile, gestureId, frames) {
  const {profile: effective, classes} = compileProfile(profile);
  const current = effective.gestures.find(gesture => gesture.gestureId === gestureId);
  if (!current) throw new Error('请选择手势。');
  const {feature, reason} = describeClip(frames, current.type, effective.settings);
  if (!feature) throw new Error(clipErrors[reason]);
  const margin = current.type === 'static' ? effective.settings.staticAmbiguityMargin : effective.settings.dynamicAmbiguityMargin;
  return classes.filter(({gesture, positive}) => gesture.gestureId !== gestureId && gesture.type === current.type &&
    positive.some(template => featureDistance(current.type, feature, template.feature) <= Math.max(margin,
      Math.min(current.settings.threshold, gesture.settings.threshold) * 0.6)))
    .map(({gesture}) => gesture.name);
}

