import assert from 'node:assert/strict';
import {actionNames, createActionDispatcher} from './custom-gestures/actions.mjs';
import {
  createProfile, createGesture, createExample, compileProfile, importProfile, reviseProfile, findSimilarClasses,
} from './custom-gestures/profile.mjs';
import {createRun, replay, readTrajectory} from './custom-gestures/recognizer.mjs';
import {prepareExample} from './custom-gestures/trajectory.mjs';
import {preflightStudy, alignIntentions, applyConfirmedReviews, compareProfiles} from './custom-gestures/study.mjs';
import {selectSingleHand} from './hand-selection.mjs';

const source = {runId: 'synthetic-fixture', kind: 'synthetic', sourceMirrored: false};
const initial = createProfile('synthetic');

function frame(tMs, x, y) {
  return {
    tMs, aspect: 4 / 3, side: 'Right', coordinateSystem: 'body-right-v1',
    hand: Array.from({length: 21}, (_, i) => ({x, y: y - i * 0.008, z: 0})),
  };
}

function stroke(path, {t0 = 0, x = 0.45, y = 0.55, moveMs = 600, tickMs = 50} = {}) {
  return Array.from({length: Math.floor((200 + moveMs + 400) / tickMs) + 1}, (_, i) => {
    const time = i * tickMs;
    const progress = Math.min(1, Math.max(0, (time - 200) / moveMs));
    const [dx, dy] = path(progress);
    return frame(t0 + time, x + dx, y + dy);
  });
}

const line = (dx, dy) => p => [dx * p, dy * p];
const right = line(0.12, 0), left = line(-0.12, 0), up = line(0, -0.16);
const diagonal = line(0.10, 0.12);
const loop = p => [0.065 * Math.sin(2 * Math.PI * p), 0.082 * (Math.cos(2 * Math.PI * p) - 1)];

const example = frames => createExample(prepareExample(frames), source);
function register(gestureId, actionId, path) {
  return {
    ...createGesture(gestureId, actionId), gestureId,
    positives: [example(stroke(path)), example(stroke(path, {moveMs: 670, tickMs: 1000 / 30, y: 0.65}))],
  };
}

const east = register('right', 'next_page', right);
const west = register('left', 'previous_page', left);
const north = register('up', 'toggle_gesture_control', up);
const profile = reviseProfile(initial, {gestures: [east, west, north]}, {kind: 'synthetic_registration'});
const recognized = (frames, configuration = profile) => replay(frames, configuration).events.map(event => event.gestureId);

assert.deepEqual(recognized(stroke(right)), ['right']);
assert.deepEqual(recognized(stroke(left)), ['left']);
assert.deepEqual(recognized(stroke(up)), ['up']);
assert.deepEqual(recognized(stroke(up, {tickMs: 1000 / 30, moveMs: 670})), ['up']);
const clockwise = register('loop', null, loop);
assert.deepEqual(recognized(stroke(loop), {...profile, gestures: [...profile.gestures, clockwise]}), ['loop']);
const loopFrames = stroke(loop);
for (const axis of ['x', 'y']) {
  assert.ok(Math.abs(loopFrames[0].hand[0][axis] - loopFrames.at(-1).hand[0][axis]) < 1e-6);
}

const rebound = reviseProfile(profile, {
  gestures: [{...east, name: '新名称', actionId: 'previous_page'}, west, north],
}, {kind: 'rebind'});
const originalEvent = replay(stroke(right), profile).events[0];
const reboundEvent = replay(stroke(right), rebound).events[0];
assert.equal(reboundEvent.gestureId, originalEvent.gestureId);
assert.equal(reboundEvent.positiveSampleId, originalEvent.positiveSampleId);
assert.equal(reboundEvent.gestureName, '新名称');
assert.equal(reboundEvent.actionId, 'previous_page');
assert.equal(rebound.parentRevisionId, profile.revisionId);
let page = 2;
const step = delta => {
  if (page + delta < 1 || page + delta > 3) return false;
  page += delta;
  return true;
};
const dispatcher = createActionDispatcher({nextPage: () => step(1), previousPage: () => step(-1)});
assert.equal(dispatcher.dispatch(originalEvent).status, 'executed');
assert.equal(page, 3);
assert.equal(dispatcher.dispatch(originalEvent).status, 'page_boundary');
assert.equal(dispatcher.dispatch(reboundEvent).status, 'executed');
assert.equal(page, 2);
const toggle = replay(stroke(up), profile).events[0];
assert.equal(dispatcher.dispatch(toggle).enabled, false);
assert.equal(dispatcher.dispatch(originalEvent).status, 'paused');
assert.equal(page, 2);
assert.equal(dispatcher.dispatch(toggle).enabled, true);
assert.equal(dispatcher.dispatch(originalEvent).status, 'executed');
assert.equal(dispatcher.dispatch({actionId: null}).status, 'unbound');
assert.equal(Object.keys(actionNames).length, 3);
console.log('PASS synthetic: three directions and a closed curve, stable gesture ID after rebinding, demo dispatch and pause/resume');

const unfamiliar = replay(stroke(diagonal), profile);
assert.equal(unfamiliar.events.length, 0);
assert.ok(unfamiliar.rejections.some(item => item.reason === 'unknown'));
const jitter = p => [0.002 * Math.sin(p * 150), 0.002 * Math.cos(p * 150)];
assert.deepEqual(recognized(stroke(jitter)), []);
assert.deepEqual(recognized(stroke(line(0, 0))), []);
assert.throws(() => prepareExample(stroke(jitter)), /不足/);
const twin = register('right-twin', null, right);
const ambiguous = {...profile, gestures: [...profile.gestures, twin]};
assert.deepEqual(recognized(stroke(right), ambiguous), []);
assert.equal(replay(stroke(right), ambiguous).rejections[0].reason, 'ambiguous');
assert.deepEqual(findSimilarClasses(ambiguous, twin.gestureId, twin.positives[0].frames), ['right']);

const broader = {...east, settings: {...east.settings, threshold: 3}};
const rightOnly = {...profile, gestures: [broader]};
assert.deepEqual(recognized(stroke(up), rightOnly), ['right']);
const guarded = {...broader, negatives: [example(stroke(up))]};
assert.equal(replay(stroke(up), {...profile, gestures: [guarded]}).rejections[0].reason, 'negative_match');
assert.deepEqual(recognized(stroke(up), {...profile, gestures: [guarded, north]}), ['up']);
assert.deepEqual(recognized(stroke(right), {...profile, gestures: [guarded, north]}), ['right']);
console.log('PASS synthetic: unknown input, stillness, jitter, ambiguity and class-local negative examples');

const twice = [...stroke(right), ...stroke(right, {t0: 1250, x: 0.57})];
assert.deepEqual(recognized(twice), ['right', 'right']);
assert.throws(() => prepareExample(twice), /多个动作/);
const long = [...stroke(line(0.26, 0), {moveMs: 2200}), ...stroke(left, {t0: 2850, x: 0.71})];
assert.deepEqual(recognized(long), ['left']);
assert.equal(replay(long, profile).rejections[0].reason, 'too_long');
const noPause = stroke(right).filter(f => f.tMs <= 800);
assert.deepEqual(recognized(noPause), []);
const exitAfterStroke = [...noPause, ...Array.from({length: 6}, (_, i) => ({
  ...frame(850 + i * 50, 0.57, 0.55), hand: null, side: null,
}))];
const recovered = replay(exitAfterStroke, profile).events;
assert.equal(recovered.length, 1);
assert.equal(recovered[0].gestureId, 'right');
assert.equal(recovered[0].completion, 'matched_before_tracking_loss');
const oneGap = stroke(left).map(f => f.tMs === 450 ? {...f, hand: null, side: null} : f);
const traced = replay(oneGap, profile).events[0];
assert.equal(traced.gestureId, 'left');
assert.ok(traced.frames.some(f => f.hand === null));
assert.ok(traced.tMs > traced.endMs);
const broken = stroke(left).map(f => f.tMs >= 400 && f.tMs <= 700 ? {...f, hand: null, side: null} : f);
assert.deepEqual(recognized(broken), []);
assert.ok(replay(broken, profile).rejections.some(item => item.reason === 'tracking_gap'));
assert.throws(() => prepareExample(broken), /追踪中断/);
assert.throws(() => replay([noPause[0], noPause[0]], profile), /严格递增/);
console.log('PASS synthetic: one event per completed stroke, rearm, no premature match, null frames and long-gap rejection');

const imported = compileProfile(JSON.parse(JSON.stringify(profile))).profile;
assert.deepEqual(imported, profile);
assert.deepEqual(replay(twice, imported), replay(twice, profile));
assert.throws(() => compileProfile({version: 1}), /4\.1/);
assert.throws(() => compileProfile({...profile, featureVersion: 'wrong'}), /版本/);
assert.throws(() => compileProfile({...profile, gestures: [east, east]}), /唯一/);
assert.throws(() => compileProfile({...profile, gestures: [{...east, actionId: 'unknown'}]}), /绑定/);
assert.throws(() => compileProfile({...profile, gestures: [{...east, negatives: 'bad'}]}), /数组/);
assert.throws(() => compileProfile({...profile, settings: {minMs: 5000}}), /时长/);
assert.equal(readTrajectory({version: 1, trackerVersion: 'right-hand-v4', frames: twice}), twice);
const old = {
  ...profile, version: 2, engineVersion: 'dtw-custom-v2',
  trackerVersion: 'right-hand-v4', featureVersion: 'palm-path-20-v1',
  gestures: profile.gestures.map(gesture => ({...gesture, type: 'right_hand_dynamic'})),
};
const upgraded = importProfile(old);
assert.equal(upgraded.version, 3);
assert.equal(upgraded.parentRevisionId, old.revisionId);
assert.deepEqual(upgraded.gestures[0].positives, old.gestures[0].positives);
assert.equal(upgraded.gestures[0].actionId, old.gestures[0].actionId);
assert.deepEqual(recognized(stroke(right), upgraded), ['right']);
const upgradedRun = {...createRun(upgraded, source, 'recognition'), frames: twice};
assert.equal(upgradedRun.version, 3);
assert.equal(readTrajectory(upgradedRun), twice);
console.log('PASS profile round trip, invalid configuration and legacy trajectory input');

const run = {...createRun(profile, source, 'recognition'), frames: twice, ...replay(twice, profile)};
const labels = {
  version: 1, complete: true, timeline: 'media-ms', runId: run.runId, participantId: 'synthetic',
  task: {kind: 'mixed', startMs: twice[0].tMs, endMs: twice.at(-1).tMs},
  rawVideo: {file: 'synthetic-placeholder', offsetMs: 0},
  intentions: [{intentId: 'first', gestureId: 'right', actionId: 'next_page', startMs: 200, endMs: 800}],
};
assert.equal(preflightStudy(undefined, undefined).ready, false);
assert.ok(preflightStudy(undefined, undefined).missing.length >= 3);
assert.equal(preflightStudy(run, labels).ready, false);
assert.throws(() => alignIntentions(run, {...labels, complete: false}), /已完成标注/);
let alignment = alignIntentions(run, labels);
assert.deepEqual(alignment.matched, [{intentId: 'first', eventIndex: 0}]);
assert.deepEqual(alignment.review.map(item => item.kind), ['false_trigger']);
const negativeDecision = {reviewId: alignment.review[0].reviewId, status: 'confirmed', kind: 'negative'};
assert.throws(() => applyConfirmedReviews(profile, run, labels, [{...negativeDecision, status: 'pending'}]), /confirmed/);
const withNegative = applyConfirmedReviews(profile, run, labels, [negativeDecision]);
assert.equal(withNegative.gestures[0].negatives[0].source.runId, run.runId);
assert.equal(withNegative.gestures[0].negatives[0].confirmation, 'confirmed_review');
assert.throws(() => applyConfirmedReviews(withNegative, run, labels, [negativeDecision]), /已加入/);
const comparisons = compareProfiles(run, [profile, withNegative]);
assert.equal(comparisons[0].frames, comparisons[1].frames);
assert.equal(comparisons[0].events.length, 2);
assert.equal(comparisons[1].events.length, 0);
assert.equal(comparisons[1].profile.revisionId, withNegative.revisionId);
assert.equal(comparisons[1].source.synthetic, true);

const wrongIntent = {intentId: 'other', gestureId: 'left', actionId: 'previous_page', startMs: 1450, endMs: 2050};
alignment = alignIntentions(run, {...labels, intentions: [...labels.intentions, wrongIntent]});
assert.deepEqual(alignment.review.map(item => item.kind), ['wrong_class']);
const wrongBinding = {...labels, intentions: [{...labels.intentions[0], actionId: 'previous_page'}]};
alignment = alignIntentions(run, wrongBinding);
assert.deepEqual(alignment.review.map(item => item.kind), ['wrong_action', 'false_trigger']);
assert.throws(() => applyConfirmedReviews(profile, run, wrongBinding, [{
  reviewId: alignment.review[0].reviewId, status: 'confirmed', kind: 'negative',
}]), /类别不对应/);
const extraEvent = {...run.events[0], tMs: run.events[0].tMs + 20};
alignment = alignIntentions({...run, events: [run.events[0], extraEvent]}, labels);
assert.deepEqual(alignment.review.map(item => item.kind), ['duplicate']);
const overlapping = {...labels, intentions: [
  {...labels.intentions[0], endMs: 2200}, {...labels.intentions[0], intentId: 'narrow'},
]};
assert.equal(alignIntentions(run, overlapping).matched.length, 2);
const noEvent = {...run, events: []};
alignment = alignIntentions(noEvent, labels);
assert.equal(alignment.review[0].kind, 'missed');
const withPositive = applyConfirmedReviews(profile, noEvent, labels, [{
  reviewId: alignment.review[0].reviewId, status: 'confirmed', kind: 'positive', clip: {startMs: 200, endMs: 800},
}]);
assert.equal(withPositive.gestures[0].positives.length, 3);
assert.equal(withPositive.parentRevisionId, profile.revisionId);
console.log('PASS synthetic: one-to-one intent alignment, review categories, confirmed updates and same-input comparison');

// 3D fixture with a fixed palm, separately articulated fingers, and mirrored hands.
const open = [0, 0, 0, 0, 0];
const fist = [0.85, 1, 1, 1, 1];
const indexCurl = [0, 1, 0, 0, 0];
const relaxed = [0.35, 0.42, 0.48, 0.55, 0.58];
const interpolate = (a, b, p) => a.map((value, i) => value + (b[i] - value) * p);
const bases = [[-.023, .024], [-.023, -.009], [-.007, -.016], [.01, -.012], [.024, -.006]];
const lengths = [[.020, .018, .015], [.025, .015, .012], [.028, .018, .013], [.026, .016, .012], [.021, .012, .011]];

function articulatedFrame(tMs, curls, {side = 'Right', x = .48, y = .54, scale = 1, tilt = 0, jitter = 0} = {}) {
  const points = [[0, .038, 0]];
  for (const [finger, base] of bases.entries()) {
    let [px, py] = base, pz = 0;
    points.push([px, py, pz]);
    const splay = [-1.04, -.22, -.03, .16, .37][finger];
    for (const [joint, length] of lengths[finger].entries()) {
      const angle = curls[finger] * [0.64, 1.80, 2.56][joint];
      px += length * Math.sin(splay) * Math.cos(angle);
      py -= length * Math.cos(splay) * Math.cos(angle);
      pz -= length * Math.sin(angle);
      points.push([px, py, pz]);
    }
  }
  const handed = side === 'Left' ? -1 : 1;
  const aspect = 4 / 3;
  return {
    ...frame(tMs, x, y), side, trackerVersion: 'single-hand-v5',
    hand: points.map(([px, py, pz], i) => ({
      x: x + scale * (handed * px * Math.cos(tilt) - py * Math.sin(tilt)) / aspect +
        jitter * Math.sin(tMs + i * 1.3),
      y: y + scale * (handed * px * Math.sin(tilt) + py * Math.cos(tilt)),
      z: scale * pz / aspect,
    })),
  };
}

function sequence(shape, {t0 = 0, startMs = 90, moveMs = 360, endMs = 1100, tick = 30, offset = () => 0, ...view} = {}) {
  return Array.from({length: Math.floor(endMs / tick) + 1}, (_, i) => {
    const elapsed = i * tick;
    const progress = Math.max(0, Math.min(1, (elapsed - startMs) / moveMs));
    return articulatedFrame(t0 + elapsed, shape(progress), {...view, x: (view.x ?? .48) + offset(progress)});
  });
}

function learn(name, type, recordings) {
  return {...createGesture(name, null, type), gestureId: name,
    positives: recordings.map(raw => createExample(prepareExample(raw, type), source))};
}

const poseOpen = learn('open', 'static', [sequence(() => open)]);
const poseFist = learn('fist', 'static', [sequence(() => fist), sequence(() => fist, {tilt: .24, scale: .78})]);
const poseProfile = {...profile, gestures: [poseOpen, poseFist]};
const fistTest = sequence(() => fist, {side: 'Left', x: .66, scale: 1.22, tilt: -.35, jitter: .0005, endMs: 3000});
assert.deepEqual(recognized(fistTest, poseProfile), ['fist']);
assert.deepEqual(recognized(sequence(() => relaxed), poseProfile), []);
assert.throws(() => prepareExample(sequence(() => fist, {endMs: 100}), 'static'), /保持稳定/);
const leftBeforeFinish = sequence(() => fist, {endMs: 640}).map(f => f.tMs > 330 ? {...f, hand: null} : f);
const savedBeforeExit = prepareExample(leftBeforeFinish, 'static');
assert.equal(savedBeforeExit.at(-1).tMs, 330);
const leftLongAgo = [...leftBeforeFinish, {...frame(1200, .5, .5), hand: null}];
assert.throws(() => prepareExample(leftLongAgo, 'static'), /保持稳定/);
const staticEvent = replay(fistTest, poseProfile).events[0];
assert.equal(staticEvent.gestureType, 'static');
assert.ok(staticEvent.tMs >= poseProfile.settings.staticHoldMs);
const releaseAndRepeat = [
  ...sequence(() => fist, {endMs: 350}),
  ...sequence(() => relaxed, {t0: 390, endMs: 390}),
  ...sequence(() => fist, {t0: 840, endMs: 720}),
];
assert.deepEqual(recognized(releaseAndRepeat, poseProfile), ['fist', 'fist']);
const leftHand = {label: 'Left', score: 0.52, landmarks: fistTest[0].hand};
assert.equal(selectSingleHand([leftHand]).side, 'Left');
assert.equal(selectSingleHand([leftHand], true).side, 'Right');
assert.equal(selectSingleHand([leftHand, {...leftHand, label: 'Right'}]), null);
const samePose = learn('other-fist', 'static', [sequence(() => fist)]);
assert.equal(replay(fistTest, {...poseProfile, gestures: [poseFist, samePose]}).rejections[0].reason, 'ambiguous');
const vetoedPose = {...poseFist, negatives: [createExample(prepareExample(fistTest, 'static'), source)]};
assert.equal(replay(fistTest, {...poseProfile, gestures: [vetoedPose]}).rejections[0].reason, 'negative_match');
console.log('PASS synthetic: either hand, mirrored pose, short hold, normalization, static rejection and release');

const openHand = p => interpolate(fist, open, p);
const closeHand = p => interpolate(open, fist, p);
const tapIndex = p => interpolate(open, indexCurl, 1 - Math.abs(2 * p - 1));
const graspThenOpen = p => interpolate(open, fist, 1 - Math.abs(2 * p - 1));
const opening = learn('opening', 'dynamic', [sequence(openHand), sequence(openHand, {moveMs: 470, scale: .9})]);
const closing = learn('closing', 'dynamic', [sequence(closeHand)]);
const tapping = learn('finger-tap', 'dynamic', [sequence(tapIndex)]);
const grab = learn('grasp-open', 'dynamic', [sequence(graspThenOpen)]);
const slide = learn('small-slide', 'dynamic', [sequence(() => relaxed, {offset: p => .025 * p, moveMs: 260})]);
const mixed = {...profile, gestures: [opening, closing, tapping, grab, slide, poseOpen, poseFist]};

const fingerOnly = sequence(tapIndex, {side: 'Left', moveMs: 270, jitter: .0003});
for (const i of [0, 5, 9, 13, 17]) {
  assert.deepEqual(sequence(tapIndex)[0].hand[i], sequence(tapIndex)[9].hand[i]);
}
assert.deepEqual(recognized(fingerOnly, mixed), ['finger-tap']);
assert.deepEqual(recognized(sequence(graspThenOpen, {side: 'Left', moveMs: 480}), mixed), ['grasp-open']);
const shortOpening = sequence(openHand, {side: 'Left', moveMs: 160, jitter: .0003});
assert.deepEqual(recognized(shortOpening, mixed), ['opening']);
assert.deepEqual(recognized(sequence(closeHand, {side: 'Left', moveMs: 320}), mixed), ['closing']);
assert.deepEqual(recognized(sequence(() => relaxed, {offset: p => .020 * p, moveMs: 170, side: 'Left'}), mixed), ['small-slide']);
const twoHands = shortOpening.map(f => f.tMs === 180 ? {...f, hand: null, hands: [{}, {}]} : f);
assert.ok(replay(twoHands, mixed).rejections.some(item => item.reason === 'multiple_hands'));
assert.equal(replay(twoHands, mixed).events.some(event => event.gestureType === 'dynamic'), false);
assert.deepEqual(recognized(sequence(() => relaxed, {jitter: .0008}), mixed), []);
assert.deepEqual(replay(fingerOnly, compileProfile(JSON.parse(JSON.stringify(mixed))).profile).events,
  replay(fingerOnly, mixed).events);
console.log('PASS synthetic: short finger motion, fist-to-open/open-to-fist, relaxed small slide and no duplicate terminal pose');
