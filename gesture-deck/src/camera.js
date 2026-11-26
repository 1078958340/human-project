import { $, button, bindFile, filenameStem, icon, notify, readJson, saveJson } from './ui.js';
import { actions, hands, hasExamples, openRecognition, profiles, trajectories } from './team-adapter.js';
import { cameraMessage, startTracking } from './live-camera.js';

const MIME_TYPES = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
const fingerLinks = [
  [0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12],
  [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [17, 0]
];

function recordClip(stream) {
  if (typeof MediaRecorder === 'undefined') return null;
  try {
    const mimeType = MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    const result = new Promise(resolve => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => resolve(null);
      recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null);
    });
    recorder.start();
    return {
      result,
      stop() { if (recorder.state !== 'inactive') recorder.stop(); }
    };
  } catch {
    return null;
  }
}

// Same track selection and template extraction as the team's registration prototype.
function prepareTrackedExample(raw, gesture, settings) {
  const references = gesture.positives.map(sample => trajectories.describeClip(sample.frames, gesture.type, settings).feature);
  const candidates = [];
  let failure;
  for (const projected of hands.projectHandTracks(raw, settings).values()) {
    try {
      const frames = trajectories.prepareExample(projected, gesture.type, settings);
      const { feature, extent } = trajectories.describeClip(frames, gesture.type, settings);
      const rank = references.length
        ? Math.min(...references.map(reference => profiles.featureDistance(gesture.type, feature, reference)))
        : extent ? -Math.max(extent.palm / settings.minPalmMotion, extent.pose / settings.minPoseMotion) : 0;
      candidates.push({ frames, rank });
    } catch (error) {
      failure ??= error;
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  if (!candidates.length) throw failure ?? new Error(trajectories.clipErrors.insufficient_tracking);
  if (candidates[1] && candidates[1].rank - candidates[0].rank < (references.length ? .04 : .20)) {
    throw new Error('两只手的示范都符合。请单独展示要录入的手势，再录一次。');
  }
  return candidates[0].frames;
}

export function setupCamera(context) {
  const video = $('camera');
  const sampleVideo = $('sample-player');
  const canvas = $('sample-canvas');
  const clips = new Map();
  const current = () => context.personal().gestures.find(gesture => gesture.gestureId === selected);
  let selected = context.personal().gestures[0]?.gestureId ?? '';
  let session;
  let phase = 'off';
  let latest;
  let take;
  let test;
  let preview;
  let tryPage = 1;

  function refresh() {
    const profile = context.personal();
    if (!current()) selected = profile.gestures[0]?.gestureId ?? '';
    const select = $('gesture');
    select.replaceChildren(...profile.gestures.map(gesture => new Option(gesture.name, gesture.gestureId)));
    if (!profile.gestures.length) select.add(new Option('请先添加手势', ''));
    select.value = selected;
    if (document.activeElement !== $('participant')) $('participant').value = profile.participantId ?? '';
    const gesture = current();
    $('gesture-edit').hidden = !gesture;
    if (gesture) {
      $('gesture-name').value = gesture.name;
      $('gesture-action').value = gesture.actionId ?? '';
      $('gesture-kind').textContent = trajectories.gestureTypes[gesture.type];
    }
    $('sample-count').textContent = gesture ? gesture.positives.length + ' 正例 · ' + gesture.negatives.length + ' 反例' : '暂无示范';
    $('sample-count').classList.toggle('positive', (gesture?.positives.length ?? 0) >= 3);
    renderSamples(gesture);
    controls();
  }

  function controls() {
    const gesture = current();
    const recording = Boolean(take);
    const editable = !recording && !test;
    for (const control of $('samples').querySelectorAll('button')) control.disabled = !editable;
    for (const id of ['participant', 'new-gesture-name', 'new-gesture-type', 'add-gesture', 'gesture',
      'gesture-name', 'gesture-action', 'delete-gesture', 'import-personal']) $(id).disabled = !editable;
    $('export-personal').disabled = !hasExamples(context.personal()) || recording;
    video.hidden = !video.srcObject || Boolean(preview);
    canvas.hidden = preview?.type !== 'landmarks';
    sampleVideo.hidden = preview?.type !== 'video';
    $('camera-placeholder').hidden = !video.hidden || Boolean(preview);
    $('close-sample').hidden = !preview;
    const status = $('camera-status');
    const handsCount = latest?.hands?.length ?? Number(Boolean(latest?.hand));
    const statusText = recording ? (take.finishing ? '处理示范中' : '正在录制')
      : preview ? '回放中' : phase === 'permission' ? '等待摄像头权限' : phase === 'model' ? '加载识别模型'
      : phase === 'ready' ? (handsCount ? '已检测到手' : '等待手部入镜') : '未开启';
    if (status.textContent !== statusText) status.textContent = statusText;
    status.classList.toggle('positive', phase === 'ready' && handsCount > 0);
    status.classList.toggle('recording', recording);
    $('camera-action').textContent = session ? '关闭摄像头' : '开启摄像头';
    $('record-sample').disabled = !gesture || Boolean(preview || test) || phase !== 'ready'
      || (recording ? take.finishing : !handsCount);
    $('record-action').textContent = recording ? (take.finishing ? '提取示范…' : '结束并保存') : '录制示范';
    $('camera-timer').hidden = !recording;
    $('start-try').disabled = !hasExamples(context.personal()) || recording || (Boolean(session) && phase !== 'ready');
    $('start-try').textContent = test ? '结束手势试用' : '开始手势试用';
    $('try-hint').textContent = test ? (test.dispatcher.enabled ? '用已注册手势测试动作绑定。' : '手势翻页已暂停，仍可用绑定的恢复手势。')
      : hasExamples(context.personal()) ? '试用已绑定的上一页、下一页和暂停。' : '完成个人示范后可试用。';
    $('record-help').textContent = gesture?.type === 'static'
      ? '摆好手型并保持约 1 秒，再结束录制。'
      : '从静止开始，做一次短动作，停住后结束录制。';
    $('viewfinder').dataset.gesture = gesture?.name === '右滑' && gesture.type === 'dynamic' ? 'push-right' : '';
  }

  function renderSamples(gesture) {
    const list = $('samples');
    list.replaceChildren();
    if (!gesture) return;
    for (const [index, sample] of gesture.positives.entries()) {
      const item = document.createElement('li');
      const stamp = Math.round(sample.source.endMs - sample.source.startMs);
      item.innerHTML = `<span class="sample-icon">${icon('film')}</span><div class="sample-name"><strong>示范 ${index + 1}</strong><small>${stamp} 毫秒 · ${clips.has(sample.sampleId) ? '视频' : '关键点'}</small></div>`;
      for (const [label, glyph, handler] of [
        ['回放', 'play', () => playSample(sample)],
        ['移除', 'close', () => {
          if (take || test) return;
          replaceGesture({ ...gesture, positives: gesture.positives.filter(item => item.sampleId !== sample.sampleId) },
            { kind: 'remove_example', sampleId: sample.sampleId });
          clips.delete(sample.sampleId);
          closePreview();
          refresh();
        }]
      ]) {
        const control = button('', handler, 'icon-button');
        control.innerHTML = icon(glyph);
        control.title = `${label}示范 ${index + 1}`;
        control.setAttribute('aria-label', control.title);
        item.append(control);
      }
      list.append(item);
    }
    if (!gesture.positives.length) {
      const item = document.createElement('li');
      item.className = 'empty';
      item.innerHTML = `<span class="sample-icon">${icon('film')}</span><span class="sample-name">建议录制 3–5 段示范</span>`;
      list.append(item);
    }
  }

  function closePreview() {
    const old = preview;
    preview = null;
    if (old?.type === 'video') {
      sampleVideo.onerror = null;
      sampleVideo.pause();
      sampleVideo.removeAttribute('src');
      sampleVideo.load();
      URL.revokeObjectURL(old.url);
    }
    if (old?.request) cancelAnimationFrame(old.request);
    controls();
  }

  function drawSample(sample) {
    closePreview();
    const playback = { type: 'landmarks' };
    preview = playback;
    controls();
    const context = canvas.getContext('2d');
    const { width, height } = canvas;
    const origin = sample.frames[0].tMs;
    const start = performance.now();
    let index = 0;
    function draw(now) {
      if (preview !== playback) return;
      const elapsed = now - start;
      while (index < sample.frames.length - 1 && sample.frames[index + 1].tMs - origin <= elapsed) index++;
      const frame = sample.frames[index];
      context.fillStyle = '#101c35';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#d2e2ff';
      context.font = '15px system-ui';
      context.fillText('关键点回放', 18, 30);
      if (frame.hand) {
        const plotWidth = Math.min(width, height * frame.aspect);
        const plotHeight = Math.min(height, width / frame.aspect);
        const point = i => [
          (width - plotWidth) / 2 + plotWidth * frame.hand[i].x,
          (height - plotHeight) / 2 + plotHeight * frame.hand[i].y
        ];
        context.strokeStyle = '#9dbbff';
        context.lineWidth = 2;
        for (const links of fingerLinks) {
          context.beginPath();
          context.moveTo(...point(links[0]));
          for (const link of links.slice(1)) context.lineTo(...point(link));
          context.stroke();
        }
        context.fillStyle = '#fff';
        frame.hand.forEach((_, i) => {
          context.beginPath();
          context.arc(...point(i), 2.7, 0, Math.PI * 2);
          context.fill();
        });
      }
      if (index < sample.frames.length - 1) playback.request = requestAnimationFrame(draw);
    }
    playback.request = requestAnimationFrame(draw);
  }

  function playSample(sample) {
    if (take || test) return;
    closePreview();
    const blob = clips.get(sample.sampleId);
    if (!blob) return drawSample(sample);
    const playback = { type: 'video', url: URL.createObjectURL(blob) };
    preview = playback;
    sampleVideo.onerror = () => { if (preview === playback) drawSample(sample); };
    sampleVideo.src = playback.url;
    controls();
    sampleVideo.play().catch(() => {});
  }

  function applyProfile(patch, change) {
    const next = profiles.reviseProfile(context.personal(), patch, change);
    context.setPersonal(next);
    refresh();
  }

  function replaceGesture(gesture, change) {
    const gestures = context.personal().gestures.map(item => item.gestureId === gesture.gestureId ? gesture : item);
    applyProfile({ gestures }, { ...change, gestureId: gesture.gestureId });
  }

  function tryAction(event) {
    const result = test.dispatcher.dispatch(event);
    const how = ({ executed: '执行', paused: '暂停中', page_boundary: '页码边界', unbound: '未绑定' })[result.status];
    $('try-event').textContent = event.gestureName + ' · ' + (actions.actionNames[event.actionId] ?? '无动作') + ' · ' + how;
  }

  function onFrame(frame) {
    const previousHandCount = latest?.hands?.length ?? Number(Boolean(latest?.hand));
    latest = frame;
    if (take && !take.finishing) {
      take.frames.push(frame);
      const elapsed = performance.now() - take.started;
      $('camera-timer').textContent = (elapsed / 1000).toFixed(1) + ' 秒';
      if (elapsed >= 8000) finishRecording();
    }
    const event = test?.inference.push(frame)?.event;
    if (event) tryAction(event);
    const handCount = frame.hands?.length ?? Number(Boolean(frame.hand));
    if (handCount !== previousHandCount) controls();
  }

  function close() {
    const active = session;
    session = null;
    active?.abort();
    take?.clip?.stop();
    take = null;
    test = null;
    latest = null;
    phase = 'off';
    closePreview();
  }

  async function start() {
    closePreview();
    const controller = new AbortController();
    session = controller;
    const fail = error => {
      if (session !== controller) return;
      close();
      notify(cameraMessage(error), true);
    };
    try {
      await startTracking(video, {
        signal: controller.signal, handMode: 'multi', onFrame,
        onStatus: status => { phase = status; controls(); },
        onError: fail
      });
    } catch (error) {
      fail(error);
    }
  }

  function startRecording() {
    const gesture = current();
    if (!gesture || phase !== 'ready' || !latest || test) return;
    take = {
      gesture, started: performance.now(), frames: [latest], runId: crypto.randomUUID(), clip: recordClip(video.srcObject)
    };
    $('camera-timer').textContent = '0.0 秒';
    controls();
  }

  async function finishRecording() {
    if (!take || take.finishing) return;
    const recording = take;
    recording.finishing = true;
    recording.clip?.stop();
    controls();
    try {
      const profile = context.personal();
      const frames = prepareTrackedExample(recording.frames, recording.gesture, profile.settings);
      const sample = profiles.createExample(frames, { kind: 'camera', runId: recording.runId, sourceMirrored: false });
      const similar = profiles.findSimilarClasses(profile, recording.gesture.gestureId, frames);
      const blob = await recording.clip?.result;
      if (take !== recording) return;
      if (blob) clips.set(sample.sampleId, blob);
      replaceGesture({ ...recording.gesture, positives: [...recording.gesture.positives, sample] },
        { kind: 'register_example', polarity: 'positives', sampleId: sample.sampleId });
      notify(similar.length ? '示范已保存，与这些手势较相似：' + similar.join('、') : '个人示范已保存。');
    } catch (error) {
      if (take === recording) notify(error.message, true);
    } finally {
      if (take === recording) {
        take = null;
        controls();
      }
    }
  }

  function edit(action) {
    try { action(); } catch (error) { refresh(); notify(error.message, true); }
  }

  $('participant').onchange = event => edit(() => {
    const participantId = event.currentTarget.value.trim() || null;
    if (participantId !== context.personal().participantId) applyProfile({ participantId }, { kind: 'participant_id' });
  });
  $('add-gesture-form').onsubmit = event => {
    event.preventDefault();
    if (take || test) return;
    edit(() => {
      const name = $('new-gesture-name').value.trim();
      if (!name || context.personal().gestures.some(item => item.name === name)) throw new Error('请填写一个尚未使用的手势名称。');
      const gesture = profiles.createGesture(name, null, $('new-gesture-type').value);
      closePreview();
      selected = gesture.gestureId;
      applyProfile({ gestures: [...context.personal().gestures, gesture] }, { kind: 'add_gesture', gestureId: selected });
      $('new-gesture-name').value = '';
    });
  };
  $('gesture').onchange = event => {
    closePreview();
    selected = event.currentTarget.value;
    refresh();
  };
  $('gesture-name').onchange = event => edit(() => {
    const gesture = current();
    const name = event.currentTarget.value.trim();
    if (!name || context.personal().gestures.some(item => item.gestureId !== selected && item.name === name)) {
      throw new Error('请填写一个尚未使用的手势名称。');
    }
    if (name !== gesture.name) replaceGesture({ ...gesture, name }, { kind: 'rename_gesture', previousName: gesture.name });
  });
  $('gesture-action').replaceChildren(new Option('暂不绑定', ''),
    ...Object.entries(actions.actionNames).map(([id, label]) => new Option(label, id)));
  $('gesture-action').onchange = event => edit(() => {
    const gesture = current();
    replaceGesture({ ...gesture, actionId: event.currentTarget.value || null },
      { kind: 'rebind', previousActionId: gesture.actionId });
  });
  $('delete-gesture').onclick = () => edit(() => {
    const gesture = current();
    if (!gesture || take || test) return;
    closePreview();
    const gestures = context.personal().gestures.filter(item => item.gestureId !== selected);
    selected = gestures[0]?.gestureId ?? '';
    applyProfile({ gestures }, { kind: 'remove_gesture', gestureId: gesture.gestureId });
    for (const sample of gesture.positives) clips.delete(sample.sampleId);
  });
  bindFile('import-personal', 'register-profile-file', async file => {
    const data = await readJson(file);
    if (data?.version === 1) throw new Error('旧版 4.1 配置请在「正式放映」导入。');
    const profile = profiles.importProfile(data);
    if (take || test) return;
    closePreview();
    clips.clear();
    context.setPersonal(profile);
    selected = profile.gestures[0]?.gestureId ?? '';
    $('participant').value = profile.participantId ?? '';
    refresh();
    notify(data.version === 4 ? '已导入个人配置。' : '已导入并升级为自定义 v4 配置。');
  });
  $('export-personal').onclick = () => {
    const profile = context.personal();
    saveJson(filenameStem(profile.participantId) + '-profile-v4.json', profile);
  };
  $('toggle-camera').onclick = () => session ? close() : start();
  $('record-sample').onclick = () => take ? finishRecording() : startRecording();
  $('close-sample').onclick = closePreview;
  $('start-try').onclick = async () => {
    if (test) {
      test = null;
      controls();
      return;
    }
    closePreview();
    try {
      const inference = openRecognition(context.personal());
      const advance = delta => {
        if (tryPage + delta < 1 || tryPage + delta > 3) return false;
        tryPage += delta;
        $('try-page').value = String(tryPage).padStart(2, '0');
        return true;
      };
      test = { inference, dispatcher: actions.createActionDispatcher({
        nextPage: () => advance(1), previousPage: () => advance(-1), onEnabledChange: controls
      }) };
      if (!session) await start();
      controls();
    } catch (error) {
      test = null;
      controls();
      notify(error.message, true);
    }
  };
  $('reset-try').onclick = () => {
    tryPage = 1;
    $('try-page').value = '01';
    $('try-event').textContent = '';
  };

  refresh();
  return { close, refresh };
}
