import { $, bindFile, button, filenameStem, notify, readJson, saveJson, timestamp } from './ui.js';
import { version as appVersion } from '../package.json';
import { captureVideo, exchange, hasExamples, profiles, readTimeline, runStudy, verifiedBundle } from './team-adapter.js';
import { sampleRehearsal } from './mock.js';

const groupLabels = { A: 'A · 原示范', B: 'B · 补正例', C: 'C · 补反例' };
const reviewKinds = {
  missed: '漏检', false_trigger: '误触', duplicate: '重复触发', wrong_class: '错类', wrong_action: '错动作'
};

export function setupRehearsal(context) {
  const video = $('rehearsal-video');
  const scrub = $('scrub');
  const mode = () => $('study-mode').value;
  const profile = () => mode() === 'learn' ? context.personal() : context.bundle()?.data.profiles.A;
  let source;
  let sourceRevision = 0;
  let low = 0;
  let high = 0;
  let cursor = 0;
  let pending;
  let marks = [];
  let imported;
  let current;
  let complete;
  let clipEnd;
  let durationProbe;
  let cachedCapture;

  const visibleMarks = () => $('no-command').checked ? [] : imported?.data.intentions ?? marks;
  const currentTime = () => cursor;
  const hasMedia = () => high > low;
  const renderClock = () => {
    scrub.value = String(cursor);
    $('video-time').value = timestamp(cursor, true) + ' / ' + timestamp(high, true);
  };

  function seek(ms) {
    cursor = Math.max(low, Math.min(high, ms));
    clipEnd = null;
    if (!video.hidden) {
      video.pause();
      video.currentTime = cursor / 1000;
    }
    renderClock();
  }

  function renderMarkers() {
    const timeline = $('timeline-marks');
    const list = $('marker-list');
    timeline.replaceChildren();
    list.replaceChildren();
    if (!hasMedia()) return;
    const percent = ms => Math.max(0, Math.min(100, 100 * (ms - low) / (high - low)));
    for (const event of complete?.report[$('review-group').value].events ?? []) {
      const tick = document.createElement('span');
      tick.className = 'trigger-dot';
      tick.style.left = percent(event.tMs) + '%';
      tick.title = (event.gestureName ?? '') + ' · ' + timestamp(event.tMs, true);
      timeline.append(tick);
    }
    visibleMarks().forEach((mark, index) => {
      if (!Number.isFinite(mark?.startMs) || !Number.isFinite(mark?.endMs)) return;
      const name = mark.name ?? profile()?.gestures.find(g => g.gestureId === mark.gestureId)?.name ?? '手势';
      const label = name + ' ' + timestamp(mark.startMs, true) + '–' + timestamp(mark.endMs, true);
      const tick = button('', () => seek(mark.startMs), 'mark-dot interval-tick');
      tick.style.left = percent(mark.startMs) + '%';
      tick.style.width = Math.max(0.8, percent(mark.endMs) - percent(mark.startMs)) + '%';
      tick.title = label;
      tick.setAttribute('aria-label', label);
      timeline.append(tick);
      const item = document.createElement('li');
      item.append(button(label, () => seek(mark.startMs), ''));
      if (!imported && !source?.example) {
        const remove = button('移除', () => {
          marks = marks.filter((_, i) => i !== index);
          invalidate();
        }, 'remove-interval');
        remove.disabled = Boolean(current);
        remove.setAttribute('aria-label', '移除 ' + label);
        item.append(remove);
      }
      list.append(item);
    });
  }

  function render() {
    const config = profile();
    const selected = $('label-gesture').value;
    const gestures = config?.gestures.filter(gesture => gesture.positives.length) ?? [];
    $('label-gesture').replaceChildren(...gestures.map(gesture => new Option(gesture.name, gesture.gestureId)));
    if (!gestures.length) $('label-gesture').add(new Option('等待含示范的配置', ''));
    if (gestures.some(gesture => gesture.gestureId === selected)) $('label-gesture').value = selected;
    const learning = mode() === 'learn';
    const ready = Boolean(config?.participantId && hasExamples(config));
    $('study-config-summary').textContent = ready
      ? (learning ? '个人配置 · ' : '冻结实验包 · ') + config.participantId + ' · ' + gestures.length + ' 类手势'
      : learning && config && hasExamples(config) ? '请在录手势页面填写参与者编号。'
      : learning ? '等待个人示范配置' : '等待冻结的 A/B/C 实验包';
    $('study-import-config').textContent = learning ? '导入个人配置' : '导入冻结实验包';
    $('review-hint').textContent = source?.example ? '这段示意视频用于查看标记方式。校准学习请选个人原视频。'
      : learning ? '用已标注的试讲补入正例和反例，冻结 A、B、C。'
      : '选用另一段原始视频或对应轨迹，按实验包里的冻结配置回放。';
    const busy = Boolean(current);
    const annotated = imported || marks.length || $('no-command').checked;
    $('analyze').disabled = busy || !ready || !hasMedia() || !annotated || Boolean(source?.example || pending);
    $('analyze-label').textContent = learning ? '学习并冻结 A/B/C' : '评估独立试讲';
    $('cancel-study').hidden = !busy;
    for (const id of ['study-mode', 'choose-video', 'example-rehearsal', 'study-import-config',
      'import-labels', 'clear-labels', 'study-mirror']) $(id).disabled = busy;
    $('no-command').disabled = busy || Boolean(source?.example || imported);
    $('annotation-controls').disabled = !hasMedia() || !gestures.length || busy
      || Boolean(imported || source?.example || $('no-command').checked);
    $('label-gesture').disabled = Boolean(pending);
    $('mark-end').disabled = !pending;
    $('mark-start-label').textContent = pending ? '重选起手' : '标记起手';
    $('cancel-mark').hidden = !pending;
    $('pending-mark').value = pending ? '起手 ' + timestamp(pending.startMs, true) + ' · 定位结束后保存区间' : '';
    $('labels-name').textContent = imported ? imported.name : '';
    $('clear-labels').hidden = !imported;
    $('mirror-row').hidden = !source?.file;
    scrub.min = low;
    scrub.max = hasMedia() ? high : 1;
    scrub.disabled = !hasMedia();
    $('study-results').hidden = !complete;
    renderClock();
    renderMarkers();
  }

  function invalidate() {
    current?.abort();
    current = null;
    complete = null;
    $('review-progress').value = '';
    render();
  }

  function selectSource(next) {
    video.pause();
    if (source?.file) URL.revokeObjectURL(source.url);
    source = next;
    low = next.frames ? Math.ceil(next.frames[0].tMs) : 0;
    high = next.frames ? Math.floor(next.frames.at(-1).tMs) : 0;
    cursor = low;
    pending = null;
    marks = next.example ? [...sampleRehearsal.intervals] : [];
    imported = null;
    cachedCapture = null;
    clipEnd = null;
    durationProbe = false;
    $('no-command').checked = false;
    $('study-mirror').checked = false;
    $('rehearsal-name').textContent = next.name;
    $('rehearsal-name').title = next.name;
    $('rehearsal-empty').hidden = Boolean(next.url);
    $('rehearsal-empty-title').textContent = next.frames ? '已载入关键点轨迹' : '等待视频';
    $('rehearsal-empty-tip').textContent = next.frames ? '可用时间轴和标注 JSON 进行回放' : '请选择可播放的原视频';
    video.hidden = !next.url;
    if (next.url) {
      video.src = next.url;
    } else {
      video.removeAttribute('src');
      video.load();
    }
    invalidate();
  }

  function updateDuration() {
    if (video.hidden) return;
    const seconds = video.duration;
    if (Number.isFinite(seconds) && seconds > 0) {
      high = Math.floor(seconds * 1000);
      render();
    }
  }

  video.addEventListener('loadedmetadata', () => {
    updateDuration();
    if (video.duration === Infinity) {
      durationProbe = true;
      video.currentTime = 1e8;
    }
  });
  video.addEventListener('durationchange', updateDuration);
  video.addEventListener('seeked', () => {
    if (!durationProbe) return;
    durationProbe = false;
    updateDuration();
    video.currentTime = 0;
  });
  video.addEventListener('timeupdate', () => {
    if (video.hidden || durationProbe) return;
    cursor = Math.min(high, Math.round(video.currentTime * 1000));
    if (clipEnd !== null && clipEnd !== undefined && cursor >= clipEnd) {
      clipEnd = null;
      video.pause();
    }
    renderClock();
  });
  video.addEventListener('error', () => {
    if (video.hidden) return;
    high = 0;
    invalidate();
    notify('视频无法播放。请尝试使用 MP4（H.264）或 WebM。', true);
  });
  scrub.oninput = () => seek(Number(scrub.value));

  function showCase(group) {
    const list = $('review-list');
    list.replaceChildren();
    for (const error of complete?.report[group].errors ?? []) {
      const event = error.eventIndex === null ? null : complete.report[group].events[error.eventIndex];
      const intent = error.intent;
      const name = intent?.name ?? event?.gestureName ?? '手势';
      const at = event?.tMs ?? intent?.startMs ?? 0;
      const from = Math.max(low, Math.min(event?.startMs ?? Infinity, intent?.startMs ?? Infinity, at - 450));
      const until = Math.min(high, Math.max(event?.endMs ?? 0, intent?.endMs ?? 0, at + 500));
      const item = document.createElement('article');
      item.className = 'review-item';
      const header = document.createElement('header');
      const tag = document.createElement('strong');
      tag.className = 'tag case-tag ' + (error.kind === 'missed' ? 'miss' : 'false-trigger');
      tag.textContent = reviewKinds[error.kind] ?? '待核对';
      const text = document.createElement('span');
      text.textContent = name + ' · ' + timestamp(at, true);
      header.append(tag, text, button(video.hidden ? '定位' : '回看', () => {
        seek(from);
        if (!video.hidden) {
          clipEnd = until;
          video.play().catch(() => { clipEnd = null; });
        }
      }));
      item.append(header);
      list.append(item);
    }
    if (complete && !list.children.length) {
      const item = document.createElement('p');
      item.className = 'live-detail';
      item.textContent = '此组没有待核对的候选片段。';
      list.append(item);
    }
    renderMarkers();
  }

  function showResults() {
    const { report, samples, bundle, label } = complete;
    $('match-summary').textContent = samples
      ? label + ' · 新增正例 ' + samples.positives.length + ' 条 · 采纳反例 ' + samples.accepted.length + ' 条'
      : label + ' · 使用冻结配置';
    const rows = exchange.studyGroups.map(group => {
      const { correct, intended, missed, falseTrigger, duplicate, wrongClass, wrongAction } = report[group].metrics;
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = groupLabels[group];
      row.append(heading);
      for (const value of [correct + '/' + intended, missed, falseTrigger, duplicate, wrongClass, wrongAction]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    });
    $('study-rows').replaceChildren(...rows);
    $('use-calibration').hidden = !bundle;
    $('export-calibration').hidden = !bundle;
    $('export-bundle').hidden = !bundle;
    $('review-group').value = samples ? 'A' : 'C';
    showCase($('review-group').value);
  }

  function labelsFor(trajectory, config) {
    if (imported || $('no-command').checked) {
      return exchange.buildStudyLabels(trajectory, config, $('no-command').checked ? '无指令' : '', imported?.data);
    }
    const beginning = trajectory.frames[0].tMs;
    const end = trajectory.frames.at(-1).tMs;
    const labels = exchange.buildStudyLabels(trajectory, config, '无指令', null);
    const intentions = [...marks].sort((a, b) => a.startMs - b.startMs).map(mark => {
      if (mark.startMs < beginning - 80 || mark.endMs > end + 80) {
        throw new Error('有标记超出轨迹时间轴。请重新定位该区间。');
      }
      const startMs = Math.max(beginning, mark.startMs);
      const endMs = Math.min(end, mark.endMs);
      if (endMs <= startMs) throw new Error('有标记落在视频末尾。请提前选择手势结束时刻。');
      return { ...mark, startMs, endMs };
    });
    return { ...labels, task: { ...labels.task, kind: 'mixed' }, intentions };
  }

  async function analyze() {
    if (current || !source || source.example) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const selectedMode = mode();
    const using = source;
    const mirrored = $('study-mirror').checked;
    current = controller;
    complete = null;
    const progress = message => { if (current === controller) $('review-progress').value = message; };
    progress('正在读取配置与标注…');
    render();
    try {
      const bundle = selectedMode === 'evaluate' ? context.bundle().data : null;
      const config = selectedMode === 'learn' ? profiles.withSensitiveMatching(context.personal()) : bundle.profiles.A;
      let trajectory = using.track;
      if (!trajectory && cachedCapture?.file === using.file && cachedCapture.mirrored === mirrored) {
        trajectory = cachedCapture.trajectory;
      }
      if (!trajectory) {
        progress('正在读取视频…');
        trajectory = await captureVideo(using.file, config, mirrored, signal, progress);
        cachedCapture = { file: using.file, mirrored, trajectory };
      }
      signal.throwIfAborted();
      readTimeline(trajectory, 2);
      const labels = labelsFor(trajectory, config);
      progress(selectedMode === 'learn' ? '正在学习正反例并冻结配置…' : '正在回放冻结的 A/B/C…');
      const result = await runStudy({ mode: selectedMode, profile: config, bundle, trajectory, labels }, signal, progress);
      signal.throwIfAborted();
      const label = selectedMode === 'learn' ? '校准素材回放'
        : labels.stage === 'replay' || labels.datasetScope === 'reused_validation' ? '既有素材复用回放' : '独立试讲回放';
      const frozen = result.bundle ?? bundle;
      complete = {
        ...result, bundle: frozen, label, labels, trajectory, frozenHashes: frozen.hashes, tolerance: frozen.tolerance
      };
      if (result.bundle) context.setBundle({ data: result.bundle, name: config.participantId + ' · 本轮冻结' });
      showResults();
      progress('已完成。');
    } catch (error) {
      if (current === controller) {
        progress(error.name === 'AbortError' ? '已取消。' : error.message);
        if (error.name !== 'AbortError') notify(error.message, true);
      }
    } finally {
      if (current === controller) {
        current = null;
        render();
      }
    }
  }

  bindFile('choose-video', 'video-file', async file => {
    const revision = ++sourceRevision;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      selectSource({ file, name: file.name, url: URL.createObjectURL(file) });
      return;
    }
    const track = await readJson(file);
    const frames = readTimeline(track, 2);
    if (!exchange.normalizeSha256(track.source?.sha256)) {
      throw new Error('校准轨迹需包含原视频的 SHA-256 校验值。4.1 轨迹可在正式放映页直接回放。');
    }
    if (revision === sourceRevision) selectSource({ track, frames, name: file.name });
  });
  $('example-rehearsal').onclick = () => {
    ++sourceRevision;
    selectSource({ example: true, name: '示意视频 · 仅练习标记', url: sampleRehearsal.url });
  };
  bindFile('study-import-config', 'study-config-file', async file => {
    const requested = mode();
    const data = await readJson(file);
    if (requested !== mode()) return;
    if (requested === 'learn') {
      const next = profiles.importProfile(data);
      context.replacePersonal(next);
    } else {
      const bundle = await verifiedBundle(data);
      if (requested !== mode()) return;
      context.setBundle({ data: bundle, name: file.name });
    }
  });
  bindFile('import-labels', 'labels-file', async file => {
    const data = await readJson(file);
    if (data?.version !== 1 || data.timeline !== 'media-ms' || data.complete !== true
      || !Array.isArray(data.intentions) || !data.task || !exchange.normalizeSha256(data.rawVideo?.sha256)) {
      throw new Error('请选择包含手势区间、完整任务时间和原视频校验值的标注 JSON。');
    }
    pending = null;
    imported = { name: file.name, data };
    $('no-command').checked = false;
    invalidate();
  });
  $('clear-labels').onclick = () => { imported = null; invalidate(); };
  $('study-mirror').onchange = () => { cachedCapture = null; invalidate(); };
  $('no-command').onchange = () => { pending = null; invalidate(); };
  $('study-mode').onchange = () => updateStudyConfig();
  $('mark-start').onclick = () => {
    const gesture = profile()?.gestures.find(item => item.gestureId === $('label-gesture').value);
    if (!gesture) return;
    pending = { startMs: currentTime(), gestureId: gesture.gestureId, name: gesture.name, actionId: gesture.actionId };
    invalidate();
  };
  $('mark-end').onclick = () => {
    const endMs = currentTime();
    if (!pending || endMs <= pending.startMs) return notify('结束时刻必须晚于起手时刻。', true);
    marks.push({ ...pending, endMs, intentId: crypto.randomUUID() });
    marks.sort((a, b) => a.startMs - b.startMs);
    pending = null;
    invalidate();
  };
  $('cancel-mark').onclick = () => { pending = null; invalidate(); };
  $('review-group').onchange = event => showCase(event.currentTarget.value);
  $('analyze').onclick = analyze;
  $('cancel-study').onclick = () => current?.abort();
  $('use-calibration').onclick = () => context.useC();
  $('export-calibration').onclick = () => exportResult('C-profile', complete?.bundle?.profiles.C);
  $('export-bundle').onclick = () => exportResult('study-bundle', complete?.bundle);
  $('export-study-run').onclick = () => exportResult('trajectory', complete?.trajectory);
  $('export-labels').onclick = () => exportResult('intentions', complete?.labels);
  $('export-report').onclick = () => {
    if (!complete) return;
    const { bundle, trajectory, ...result } = complete;
    exportResult('study-report', {
      ...result, source: trajectory.source, inputRunId: trajectory.runId, appVersion
    });
  };

  function exportResult(name, value) {
    if (complete && value) saveJson(filenameStem(complete.labels.participantId) + '-' + name + '.json', value);
  }

  function updateStudyConfig(rebind = false) {
    pending = null;
    const config = profile();
    if (!source?.example) {
      const gestures = new Map(config?.gestures.filter(gesture => gesture.positives.length)
        .map(gesture => [gesture.gestureId, gesture]));
      marks = marks.flatMap(mark => {
        const gesture = gestures.get(mark.gestureId);
        if (!gesture) return [];
        return [rebind ? { ...mark, name: gesture.name, actionId: gesture.actionId } : mark];
      });
    }
    invalidate();
  }

  render();
  return {
    render,
    updatePersonal() { if (mode() === 'learn') updateStudyConfig(true); },
    bundleChanged() { if (mode() === 'evaluate') updateStudyConfig(); },
    pause() { video.pause(); },
    cancel() { current?.abort(); }
  };
}
