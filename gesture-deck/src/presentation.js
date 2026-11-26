import { $, bindFile, filenameStem, notify, readJson, saveJson, timestamp } from './ui.js';
import { version as appVersion } from '../package.json';
import { actions, hasExamples, openRecognition, profiles, readTimeline, recognizer, verifiedBundle } from './team-adapter.js';
import { cameraMessage, startTracking } from './live-camera.js';

const labels = {
  executed: '已执行', paused: '暂停中', page_boundary: '已到页码边界', unbound: '未绑定',
  canceled: '已停止', pending: '处理中'
};
const cameraLabels = {
  permission: '等待摄像头权限…', model: '正在加载手部识别模型…', ready: '等待手部入镜。'
};
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

export function setupPresentation(slides, context) {
  const camera = $('present-camera');
  const choices = new Map();
  const runs = new Map();
  let imported;
  let demo;
  let active;
  let last;
  let replayRevision = 0;
  let status = '';
  const selected = () => choices.get($('profile').value);
  const visibleRun = () => runs.get($('run-history').value) ?? last;

  function refresh(preferred = $('profile').value) {
    const personal = context.personal();
    const bundle = context.bundle()?.data;
    choices.clear();
    if (hasExamples(personal)) choices.set('personal', { name: '个人配置' + (personal.participantId ? ' · ' + personal.participantId : ''), data: personal });
    if (bundle) {
      for (const [group, label] of [['C', 'C · 校准版'], ['A', 'A · 原示范'], ['B', 'B · 补正例']]) {
        choices.set(group, { name: label + ' · ' + bundle.profiles[group].participantId, data: bundle.profiles[group] });
      }
    }
    if (imported) choices.set('imported', imported);
    if (demo) choices.set('demo', demo);
    const select = $('profile');
    select.replaceChildren(...[...choices].map(([value, choice]) => new Option(choice.name, value)));
    if (!choices.size) select.add(new Option('等待个人配置', ''));
    select.value = choices.has(preferred) ? preferred : choices.has('C') ? 'C' : select.options[0].value;
    if (active && selected()?.data !== active.profileReference) close();
    updateBindings();
    render();
  }

  function updateBindings() {
    const item = selected();
    const profile = item?.data;
    const entries = profile?.version === 1 ? [['右滑', '下一页']]
      : (profile?.gestures ?? []).filter(gesture => gesture.positives.length).map(gesture =>
        [gesture.name, actions.actionNames[gesture.actionId] ?? '未绑定']);
    $('bindings').replaceChildren(...entries.map(([name, action]) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      const right = document.createElement('strong');
      left.textContent = name;
      right.textContent = action;
      li.append(left, right);
      return li;
    }));
    $('profile-hint').textContent = item?.synthetic ? '示例使用合成轨迹，可演示翻页和暂停。'
      : profile?.version === 1 ? '原 4.1 识别器 · ' + profile.positives.length + ' 正例 · ' + (profile.negatives?.length ?? 0) + ' 反例'
      : item ? '使用此配置的示范和动作绑定。' : '录制示范或导入配置后可开启手势控制。';
  }

  function render() {
    const choice = selected();
    const cameraOn = active?.kind === 'camera';
    const replaying = active?.kind === 'replay';
    $('profile').disabled = replaying || !choices.size;
    $('import-present-profile').disabled = replaying;
    $('start-present').disabled = replaying || (!cameraOn && (!choice || choice.synthetic || !slides.hasDeck()));
    $('start-present').textContent = cameraOn ? '停止手势控制' : '开启手势控制';
    $('toggle-present').hidden = !cameraOn;
    $('toggle-present').textContent = active?.dispatcher.enabled === false ? '恢复手势翻页' : '暂停手势翻页';
    $('present-hint').value = cameraOn ? status : '播放器支持空格和方向键翻页。';
    $('present-preview').hidden = !camera.srcObject || !cameraOn;
    $('choose-replay').disabled = !choice || !slides.hasDeck() || replaying;
    $('cancel-replay').hidden = !replaying;
    $('export-present-run').disabled = !visibleRun()?.run.frames.length;
    const controlState = $('slide-control-state');
    controlState.hidden = !active;
    controlState.value = active?.dispatcher.enabled === false ? '手势已暂停' : cameraOn ? '手势控制已开启' : '轨迹回放中';
    controlState.classList.toggle('paused', active?.dispatcher.enabled === false);
  }

  function renderEvents(state) {
    if (!state || state !== visibleRun()) return;
    const events = state.run.events;
    const count = events.filter(entry => entry.pageAfter !== null && entry.pageAfter !== entry.pageBefore).length;
    const result = events.length + ' 次触发 · ' + count + ' 次翻页';
    const ending = ({ complete: '回放完成 · ', stopped: '已停止 · ', failed: '本轮异常结束 · ' })[state.run.outcome] ?? '';
    $('replay-result').value = ending + result;
    $('event-list').replaceChildren(...events.slice(-6).reverse().map(event => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      const item = document.createElement('span');
      time.textContent = timestamp(event.tMs, true);
      item.textContent = event.gestureName + ' · ' + labels[event.actionResult.status]
        + (event.pageAfter !== null && event.pageAfter !== event.pageBefore ? ' · 第 ' + event.pageAfter + ' 页' : '');
      li.append(time, item);
      return li;
    }));
    render();
  }

  function close(outcome = 'stopped') {
    replayRevision++;
    const old = active;
    if (!old) return;
    active = null;
    old.controller.abort();
    old.run.finishedAt = new Date().toISOString();
    old.run.outcome = outcome;
    if (old.kind === 'replay') slides.lockManual(false);
    status = '';
    renderEvents(old);
  }

  function newRun(kind, inference, source) {
    const profile = inference.profile;
    const run = profile.version === 1 ? {
      version: 1, engineVersion: 'dtw-v4.1-development', trackerVersion: 'right-hand-v4', coordinateSystem: 'body-right-v1',
      mode: profile.mode, runId: crypto.randomUUID(), startedAt: new Date().toISOString(), profile,
      source, frames: [], events: [], rejections: []
    } : recognizer.createRun(profile, source, 'recognition');
    run.player = {
      appVersion, deck: slides.deckInfo(), initialPage: slides.page(),
      browserClock: 'performance.now', timeOrigin: performance.timeOrigin, manualControl: []
    };
    const state = {
      kind, run, inference, profileReference: selected().data, controller: new AbortController(), tail: Promise.resolve(),
      dispatcher: actions.createActionDispatcher({
        nextPage: () => slides.advance(1, kind === 'camera' ? '手势翻页' : '轨迹翻页'),
        previousPage: () => slides.advance(-1, kind === 'camera' ? '手势翻页' : '轨迹翻页'),
        onEnabledChange: render
      })
    };
    active = last = state;
    runs.set(run.runId, state);
    $('run-history').add(new Option((run.source.name ?? '实时摄像头') + ' · ' + runs.size, run.runId));
    $('run-history').value = run.runId;
    $('history-row').hidden = runs.size < 2;
    $('present-event').value = '暂无';
    renderEvents(state);
    return state;
  }

  function ingest(state, frame) {
    if (state !== active) return;
    const { run, inference } = state;
    run.frames.push(frame);
    const result = inference.push(frame);
    if (result?.rejections?.length) run.rejections.push(...result.rejections);
    if (!result?.event) return;
    const entry = {
      ...result.event, receivedPerfMs: performance.now(), pageBefore: null, pageAfter: null,
      presentedPerfMs: null, actionResult: { status: 'pending', enabled: state.dispatcher.enabled }
    };
    run.events.push(entry);
    state.tail = state.tail.then(async () => {
      if (state !== active) {
        entry.actionResult.status = 'canceled';
        return;
      }
      entry.pageBefore = slides.page();
      entry.actionResult = state.dispatcher.dispatch(entry);
      entry.executedPerfMs = performance.now();
      entry.pageAfter = slides.page();
      if (entry.pageAfter !== entry.pageBefore) entry.presentedPerfMs = await slides.whenDisplayed();
      if (state === active) {
        const label = actions.actionNames[entry.actionId] ?? '无动作';
        const detail = labels[entry.actionResult.status];
        $('present-event').value = entry.gestureName + ' · ' + label + ' · ' + detail;
      }
    }).catch(error => {
      entry.actionResult.status = 'canceled';
      if (state === active) fail(error);
    }).finally(() => renderEvents(state));
    return state.tail;
  }

  function fail(error) {
    close('failed');
    notify(cameraMessage(error), true);
  }

  async function startLive() {
    if (active?.kind === 'camera') return close();
    if (!slides.hasDeck() || !selected()) return;
    close();
    let state;
    try {
      const inference = openRecognition(selected().data);
      state = newRun('camera', inference, { kind: 'camera', sourceMirrored: false });
      await startTracking(camera, {
        signal: state.controller.signal, handMode: inference.handMode,
        onStatus: phase => { status = cameraLabels[phase]; render(); },
        onFrame(frame) {
          ingest(state, frame);
          const detected = inference.handMode === 'right' ? frame.hand : frame.hands?.length || frame.hand;
          const next = detected ? '已检测到手。可做已注册的手势。'
            : inference.handMode === 'right' ? '等待右手入镜。' : '等待手部入镜。';
          if (next !== status) { status = next; render(); }
          if ($('export-present-run').disabled && state.run.frames.length) $('export-present-run').disabled = false;
        },
        onError: fail
      });
    } catch (error) {
      if (!state || state === active) fail(error);
    }
  }

  async function playTrack(track, name) {
    if (!selected()) throw new Error('先导入这份轨迹对应的个人配置。');
    if (!slides.hasDeck()) throw new Error('先导入幻灯片，或载入示例幻灯片。');
    const inference = openRecognition(selected().data);
    const frames = readTimeline(track);
    if (inference.handMode === 'right' && track.trackerVersion !== 'right-hand-v4') {
      throw new Error('4.1 配置需要使用原右手轨迹（right-hand-v4）。');
    }
    close();
    slides.rewind();
    const state = newRun('replay', inference, {
      kind: 'replay', name, inputRunId: track.runId ?? null, inputEngineVersion: track.engineVersion ?? null,
      inputVideoSha256: track.source?.sha256 ?? track.source?.inputVideoSha256 ?? null,
      inputTrackerVersion: track.trackerVersion, sourceMirrored: track.source?.sourceMirrored ?? frames[0].sourceMirrored ?? null,
      synthetic: track.source?.kind === 'synthetic' || track.source?.synthetic === true
    });
    slides.lockManual(true);
    try {
      await slides.whenDisplayed();
      let nextYield = performance.now() + 16;
      for (const frame of frames) {
        if (state !== active) return;
        const event = ingest(state, frame);
        if (event) await event;
        if (performance.now() >= nextYield) {
          await yieldToBrowser();
          nextYield = performance.now() + 16;
        }
      }
      if (state === active) close('complete');
    } catch (error) {
      if (state === active) fail(error);
    }
  }

  $('profile').onchange = () => {
    close();
    updateBindings();
    render();
  };
  $('start-present').onclick = startLive;
  $('toggle-present').onclick = () => {
    if (active?.kind !== 'camera') return;
    const actionId = 'toggle_gesture_control';
    const action = active.dispatcher.dispatch({ actionId });
    active.run.player.manualControl.push({
      ...action, actionId, input: 'button', pageBefore: slides.page(), pageAfter: slides.page(), executedPerfMs: performance.now()
    });
  };
  $('cancel-replay').onclick = () => close();
  $('run-history').onchange = () => renderEvents(visibleRun());
  $('export-present-run').onclick = async () => {
    const record = visibleRun();
    if (!record?.run.frames.length) return;
    const { run } = record;
    const snapshot = {
      ...run, frames: [...run.frames], events: [...run.events], rejections: [...run.rejections],
      player: { ...run.player, manualControl: [...run.player.manualControl] }
    };
    await record.tail;
    saveJson(filenameStem(run.profile.participantId) + '-run-' + run.runId.slice(0, 8) + '.json', snapshot);
  };
  bindFile('import-present-profile', 'present-profile-file', async file => {
    const data = await readJson(file);
    if (data?.profiles || data?.calibrationVideoSha256) {
      context.setBundle({ data: await verifiedBundle(data), name: file.name });
      close();
      refresh('C');
      return;
    }
    const profile = data?.version === 1 ? openRecognition(data).profile : profiles.importProfile(data);
    const name = data?.version === 1 ? '原 4.1 · ' + file.name
      : (profile.participantId ? profile.participantId + ' · ' : '') + file.name;
    imported = { data: profile, name };
    close();
    refresh('imported');
  });
  bindFile('choose-replay', 'replay-file', async file => {
    const revision = replayRevision;
    const profile = selected()?.data;
    const track = await readJson(file);
    if (!$('present').hidden && revision === replayRevision && selected()?.data === profile) {
      await playTrack(track, file.name);
    }
  });
  slides.onDeckChange(() => { close(); render(); });
  slides.onManualPage(entry => {
    if (active?.kind === 'camera') {
      active.run.player.manualControl.push({ ...entry, enabled: active.dispatcher.enabled });
    }
  });

  function playDemo(profile, track) {
    demo = { data: profile, name: '放映示例 · 合成轨迹', synthetic: true };
    slides.loadExample();
    refresh('demo');
    playTrack(track, '合成放映示例').catch(error => notify(error.message, true));
  }

  refresh();
  return { refresh, playDemo, close, render };
}
