export function selectRightHand(hands, sourceMirrored = false) {
  const target = sourceMirrored ? 'Left' : 'Right';
  const candidates = hands.filter(h => h.label === target && h.score >= 0.6);
  return candidates.sort((a,b)=>b.score-a.score)[0] ?? null;
}
