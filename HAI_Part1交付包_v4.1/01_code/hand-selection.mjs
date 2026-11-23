export function selectRightHand(hands, sourceMirrored = false) {
  const target = sourceMirrored ? 'Left' : 'Right';
  const candidates = hands.filter(h => h.label === target && h.score >= 0.6);
  return candidates.sort((a,b)=>b.score-a.score)[0] ?? null;
}

export function selectSingleHand(hands, sourceMirrored = false) {
  if (hands.length !== 1 || hands[0].landmarks?.length !== 21) return null;
  const hand = hands[0];
  const side = hand.label === 'Left' || hand.label === 'Right' ? hand.label : null;
  return {...hand, side: sourceMirrored && side ? (side === 'Left' ? 'Right' : 'Left') : side};
}
