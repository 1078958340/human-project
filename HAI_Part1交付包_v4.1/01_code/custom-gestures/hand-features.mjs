import {singleHandTrackerVersion, multiHandTrackerVersion} from '../tracker.mjs';

export const coordinateSystem = 'body-right-v1';
export const trackerVersion = multiHandTrackerVersion;
export const featureVersion = 'joint-shape-path-v1';
export const legacyTrackerVersion = 'right-hand-v4';
export const archivedTrackerVersions = Object.freeze([legacyTrackerVersion, singleHandTrackerVersion]);

const palmPoints = [0, 5, 9, 13, 17];
const fingers = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const tips = fingers.map(finger => finger[3]);
const distance3D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function bend(a, b, c) {
  const ab = distance3D(a, b), bc = distance3D(b, c), ac = distance3D(a, c);
  const denominator = 2 * ab * bc;
  if (denominator < 1e-8) return 0;
  const cosine = (ab ** 2 + bc ** 2 - ac ** 2) / denominator;
  return (Math.max(-1, Math.min(1, cosine)) + 1) / 2;
}

function handShape(points, scale) {
  const shape = [];
  for (const [base, a, b, tip] of fingers) {
    shape.push(0.75 * bend(points[base], points[a], points[b]),
      0.55 * bend(points[a], points[b], points[tip]),
      0.80 * distance3D(points[0], points[tip]) / scale);
  }
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      shape.push(0.85 * distance3D(points[tips[i]], points[tips[j]]) / scale);
    }
  }
  return shape;
}

export function observeFrame(frame) {
  if (!Number.isFinite(frame?.tMs) || frame.tMs < 0 ||
      !Number.isFinite(frame.aspect) || frame.aspect <= 0 ||
      (frame.coordinateSystem !== undefined && frame.coordinateSystem !== coordinateSystem) ||
      (frame.trackerVersion !== undefined && ![trackerVersion, ...archivedTrackerVersions].includes(frame.trackerVersion)) ||
      (frame.sourceMirrored !== undefined && typeof frame.sourceMirrored !== 'boolean')) {
    throw new Error('轨迹帧需要有效的媒体时间、宽高比和坐标版本。');
  }
  if (frame.hand === null) return null;
  if (!Array.isArray(frame.hand) || frame.hand.length !== 21 ||
      frame.hand.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y) ||
        (p.z !== undefined && !Number.isFinite(p.z)))) {
    throw new Error('hand 必须为 21 个有效关键点或 null。');
  }
  const points = frame.hand.map(({x, y, z = 0}) => [x * frame.aspect, y, z * frame.aspect]);
  const scale = Math.max(distance3D(points[0], points[9]), distance3D(points[5], points[17]) * 0.9);
  if (scale < 0.015) return null;
  const x = palmPoints.reduce((sum, i) => sum + points[i][0], 0) / palmPoints.length;
  const y = palmPoints.reduce((sum, i) => sum + points[i][1], 0) / palmPoints.length;
  return {x, y, scale, shape: handShape(points, scale), tMs: frame.tMs};
}

export function createFrameReader() {
  let previousMs = -Infinity;
  return frame => {
    if (!Number.isFinite(frame?.tMs) || frame.tMs <= previousMs) {
      throw new Error('同一来源的媒体时间 tMs 必须严格递增。');
    }
    const point = observeFrame(frame);
    previousMs = frame.tMs;
    return point;
  };
}

export function poseDistance(a, b) {
  let total = 0, peak = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    total += delta ** 2;
    peak = Math.max(peak, delta);
  }
  // Keep finger-only movement visible even when most other landmarks are still.
  return 0.66 * Math.sqrt(total / a.length) + 0.34 * peak;
}

export function palmDistance(a, b) {
  return pointDistance(a, b) / Math.max(a.scale, b.scale);
}

const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function describePose(points, settings) {
  const shape = points[0].shape.map((_, i) => median(points.map(point => point.shape[i])));
  const anchor = points[0];
  if (points.some(point => poseDistance(shape, point.shape) > settings.quietPose ||
    palmDistance(anchor, point) > 2.5 * settings.quietPalm)) {
    return {reason: 'pose_not_steady'};
  }
  return {feature: shape};
}

export function describeMotion(points, settings) {
  const start = points[0], end = points.at(-1);
  const scale = median(points.map(point => point.scale));
  let palmExtent = 0, poseExtent = 0;
  for (const point of points) {
    palmExtent = Math.max(palmExtent, pointDistance(point, start) / scale);
    poseExtent = Math.max(poseExtent, poseDistance(start.shape, point.shape));
  }
  if (palmExtent < settings.minPalmMotion && poseExtent < settings.minPoseMotion) {
    return {reason: 'too_little_motion'};
  }

  // Keep direction and shape changes. A floor prevents normalizing jitter to a full stroke.
  const pathScale = scale * Math.max(0.65, palmExtent);
  const curlWeight = 1.5 / (Math.sqrt(start.shape.length) * Math.max(0.27, poseExtent));
  const shapeWeight = 0.32 / Math.sqrt(start.shape.length);
  let index = 0;
  const feature = Array.from({length: 20}, (_, i) => {
    const time = start.tMs + (end.tMs - start.tMs) * i / 19;
    while (index < points.length - 2 && points[index + 1].tMs < time) index++;
    const a = points[index], b = points[index + 1];
    const mix = (time - a.tMs) / (b.tMs - a.tMs);
    const x = a.x + (b.x - a.x) * mix, y = a.y + (b.y - a.y) * mix;
    const shape = a.shape.map((value, j) => value + (b.shape[j] - value) * mix);
    return [(x - start.x) / pathScale, (y - start.y) / pathScale,
      ...shape.map((value, j) => (value - start.shape[j]) * curlWeight),
      ...shape.map(value => value * shapeWeight)];
  });
  return {feature, shapeStart: start.shape, shapeEnd: end.shape, extent: {
    palm: palmExtent, pose: poseExtent,
    palmEnd: pointDistance(end, start) / scale, poseEnd: poseDistance(start.shape, end.shape),
  }};
}
