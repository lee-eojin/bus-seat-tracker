import { boardingVerdict, expectedDemandAt, type BoardingVerdict } from './boarding.js';
import { isNonBoardingStop, type ProfileRoute } from './model.js';
import {
  applyNetDemand,
  defaultSeatCapacity,
  distributionMean,
  netDemandAt,
  pointDistribution,
} from './profile.js';
import { estimatedTravelTimeMs, seoulBucketAt } from './travel-time.js';

export interface ForecastStop {
  sequence: number;
  name: string | null;
}

export interface SeatForecast {
  sequence: number;
  horizon: number;
  arrivalMean: number;
  seatAvailableProbability: number;
  lowConfidence: boolean;
  verdict: BoardingVerdict;
  streakKnown: boolean;
  boardingAllowed: boolean;
}

export interface VehicleForecastRequest {
  routeName: string;
  currentSequence: number;
  remainingSeats: number;
  stops: readonly ForecastStop[];
  profile: ProfileRoute;
  fullDepartureStreaks: Readonly<Record<string, number>>;
  forecastAt: number;
  capacity?: number;
}

export function forecastVehicleStops(request: VehicleForecastRequest): SeatForecast[] {
  if (request.remainingSeats < 0) return [];

  const capacity = request.capacity ?? defaultSeatCapacity;
  let distribution = pointDistribution(request.remainingSeats, capacity);
  const currentBucket = seoulBucketAt(request.forecastAt);
  const currentDemand = netDemandAt(
    request.profile,
    request.currentSequence,
    currentBucket.bucket,
    currentBucket.weekend,
  );
  let lowConfidence = currentDemand.lowConfidence;
  distribution = applyNetDemand(distribution, currentDemand, capacity);

  const forecasts: SeatForecast[] = [];
  let horizon = 0;
  for (const stop of request.stops) {
    if (stop.sequence <= request.currentSequence) continue;
    horizon += 1;

    const arrivalMean = distributionMean(distribution);
    const timeBucket = seoulBucketAt(request.forecastAt + estimatedTravelTimeMs(horizon));
    const stopDemand = netDemandAt(
      request.profile,
      stop.sequence,
      timeBucket.bucket,
      timeBucket.weekend,
    );
    lowConfidence = lowConfidence || stopDemand.lowConfidence;
    distribution = applyNetDemand(distribution, stopDemand, capacity);

    let seatAvailableProbability = 0;
    for (let seats = 1; seats < distribution.length; seats += 1) {
      seatAvailableProbability += distribution[seats] ?? 0;
    }

    const streak = request.fullDepartureStreaks[String(stop.sequence)];
    forecasts.push({
      sequence: stop.sequence,
      horizon,
      arrivalMean,
      seatAvailableProbability,
      lowConfidence,
      verdict: boardingVerdict({
        arrivalSeats: arrivalMean,
        expectedDemand: expectedDemandAt(
          (bucket) => netDemandAt(request.profile, stop.sequence, bucket, timeBucket.weekend).mean,
          timeBucket.bucket,
        ),
        fullDepartureStreak: streak ?? 0,
      }),
      streakKnown: streak !== undefined,
      boardingAllowed: !isNonBoardingStop(stop.name),
    });
  }

  return forecasts;
}
