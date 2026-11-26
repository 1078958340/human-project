const warpRadius = 4;

function featureDistance(left, right) {
  let squared = 0;
  for (let feature = 0; feature < left.length; feature++) {
    const difference = left[feature] - right[feature];
    squared += difference * difference;
  }
  // Normalized features stay in this range. Keep hypot's scaling for extreme input.
  if (squared >= 1e-300 && Number.isFinite(squared)) return Math.sqrt(squared);
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

export function motionDtw(left, right) {
  let previous = new Float64Array(right.length + 1).fill(Infinity);
  let current = new Float64Array(right.length + 1);
  previous[0] = 0;
  for (let row = 1; row <= left.length; row++) {
    current.fill(Infinity);
    const start = Math.max(1, row - warpRadius);
    const end = Math.min(right.length, row + warpRadius);
    for (let column = start; column <= end; column++) {
      const cost = featureDistance(left[row - 1], right[column - 1]);
      current[column] = cost + Math.min(previous[column], current[column - 1], previous[column - 1]);
    }
    const next = previous;
    previous = current;
    current = next;
  }
  return previous[right.length] / left.length;
}
