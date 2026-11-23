import {bodyCoordinates} from '../coordinates.mjs';
import {selectSingleHand} from '../hand-selection.mjs';
import {createFrameReader, observeFrame, trackerVersion} from './hand-features.mjs';

function observations(frame) {
  const raw = frame.hands?.filter(hand => hand?.landmarks?.length === 21) ?? [];
  const hands = raw.length && !frame.handTrackId ? raw.slice(0, 2).map(hand => {
    const selected = selectSingleHand([hand], frame.sourceMirrored);
    return {hand: bodyCoordinates(hand.landmarks, frame.sourceMirrored), side: selected.side, score: selected.score};
  }) : [{hand: frame.hand, side: frame.side, score: frame.handScore}];
  return hands.flatMap(hand => {
    const point = observeFrame({...frame, hand: hand.hand});
    return point ? [{...hand, point}] : [];
  });
}

function mergeCost(track, observation, tMs) {
  if (!track || !observation) return Infinity;
  const {point, score, side} = observation;
  const elapsed = tMs - track.tMs;
  const elapsedHint = Math.min(elapsed, 70);
  const predictedX = track.x + track.vx * elapsedHint;
  const predictedY = track.y + track.vy * elapsedHint;
  const distance = Math.hypot(point.x - predictedX, point.y - predictedY);
  if (distance > Math.max(.16, 2.7 * Math.max(point.scale, track.scale))) return Infinity;
  // Handedness flickers during turning and occlusion. Use it as a hint, not an identity.
  const sideCost = track.side && side && track.side !== side && score >= .72 ? .085 : 0;
  const scaleCost = .065 * Math.abs(Math.log(point.scale / track.scale));
  return distance + sideCost + scaleCost;
}

const restartCost = track => track ? .29 : .23;
const credibleSide = ({side, score}) => side && (score == null || score >= .62) ? side : null;

export function createHandTracks({maxGapMs = 190} = {}) {
  const read = createFrameReader();
  const slots = [null, null];
  let nextId = 1;
  const carryMs = Math.max(440, maxGapMs + 180);

  function update(slot, observation, tMs) {
    const {point} = observation;
    const previous = slots[slot];
    const reuse = mergeCost(previous, observation, tMs) < restartCost(previous);
    const interval = reuse ? tMs - previous.tMs : Infinity;
    slots[slot] = {
      ...point, id: reuse ? previous.id : 'hand-' + nextId++,
      side: (reuse && previous.side) || credibleSide(observation),
      vx: reuse ? (point.x - previous.x) / interval * .70 : 0,
      vy: reuse ? (point.y - previous.y) / interval * .70 : 0,
    };
  }

  function push(frame) {
    read(frame); // Validate the source time and projection before updating identities.
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && frame.tMs - slots[i].tMs > carryMs) slots[i] = null;
    }
    const [first = null, second = null] = observations(frame);
    const score = (track, observation) => observation ?
      Math.min(restartCost(track), mergeCost(track, observation, frame.tMs)) : 0;
    const straight = score(slots[0], first) + score(slots[1], second);
    const swapped = score(slots[0], second) + score(slots[1], first);
    const assignment = straight <= swapped ? [first, second] : [second, first];
    return assignment.flatMap((observation, slot) => {
      if (observation) update(slot, observation, frame.tMs);
      const track = slots[slot];
      if (!track) return [];
      const {hands: _allHands, ...rest} = frame;
      return [{
        ...rest, trackerVersion, handTrackId: track.id, side: observation ? track.side : null,
        hand: observation?.hand ?? null, handScore: observation?.score ?? null,
      }];
    });
  }
  return {push};
}

export function projectHandTracks(frames, settings) {
  const tracker = createHandTracks(settings);
  const tracks = new Map();
  for (const frame of frames) {
    for (const projected of tracker.push(frame)) {
      if (!tracks.has(projected.handTrackId)) tracks.set(projected.handTrackId, []);
      tracks.get(projected.handTrackId).push(projected);
    }
  }
  return tracks;
}
