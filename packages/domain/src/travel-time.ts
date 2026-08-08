export const estimatedMinutesPerStop = 2;

export function estimatedTravelTimeMs(stops: number): number {
  return stops * estimatedMinutesPerStop * 60_000;
}

export interface SeoulTimeBucket {
  bucket: number;
  weekend: boolean;
}

export function seoulBucketAt(timestampMs: number): SeoulTimeBucket {
  const seoulClock = new Date(timestampMs + 9 * 60 * 60_000);
  const day = seoulClock.getUTCDay();
  return {
    bucket: seoulClock.getUTCHours() * 2 + (seoulClock.getUTCMinutes() >= 30 ? 1 : 0),
    weekend: day === 0 || day === 6,
  };
}
