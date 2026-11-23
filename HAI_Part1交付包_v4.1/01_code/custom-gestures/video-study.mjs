import {createTracker, scanVideo} from '../tracker.mjs';
import {withSensitiveMatching} from './profile.mjs';
import {createRun, readTrajectory} from './recognizer.mjs';
import {buildStudyLabels, sha256, studyGroups} from './study-exchange.mjs';

const el = id => document.getElementById(id);
const status = text => { el('studyProgress').textContent = text; };
const readJson = async file => JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
const aborted = () => new DOMException('已取消。', 'AbortError');
const groupLabels = {A: 'A · 原示范', B: 'B · 加正例', C: 'C · 再加反例'};
const form = el('studyForm');
let current, completed, previewUrl;

function updateMode() {
  const evaluate = el('studyMode').value === 'evaluate';
  el('studyProfileLabel').textContent = evaluate ? '冻结的 A/B/C 实验包' : '本轮示范配置';
  el('studyStart').textContent = evaluate ? '开始评估' : '开始学习';
  el('studyPresetNote').hidden = evaluate;
  el('studyReusedRow').hidden = !evaluate;
}

function preview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const file = el('studySource').files[0];
  const video = el('studyPreview');
  const isVideo = file && !file.name.toLowerCase().endsWith('.json');
  video.hidden = !isVideo;
  el('studyMirrorRow').hidden = Boolean(file && !isVideo);
  previewUrl = isVideo ? URL.createObjectURL(file) : null;
  if (previewUrl) video.src = previewUrl;
  else video.removeAttribute('src');
}

async function captureTrajectory(file, profile, mirrored, signal) {
  status('正在读取原视频并校验来源…');
  const checksum = await sha256(await file.arrayBuffer());
  signal.throwIfAborted();
  const run = createRun(profile, {
    kind: 'video', name: file.name, sha256: checksum, sourceMirrored: mirrored, extractor: '网页 MediaPipe WASM',
  }, 'capture');
  status('正在加载本地手部追踪模型…');
  const tracker = await createTracker({sourceMirrored: mirrored, handMode: 'multi'});
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  let cancel, stop;
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      stop = () => { cancel?.(); reject(aborted()); };
      signal.addEventListener('abort', stop, {once: true});
      cancel = scanVideo(video, tracker, frame => run.frames.push(frame),
        (read, total) => status('正在提取手部关键点 ' + Math.round(read / total * 100) + '%'),
        resolve, reject);
    });
    return run;
  } finally {
    signal.removeEventListener('abort', stop);
    cancel?.();
    tracker.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function runWorker(payload, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./video-study-worker.mjs', import.meta.url), {type: 'module'});
    function finish(callback, value) {
      worker.terminate();
      signal.removeEventListener('abort', cancel);
      callback(value);
    }
    const cancel = () => finish(reject, aborted());
    signal.addEventListener('abort', cancel, {once: true});
    worker.onmessage = ({data}) => {
      if (data.error) finish(reject, new Error(data.error));
      else finish(resolve, data);
    };
    worker.onerror = event => finish(reject, new Error(event.message || '视频学习任务异常。'));
    worker.postMessage(payload);
  });
}

function setRunning(running) {
  for (const field of form.elements) field.disabled = running;
  el('studyCancel').disabled = !running;
}

function renderResult(result, label) {
  el('studyResultNote').textContent = result.samples ?
    label + '。补入正例 ' + result.samples.positives.length + ' 条，采纳反例 ' + result.samples.accepted.length + ' 条。' :
    label + '。三组均使用实验包里的冻结配置。';
  const rows = studyGroups.map(group => {
    const {correct, intended, missed, wrongClass, duplicate, falseTrigger} = result.report[group].metrics;
    const row = document.createElement('tr');
    for (const value of [groupLabels[group], correct + '/' + intended, missed, wrongClass, duplicate, falseTrigger]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  el('studyRows').replaceChildren(...rows);
  el('studyDownloadC').hidden = !result.bundle;
  el('studyDownloadBundle').hidden = !result.bundle;
  el('studyResult').hidden = false;
}

function download(suffix, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  const participant = completed.labels.participantId.replace(/[^\w-]/g, '_');
  link.download = participant + '-' + suffix + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

form.onsubmit = async event => {
  event.preventDefault();
  if (current) return;
  const mode = el('studyMode').value;
  const source = el('studySource').files[0];
  const config = el('studyProfile').files[0];
  if (!source || !config) return status('请选择配置和视频。');
  const controller = new AbortController();
  current = controller;
  completed = null;
  el('studyResult').hidden = true;
  setRunning(true);
  status('正在读取配置和标注…');
  try {
    const input = await readJson(config);
    const profile = mode === 'learn' ? withSensitiveMatching(input) : input?.profiles?.A;
    if (!profile) throw new Error('请选择网页导出的 A、B、C 实验包。');
    const trajectory = source.name.toLowerCase().endsWith('.json') ? await readJson(source) :
      await captureTrajectory(source, profile, el('studyMirror').checked, controller.signal);
    const labelFile = el('studyLabels').files[0];
    const labels = buildStudyLabels(trajectory, profile, el('studyAnnotations').value,
      labelFile ? await readJson(labelFile) : null);
    controller.signal.throwIfAborted();
    const reused = el('studyReused').checked || labels.stage === 'replay' || labels.datasetScope === 'reused_validation';
    const label = mode === 'learn' ? '校准视频开发回放' : reused ? '既有视频复用回放' : '冻结配置回放';
    status(mode === 'learn' ? '正在匹配标注并比较正例、反例…' : '正在回放冻结的 A、B、C…');
    const result = await runWorker({mode, trajectory, labels, profile, bundle: mode === 'evaluate' ? input : null}, controller.signal);
    completed = {...result, label, labels, source: trajectory.source};
    renderResult(result, label);
    status('已完成。');
  } catch (error) {
    status(error.name === 'AbortError' ? '已取消。' : error.message);
  } finally {
    current = null;
    setRunning(false);
  }
};

el('studyMode').onchange = updateMode;
el('studySource').onchange = preview;
el('studyCancel').onclick = () => current?.abort(aborted());
el('studyDownloadC').onclick = () => download('C-profile', completed.bundle.profiles.C);
el('studyDownloadBundle').onclick = () => download('study-bundle', completed.bundle);
el('studyDownloadReport').onclick = () => {
  const {bundle, ...result} = completed;
  download('study-report', result);
};
window.addEventListener('pagehide', () => {
  current?.abort(aborted());
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});
updateMode();
