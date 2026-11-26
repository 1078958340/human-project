import { tracker } from './team-adapter.js';

export function cameraMessage(error) {
  return ({
    NotAllowedError: '摄像头访问未获许可。请在浏览器地址栏开启该站点的摄像头权限。',
    NotFoundError: '浏览器没有检测到摄像头。',
    NotReadableError: '摄像头无法启动。请检查是否被其他应用占用。'
  })[error.name] ?? error.message;
}

export async function startTracking(video, { signal, handMode, onStatus, onFrame, onError }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('请用 Chrome 或 Edge 在 localhost 或 HTTPS 打开。');
  if (!video.requestVideoFrameCallback) throw new Error('请用支持视频帧回调的新版本 Chrome 或 Edge。');
  let stream = null;
  let detector = null;
  let cancel = null;
  function close() {
    signal.removeEventListener('abort', close);
    cancel?.();
    cancel = null;
    detector?.close();
    detector = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      if (video.srcObject === stream) {
        video.pause();
        video.srcObject = null;
      }
      stream = null;
    }
  }

  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    onStatus('permission');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
      audio: false
    });
    signal.throwIfAborted();
    video.srcObject = stream;
    await video.play();
    signal.throwIfAborted();
    onStatus('model');
    const disconnected = () => {
      if (!signal.aborted) onError(new Error('摄像头已断开。'));
    };
    for (const track of stream.getTracks()) track.addEventListener('ended', disconnected, { once: true });
    detector = await tracker.createTracker({ sourceMirrored: false, handMode });
    signal.throwIfAborted();
    cancel = tracker.watchVideo(video, detector, frame => {
      if (!signal.aborted) onFrame(frame);
    }, error => { if (!signal.aborted) onError(error); });
    onStatus('ready');
  } catch (error) {
    close();
    if (!signal.aborted) throw error;
  }
}
