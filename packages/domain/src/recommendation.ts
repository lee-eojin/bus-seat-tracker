import {
  isNonBoardingStop,
  type Direction,
  type DisplayStop,
  type HistoryBucket,
  type HistoryRoute,
  type LatestRoute,
} from './model.js';

export const recommendationMinSamples = 10;
export const moveFullObservationRate = 0.5;
export const candidateFullObservationRate = 0.25;

export interface SelectedBoardingStop {
  routeName: string;
  sequence: number;
}

export interface RecommendationRequest {
  route: LatestRoute;
  history: HistoryRoute | null;
  selectedStop: SelectedBoardingStop | null;
  direction: Direction;
  bucket: number;
  weekend: boolean;
}

export type BoardingRecommendation =
  | { kind: 'unset' }
  | { kind: 'elsewhere' }
  | { kind: 'insufficient'; samples: number }
  | { kind: 'stay'; cell: HistoryBucket }
  | { kind: 'move'; target: DisplayStop; hops: number; myCell: HistoryBucket; targetCell: HistoryBucket }
  | { kind: 'no-candidate'; cell: HistoryBucket };

export interface ProbabilityInterval {
  low: number;
  high: number;
}

export function historyBucketAt(
  history: HistoryRoute | null,
  sequence: number,
  bucket: number,
  weekend: boolean,
): HistoryBucket | null {
  if (!history) return null;
  const buckets = weekend ? history.weekend : history.weekday;
  return buckets[String(sequence)]?.[String(bucket)] ?? null;
}

export function fullObservationRate(cell: HistoryBucket): number {
  return cell.samples > 0 ? cell.zeroCount / cell.samples : 0;
}

export function nonFullObservationRate(cell: HistoryBucket): number {
  return 1 - fullObservationRate(cell);
}

export function wilson95Interval(successes: number, trials: number): ProbabilityInterval {
  if (trials === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const rate = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (rate + (z * z) / (2 * trials)) / denominator;
  const spread = (z * Math.sqrt((rate * (1 - rate)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

export function recommendBoardingStop(request: RecommendationRequest): BoardingRecommendation {
  const { route, selectedStop } = request;
  if (!selectedStop) return { kind: 'unset' };
  if (selectedStop.routeName !== route.route.name) return { kind: 'elsewhere' };

  const stops = route.turnSequence === null
    ? route.stops
    : route.stops.filter((stop) => stop.direction === request.direction);
  const selectedIndex = stops.findIndex((stop) => stop.sequence === selectedStop.sequence);
  if (selectedIndex === -1) return { kind: 'elsewhere' };

  const selectedCell = historyBucketAt(request.history, selectedStop.sequence, request.bucket, request.weekend);
  if (!selectedCell || selectedCell.samples < recommendationMinSamples) {
    return { kind: 'insufficient', samples: selectedCell?.samples ?? 0 };
  }
  if (fullObservationRate(selectedCell) < moveFullObservationRate) {
    return { kind: 'stay', cell: selectedCell };
  }

  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    const candidate = stops[index];
    if (!candidate || isNonBoardingStop(candidate.name)) continue;
    const candidateCell = historyBucketAt(request.history, candidate.sequence, request.bucket, request.weekend);
    if (!candidateCell || candidateCell.samples < recommendationMinSamples) continue;
    if (fullObservationRate(candidateCell) < candidateFullObservationRate) {
      return {
        kind: 'move',
        target: candidate,
        hops: selectedIndex - index,
        myCell: selectedCell,
        targetCell: candidateCell,
      };
    }
  }

  return { kind: 'no-candidate', cell: selectedCell };
}
