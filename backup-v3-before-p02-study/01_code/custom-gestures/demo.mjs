import {createTracker, watchVideo, scanVideo} from '../tracker.mjs';
import {
  importProfile, createProfile, reviseProfile, createGesture, createExample, findSimilarClasses, profileVersion,
} from './profile.mjs';
import {prepareExample, clipErrors, gestureTypes} from './trajectory.mjs';
import {createRecognizer, createRun, readTrajectory, replay} from './recognizer.mjs';
import {actionNames, createActionDispatcher} from './actions.mjs';

const el = id => document.getElementById(id);
const video = el('video');
const cards = ['开场', '主要内容', '总结'];
const rejectionNames = {
  ...clipErrors, no_templates: '暂无可匹配的正例', negative_match: '与本类反例过近',
  unknown: '未知动作', ambiguous: '多个类别过于接近',
};
const actionStatuses = {
  executed: '已执行', unbound: '未绑定功能', paused: '翻页已暂停', page_boundary: '已到页码边界',
};
const runNames = {camera: '摄像头', video: '原始录像', replay: '轨迹回放'};

let profile = createProfile();
let selectedGestureId = '', session = null, reading = false;
let savedRevisionId = profile.revisionId;
const runs = new Map();
const exportedFrames = new Map();

const status = message => { el('status').textContent = message; };
const selectedGesture = () => profile.gestures.find(gesture => gesture.gestureId === selectedGestureId);
const selectedRun = () => runs.get(el('runs').value);
const canEdit = () => !reading && (!session || (session.mode === 'capture' && session.run && !session.recording));

function renderControls() {
  const editing = canEdit();
  const current = selectedGesture();
  const ready = !session && !reading;
  const recordable = editing && session?.mode === 'capture' && current;
  for (const field of el('participantForm').elements) field.disabled = !ready;
  for (const field of el('addForm').elements) field.disabled = !editing;
  for (const field of el('editForm').elements) field.disabled = !editing || !current;
  for (const button of el('samples').querySelectorAll('button')) button.disabled = !editing;
  el('gesture').disabled = !editing || !profile.gestures.length;
  el('openCapture').disabled = !ready;
  el('openRecognition').disabled = !ready || !profile.gestures.some(gesture => gesture.positives.length);
  el('stop').disabled = !session;
  el('recordPositive').disabled = !recordable;
  el('recordNegative').disabled = !recordable;
  el('finishRecording').disabled = !session?.recording;
  for (const id of ['openVideo', 'openReplay', 'loadProfile', 'mirrored']) el(id).disabled = !ready;
  el('runs').disabled = !runs.size;
  el('exportRun').disabled = !selectedRun()?.frames.length;
}

function renderProfile() {
  el('participantId').value = profile.participantId ?? '';
  const list = el('gesture');
  list.replaceChildren(...profile.gestures.map(gesture =>
    new Option(gesture.name + ' · ' + gestureTypes[gesture.type], gesture.gestureId)));
  const current = selectedGesture();
  if (current) list.value = current.gestureId;
  else list.add(new Option('请先添加手势', ''));
  el('gestureName').value = current?.name ?? '';
  el('action').value = current?.actionId ?? '';
  el('threshold').value = current?.settings.threshold ?? '';
  el('negativeMargin').value = current?.settings.negativeMargin ?? '';
  el('sampleCount').textContent = current ? '正例 ' + current.positives.length + ' · 反例 ' + current.negatives.length : '';
  const entries = [];
  for (const [field, label] of [['positives', '正例'], ['negatives', '反例']]) {
    for (const [index, sample] of (current?.[field] ?? []).entries()) {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = label + ' ' + (index + 1) + ' · ' +
        Math.round(sample.source.endMs - sample.source.startMs) + ' ms';
      const button = document.createElement('button');
      button.textContent = '删除';
      button.className = 'quiet';
      button.setAttribute('aria-label', '删除' + label + ' ' + (index + 1));
      button.onclick = () => update(() => saveGesture({
        ...current, [field]: current[field].filter(item => item.sampleId !== sample.sampleId),
      }, {kind: 'remove_example', sampleId: sample.sampleId}), '样例已删除。');
      row.append(text, button);
      entries.push(row);
    }
  }
  el('samples').replaceChildren(...entries);
  renderControls();
}

function renderRun() {
  const run = selectedRun();
  const {page = 1, enabled = true} = run?.presentation ?? {};
  el('pageNumber').textContent = '第 ' + page + ' / ' + cards.length + ' 页';
  el('cardTitle').textContent = cards[page - 1];
  el('controlState').textContent = enabled ? '手势翻页已启用' : '手势翻页已暂停，恢复手势仍可识别';
  el('summary').textContent = run ?
    '识别 ' + run.events.length + ' 次 · 拒绝 ' + run.rejections.length + ' 段' : '暂无运行记录。';
  const last = [...(run?.events.slice(-20) ?? []), ...(run?.rejections.slice(-20) ?? [])]
    .sort((a, b) => b.tMs - a.tMs).slice(0, 20);
  el('entries').replaceChildren(...last.map(entry => {
    const row = document.createElement('li');
    const time = (entry.tMs / 1000).toFixed(2) + ' 秒 · ';
    row.textContent = entry.reason ?
      time + '拒绝 · ' + rejectionNames[entry.reason] :
      time + entry.gestureName + ' → ' + (actionNames[entry.actionId] ?? '未绑定') +
      ' · ' + actionStatuses[entry.actionResult.status] + ' · 距离 ' + entry.positiveDistance.toFixed(3);
    return row;
  }));
}

function update(change, message) {
  try {
    change();
    renderProfile();
    if (message) status(message);
  } catch (error) {
    status(error.message);
  }
}

function saveGesture(gesture, change) {
  const gestures = profile.gestures.map(item => item.gestureId === gesture.gestureId ? gesture : item);
  profile = reviseProfile(profile, {gestures}, {...change, gestureId: gesture.gestureId});
}

function addRun(run) {
  run.presentation = {page: 1, enabled: true};
  const list = el('runs');
  const time = new Date(run.startedAt).toLocaleTimeString('zh-CN', {hour12: false});
  list.add(new Option(time + ' · ' + runNames[run.source.kind] +
    (run.mode === 'capture' ? '注册' : '') + (run.source.name ? ' · ' + run.source.name : ''), run.runId), 0);
  runs.set(run.runId, run);
  list.value = run.runId;
  renderRun();
  const movePage = offset => {
    const next = run.presentation.page + offset;
    if (next < 1 || next > cards.length) return false;
    run.presentation.page = next;
    return true;
  };
  return createActionDispatcher({
    nextPage: () => movePage(1),
    previousPage: () => movePage(-1),
    onEnabledChange: enabled => { run.presentation.enabled = enabled; },
  });
}

function collectResult(run, dispatcher, result) {
  if (result?.rejection) run.rejections.push(result.rejection);
  if (result?.event) {
    const actionResult = dispatcher.dispatch(result.event);
    run.events.push({...result.event, actionResult: {...actionResult, page: run.presentation.page}});
  }
}

function release(context) {
  context.cancel?.();
  context.tracker?.close();
  context.stream?.getTracks().forEach(track => track.stop());
  if (context.url) URL.revokeObjectURL(context.url);
  context.cancel = context.tracker = context.stream = context.url = null;
}

function closeSource(message, outcome = 'stopped') {
  const context = session;
  if (!context) return;
  session = null;
  release(context);
  if (context.run) {
    context.run.finishedAt = new Date().toISOString();
    context.run.outcome = outcome;
  }
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  el('tracking').textContent = '当前没有运行中的视频源';
  renderControls();
  if (message) status(message);
}

async function startSource(mode, file = null) {
  if (session || reading) return;
  const context = {mode};
  session = context;
  const sourceMirrored = Boolean(file && el('mirrored').checked);
  renderControls();
  status('正在加载本地手部追踪模型…');
  const keep = () => {
    if (session === context) return true;
    release(context);
    return false;
  };
  const failed = error => {
    if (session === context) closeSource(error.message, 'error');
  };
  try {
    const recognizer = mode === 'recognition' ? createRecognizer(profile) : null;
    context.tracker = await createTracker({sourceMirrored, handMode: 'single'});
    if (!keep()) return;
    video.classList.toggle('mirrored', !sourceMirrored);
    if (file) {
      context.url = URL.createObjectURL(file);
      video.src = context.url;
    } else {
      status('等待浏览器摄像头授权…');
      context.stream = await navigator.mediaDevices.getUserMedia({video: {width: {ideal: 640}, height: {ideal: 480}}, audio: false});
      if (!keep()) return;
      video.srcObject = context.stream;
      await video.play();
      if (!keep()) return;
    }

    const run = createRun(recognizer?.profile ?? profile, {
      kind: file ? 'video' : 'camera', name: file?.name ?? null, sourceMirrored,
    }, mode);
    context.run = run;
    const dispatcher = addRun(run);
    el('tracking').textContent = '等待第一帧…';
    function onFrame(frame) {
      run.frames.push(frame);
      const tracked = Boolean(frame.hand);
      const label = tracked ? '已检测到手部' :
        frame.hands?.length > 1 ? '请保持一只手入镜' : '暂未检测到手部';
      if (el('tracking').textContent !== label) el('tracking').textContent = label;
      if (context.tracked !== tracked) {
        context.tracked = tracked;
        renderControls();
      }
      const result = recognizer?.push(frame);
      if (result) {
        collectResult(run, dispatcher, result);
        if (selectedRun() === run) renderRun();
      }
    }
    if (file) {
      status('正在分析录像…');
      context.cancel = scanVideo(video, context.tracker, onFrame,
        (done, total) => status('正在分析录像 ' + Math.round(done / total * 100) + '%'),
        () => closeSource('录像分析完成，可导出轨迹与事件。', 'complete'), failed);
    } else {
      context.cancel = watchVideo(video, context.tracker, onFrame, failed);
      status(mode === 'capture' ? '启动成功。选中类别并录制示范。' : '识别已启动。保持手型，或完成短动作后稍停。');
    }
    renderControls();
  } catch (error) {
    failed(error);
  }
}

function startRecording(field) {
  const gesture = selectedGesture();
  if (!canEdit() || session?.mode !== 'capture' || !gesture) return;
  const preRoll = Math.max(0, session.run.frames.length - (session.tracked ? 1 : 0));
  session.recording = {field, start: preRoll, gestureId: gesture.gestureId};
  renderControls();
  const prompt = gesture.type === 'static' ? '摆好手型并保持，点击结束示范。' : '做一次短动作，停住后点击结束示范。';
  const setup = session.tracked ? '' : '请把一只手放进画面。';
  status('正在录制' + (field === 'positives' ? '正例' : '反例') + '。' + setup + prompt);
}

function finishRecording() {
  const recording = session?.recording;
  if (!recording) return;
  session.recording = null;
  const {run} = session;
  const {field, start, gestureId} = recording;
  update(() => {
    const current = selectedGesture();
    const frames = prepareExample(run.frames.slice(start), current.type, profile.settings);
    const similar = field === 'positives' ? findSimilarClasses(profile, gestureId, frames) : [];
    const sample = createExample(frames, {...run.source, runId: run.runId});
    saveGesture({...current, [field]: [...current[field], sample]}, {
      kind: 'register_example', polarity: field, sampleId: sample.sampleId,
    });
    status(similar.length ? '正例已保存。它与这些类别的示范接近，识别时可能被拒绝：' + similar.join('、') :
      '示范已保存 · ' + Math.round(sample.source.endMs - sample.source.startMs) + ' ms。');
  });
  renderControls();
}

function bindFile(button, input, handler) {
  el(button).onclick = () => el(input).click();
  el(input).onchange = () => {
    const file = el(input).files[0];
    el(input).value = '';
    if (file && !session && !reading) handler(file);
  };
}

async function readJson(file, handle) {
  reading = true;
  renderControls();
  try {
    handle(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
  } catch (error) {
    status(error.message);
  } finally {
    reading = false;
    renderControls();
  }
}

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(participantId) {
  return (participantId ?? 'gesture').replace(/[^a-z0-9_-]/gi, '_');
}

el('action').replaceChildren(new Option('暂不绑定', ''),
  ...Object.entries(actionNames).map(([id, label]) => new Option(label, id)));
el('participantForm').onsubmit = event => {
  event.preventDefault();
  if (!session && !reading) update(() => {
    profile = reviseProfile(profile, {participantId: el('participantId').value.trim() || null}, {kind: 'participant_id'});
  }, '参与者编号已保存。');
};
el('addForm').onsubmit = event => {
  event.preventDefault();
  if (!canEdit()) return;
  update(() => {
    const gesture = createGesture(el('newName').value.trim(), null, el('newType').value);
    profile = reviseProfile(profile, {gestures: [...profile.gestures, gesture]},
      {kind: 'add_gesture', gestureId: gesture.gestureId});
    selectedGestureId = gesture.gestureId;
    el('newName').value = '';
  }, '手势已添加，可以设置功能并录制示范。');
};
el('gesture').onchange = () => {
  selectedGestureId = el('gesture').value;
  renderProfile();
};
el('editForm').onsubmit = event => {
  event.preventDefault();
  const current = selectedGesture();
  if (!canEdit() || !current) return;
  update(() => saveGesture({
    ...current, name: el('gestureName').value.trim(), actionId: el('action').value || null,
    settings: {threshold: el('threshold').valueAsNumber, negativeMargin: el('negativeMargin').valueAsNumber},
  }, {kind: 'update_gesture', previousName: current.name, previousActionId: current.actionId,
    previousSettings: current.settings}), '手势设置已保存。');
};
el('deleteGesture').onclick = () => update(() => {
  const gestures = profile.gestures.filter(gesture => gesture.gestureId !== selectedGestureId);
  profile = reviseProfile(profile, {gestures}, {kind: 'remove_gesture', gestureId: selectedGestureId});
  selectedGestureId = gestures[0]?.gestureId ?? '';
}, '手势及其样例已删除。');

el('openCapture').onclick = () => startSource('capture');
el('openRecognition').onclick = () => startSource('recognition');
el('stop').onclick = () => closeSource(session?.recording ?
  '已停止。未提交的示范未加入配置，原轨迹仍可导出。' : '已停止，可导出运行记录。');
el('recordPositive').onclick = () => startRecording('positives');
el('recordNegative').onclick = () => startRecording('negatives');
el('finishRecording').onclick = finishRecording;
bindFile('openVideo', 'videoFile', file => startSource('recognition', file));
bindFile('loadProfile', 'profileFile', file => readJson(file, input => {
  profile = importProfile(input);
  savedRevisionId = input.revisionId;
  selectedGestureId = profile.gestures[0]?.gestureId ?? '';
  renderProfile();
  status(input.version === 2 ? '已用原示范和功能绑定升级到 v3，阈值已按新特征重置。请导出新配置。' :
    '已导入 v3 配置。已有运行记录可继续查看和导出。');
}));
bindFile('openReplay', 'runFile', file => readJson(file, input => {
  const frames = readTrajectory(input);
  const result = replay(frames, profile);
  const run = createRun(result.profile, {
    kind: 'replay', name: file.name, inputRunId: input.runId ?? null,
    inputEngineVersion: input.engineVersion ?? null,
    sourceMirrored: input.source?.sourceMirrored ?? frames[0].sourceMirrored ?? null,
    synthetic: input.source?.kind === 'synthetic' || input.source?.synthetic === true,
  }, 'recognition');
  const dispatcher = addRun(run);
  run.frames = frames;
  run.rejections = result.rejections;
  for (const event of result.events) collectResult(run, dispatcher, {event});
  run.finishedAt = new Date().toISOString();
  run.outcome = 'complete';
  renderRun();
  status('轨迹回放完成。日志和页码使用本次配置计算。');
}));

el('saveProfile').onclick = () => {
  download(fileStem(profile.participantId) + '-profile-v' + profileVersion + '-' + profile.revisionId.slice(0, 8) + '.json', profile);
  savedRevisionId = profile.revisionId;
  status('已请求下载当前配置。');
};
el('runs').onchange = () => {
  renderRun();
  renderControls();
};
el('exportRun').onclick = () => {
  const run = selectedRun();
  if (!run?.frames.length) return;
  download(fileStem(run.profile.participantId) + '-run-v' + run.version + '-' + run.runId.slice(0, 8) + '.json', run);
  exportedFrames.set(run.runId, run.frames.length);
  status('已请求下载选中的运行记录。');
};
window.addEventListener('beforeunload', event => {
  const unsavedRun = [...runs.values()].some(run => run.frames.length > (exportedFrames.get(run.runId) ?? 0));
  if (profile.revisionId !== savedRevisionId || unsavedRun) event.preventDefault();
});
window.addEventListener('pagehide', () => closeSource());
renderProfile();
