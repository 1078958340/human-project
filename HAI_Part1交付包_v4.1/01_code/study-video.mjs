import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {calibrateStudy, evaluateStudy, studyTolerance} from './custom-gestures/auto-study.mjs';
import {withSensitiveMatching} from './custom-gestures/profile.mjs';

const [, , mode, first, trajectoryPath, labelPath, outputDir, ...flags] = process.argv;
if (!['calibrate', 'validate', 'replay'].includes(mode) || !outputDir ||
    flags.some(flag => mode !== 'calibrate' || !['--sensitive', '--all-positives'].includes(flag))) {
  throw new Error('用法：node study-video.mjs calibrate PROFILE TRAJECTORY LABELS NEW_OUTPUT_DIR [--sensitive] [--all-positives]\n' +
    '或 node study-video.mjs validate|replay CALIBRATION_DIR TRAJECTORY LABELS NEW_OUTPUT_DIR');
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = value => createHash('sha256').update(value).digest('hex');
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const write = (name, data) => fs.writeFileSync(path.join(outputDir, name),
  serialize(data), {encoding: 'utf8', flag: 'wx'});
const trajectory = read(trajectoryPath);
const labels = read(labelPath);
if (labels.rawVideo?.sha256 && labels.rawVideo.sha256 !== trajectory.source?.sha256) {
  throw new Error('意图标注对应的视频校验值不同，请检查输入。');
}

const stages = ['A', 'B', 'C'];
const seconds = ms => Number.isFinite(ms) ? (ms / 1000).toFixed(3) : '—';
const row = values => '| ' + values.join(' | ') + ' |';
const names = new Map();

function compact(event) {
  if (!event) return null;
  const {frames, ...summary} = event;
  return summary;
}

function details({run, metrics, alignment}) {
  return {
    profileRevisionId: run.profile.revisionId, metrics,
    events: run.events.map(compact), rejections: run.rejections, matched: alignment.matched,
    errors: alignment.review.map(({event, ...rest}) => ({...rest, event: compact(event)})),
  };
}

function createReport(results, samples) {
  const className = id => names.get(id) ?? id;
  const header = mode === 'calibrate' ? '标注视频的开发对照' :
    mode === 'replay' ? '既有视频复用回放' : '独立视频的冻结配置验证';
  const lines = [
    '# ' + labels.participantId + ' ' + header,
    '',
    '视频 ' + trajectory.source.name + '。任务区间 ' + seconds(labels.task.startMs) + '–' + seconds(labels.task.endMs) + ' 秒。',
    mode === 'calibrate' ? '同一轨迹用于自动补样例和开发回放。独立成绩应使用另外录制的验证视频。' :
      mode === 'replay' ? '视频已用于此前评估。本轮仅以冻结配置复测，不作为新的独立验证。' :
        '使用校准后已经冻结的 A、B、C 三份配置。此流程只计算指标。',
    '',
    '| 组别 | 正确 / 标注 | 漏检 | 错类 | 错绑定 | 重复 | 非意图触发 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const stage of stages) {
    const {intended, correct, missed, wrongClass, wrongAction, duplicate, falseTrigger} = results[stage].metrics;
    lines.push(row([stage, correct + ' / ' + intended, missed, wrongClass, wrongAction, duplicate, falseTrigger]));
  }
  lines.push('', '## 每次标注意图的判定时刻', '',
    '| 意图 | 对齐区间（秒） | A | B | C |', '| --- | --- | ---: | ---: | ---: |');
  for (const intent of labels.intentions) {
    const times = stages.map(stage => {
      const {alignment, run} = results[stage];
      const matched = alignment.matched.find(item => item.intentId === intent.intentId);
      if (matched) return seconds(run.events[matched.eventIndex].tMs);
      const miss = alignment.review.find(error => error.intent?.intentId === intent.intentId);
      return miss?.event ? '错发 ' + miss.event.gestureName : '漏检';
    });
    lines.push(row([className(intent.gestureId), seconds(intent.startMs) + '–' + seconds(intent.endMs), ...times]));
  }
  if (samples) {
    lines.push('', '## 自动学习', '',
      'A 使用本轮导入示范。B 在 A 上补充标注意图区间内的正例。C 在 B 上加入非意图触发和错类对应的反例。',
      '',
      '补正例 ' + samples.positives.length + ' 条。提取不同反例 ' + samples.proposedNegatives.length +
        ' 条，C 采用 ' + samples.accepted.length + ' 条。',
      '',
      '| 极性 | 类别 | 片段（秒） | 依据 |',
      '| --- | --- | --- | --- |');
    for (const {kind, gestureId, sample} of [...samples.positives, ...samples.accepted]) {
      const {source} = sample;
      const basis = kind === 'positive' ? source.intentId : seconds(source.tMs) + ' 秒触发';
      lines.push(row([kind === 'positive' ? '正例' : '反例', className(gestureId),
        seconds(source.startMs) + '–' + seconds(source.endMs), basis]));
    }
  }
  lines.push('', '追踪中断和未匹配候选作为诊断写入 evaluation.json。非意图触发只统计实际发出的识别事件。', '');
  return lines.join('\n');
}

if (fs.existsSync(outputDir)) throw new Error('请选择一个新输出目录，原实验记录会保留。');
let results, samples, freeze;
if (mode === 'calibrate') {
  const submitted = read(first);
  const profile = flags.includes('--sensitive') ? withSensitiveMatching(submitted) : submitted;
  const allPositives = flags.includes('--all-positives');
  const result = calibrateStudy(trajectory, profile, labels, studyTolerance, {allPositives});
  results = Object.fromEntries(stages.map(stage => [stage, result[stage]]));
  const {positives, proposedNegatives, accepted, skippedPositives, skippedNegatives} = result;
  samples = {positives, proposedNegatives, accepted, skippedPositives, skippedNegatives};
  freeze = {
    version: 1, participantId: labels.participantId, calibrationVideoSha256: trajectory.source.sha256,
    calibrationRunId: trajectory.runId, tolerance: studyTolerance,
    matchingPreset: results.A.run.profile.matchingPreset ?? 'classic',
    allPositives,
    profiles: Object.fromEntries(stages.map(stage => [stage, {
      file: stage + '-profile-v4.json', revisionId: results[stage].run.profile.revisionId,
      sha256: digest(serialize(results[stage].run.profile)),
    }])),
  };
} else {
  freeze = read(path.join(first, 'experiment.json'));
  if (!trajectory.source?.sha256 || trajectory.source.sha256 === freeze.calibrationVideoSha256 ||
      trajectory.runId === freeze.calibrationRunId || labels.participantId !== freeze.participantId) {
    throw new Error('回放评估需要与校准轮不同的原视频及对应配置的标注。');
  }
  results = Object.fromEntries(stages.map(stage => {
    const reference = freeze.profiles[stage];
    const bytes = fs.readFileSync(path.join(first, reference.file));
    if (digest(bytes) !== reference.sha256) throw new Error('冻结配置的校验值已变化。');
    const profile = JSON.parse(bytes.toString('utf8'));
    if (profile.revisionId !== reference.revisionId) throw new Error('冻结配置版本发生变化。');
    return [stage, evaluateStudy(trajectory, profile, labels, freeze.tolerance)];
  }));
}

for (const gesture of results.A.run.profile.gestures) names.set(gesture.gestureId, gesture.name);
fs.mkdirSync(outputDir);
if (samples) {
  for (const stage of stages) write(freeze.profiles[stage].file, results[stage].run.profile);
  write('calibration-samples.json', samples);
  write('experiment.json', freeze);
}
write('evaluation.json', {
  stage: mode === 'calibrate' ? 'calibration' : mode === 'replay' ? 'replay' : 'validation',
  source: trajectory.source, runId: trajectory.runId, labels, experiment: freeze,
  profiles: Object.fromEntries(stages.map(stage => [stage, details(results[stage])])),
});
fs.writeFileSync(path.join(outputDir, 'report.md'), createReport(results, samples), {encoding: 'utf8', flag: 'wx'});
console.log(JSON.stringify(Object.fromEntries(stages.map(stage => [stage, results[stage].metrics])), null, 2));
