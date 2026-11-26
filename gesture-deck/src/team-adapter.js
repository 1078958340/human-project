export function engineUrl(path) {
  return new URL(import.meta.env.BASE_URL + 'gesture-engine/' + path, location.href);
}

function loadModule(path) {
  return import(/* @vite-ignore */ engineUrl(path).href);
}

const [tracker, profiles, recognizer, actions, legacy, trajectories, hands, exchange] = await Promise.all([
  loadModule('tracker.mjs'),
  ...['profile', 'recognizer', 'actions'].map(name => loadModule('custom-gestures/' + name + '.mjs')),
  loadModule('development-v41/recognizer-development.mjs'),
  ...['trajectory', 'hand-tracks', 'study-exchange'].map(name => loadModule('custom-gestures/' + name + '.mjs'))
]);

export { tracker, profiles, recognizer, actions, legacy, trajectories, hands, exchange };

export function hasExamples(profile) {
  return Boolean(profile?.gestures?.some(gesture => gesture.positives.length));
}

export function readTimeline(track, minimumFrames = 1) {
  const frames = recognizer.readTrajectory(track);
  if (frames.length < minimumFrames) throw new Error('轨迹帧太少，无法完成这项操作。');
  if (frames.some((frame, index) => !Number.isFinite(frame?.tMs) || frame.tMs < 0
    || (index > 0 && frame.tMs <= frames[index - 1].tMs))) {
    throw new Error('轨迹的媒体时间必须是非负且严格递增的毫秒数。');
  }
  return frames;
}

export function openRecognition(profile) {
  if (profile?.version === 1) {
    if (profile.coordinateSystem !== 'body-right-v1') throw new Error('请选择身体右侧坐标的 4.1 配置。');
    const recognizer = legacy.createRecognizer(profile);
    return {
      profile,
      handMode: 'right',
      push(frame) {
        const event = recognizer.push(frame);
        if (event?.type === 'next_page') {
          return { event: { ...event, gestureName: '右滑', actionId: event.type }, rejections: [] };
        }
        return null;
      }
    };
  }
  if (!hasExamples(profile)) throw new Error('请先录制个人示范或导入一份包含示范的配置。');
  return { ...recognizer.createRecognizer(profile), handMode: 'multi' };
}

export async function verifiedBundle(bundle) {
  await exchange.verifyStudyBundle(bundle);
  const participant = bundle.profiles.A.participantId;
  for (const group of exchange.studyGroups) {
    const profile = profiles.compileProfile(bundle.profiles[group]).profile;
    if (!participant || profile.participantId !== participant || !hasExamples(profile)) {
      throw new Error('冻结配置必须来自同一参与者，且每组都需要包含示范。');
    }
  }
  return bundle;
}

function waitForMedia(video, eventName, signal, action) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timeout);
      video.removeEventListener(eventName, ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    }
    const ready = () => finish();
    const failed = () => finish(new Error('无法解码试讲视频。可尝试使用 MP4（H.264）或 WebM。'));
    const aborted = () => finish(signal.reason);
    const timeout = setTimeout(() => finish(new Error('读取视频超时。')), 15000);
    video.addEventListener(eventName, ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    try {
      signal.throwIfAborted();
      action();
    } catch (error) {
      finish(error);
    }
  });
}

export async function captureVideo(file, profile, mirrored, signal, progress) {
  const checksum = await exchange.sha256(await file.arrayBuffer());
  signal.throwIfAborted();
  const run = recognizer.createRun(profile, {
    kind: 'video', name: file.name, sha256: checksum, sourceMirrored: mirrored, extractor: '网页 MediaPipe WASM'
  }, 'capture');
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.preload = 'auto';
  let detector;
  let cancel;
  let onAbort;
  try {
    await waitForMedia(video, 'loadeddata', signal, () => { video.src = url; });
    if (video.duration === Infinity) {
      await waitForMedia(video, 'seeked', signal, () => { video.currentTime = 1e8; });
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('浏览器无法读取视频时长。请转存为带时长信息的 MP4。');
    }
    progress('正在加载手部追踪模型…');
    detector = await tracker.createTracker({ sourceMirrored: mirrored, handMode: 'multi' });
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      onAbort = () => {
        cancel?.();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cancel = tracker.scanVideo(video, detector, frame => run.frames.push(frame),
        (done, total) => progress('正在提取手部关键点 ' + Math.floor(100 * done / total) + '%'),
        resolve, reject);
    });
    return run;
  } finally {
    signal.removeEventListener('abort', onAbort);
    cancel?.();
    detector?.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export function runStudy(payload, signal, onProgress) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(engineUrl('custom-gestures/video-study-worker.mjs'), { type: 'module' });
    function finish(callback, value) {
      worker.terminate();
      signal.removeEventListener('abort', canceled);
      callback(value);
    }
    const canceled = () => finish(reject, signal.reason);
    signal.addEventListener('abort', canceled, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.progress) onProgress(data.progress);
      else if (data.error) finish(reject, new Error(data.error));
      else finish(resolve, data);
    };
    worker.onmessageerror = () => finish(reject, new Error('无法读取校准结果，请重试。'));
    worker.onerror = event => finish(reject, new Error(event.message || '无法启动校准任务。'));
    try {
      worker.postMessage(payload);
    } catch (error) {
      finish(reject, error);
    }
  });
}
