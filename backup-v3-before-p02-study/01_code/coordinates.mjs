// Facing the camera, the user's right is left in an unmirrored image.
export function bodyCoordinates(hand, sourceMirrored = false) {
  return hand ? hand.map(p => ({...p, x: sourceMirrored ? p.x : 1-p.x})) : null;
}
