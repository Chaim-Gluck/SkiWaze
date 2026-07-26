import { useCallback, useEffect, useRef, useState } from 'react';

/** A single live-position sample (subset of the Geolocation API, normalized). */
export interface LivePosition {
  lon: number;
  lat: number;
  /** Horizontal accuracy in metres (95% confidence). */
  accuracy: number;
  /** Compass heading in degrees (0 = north), or null when unknown/stationary. */
  heading: number | null;
  /** Ground speed in m/s, or null when unknown. */
  speed: number | null;
  ts: number;
}

export interface LiveLocation {
  position: LivePosition | null;
  tracking: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * Continuous geolocation via `watchPosition`. Starts only when `start()` is called
 * (a user gesture), streams normalized samples, and cleans up the watch on stop/unmount.
 */
export function useLiveLocation(): LiveLocation {
  const [position, setPosition] = useState<LivePosition | null>(null);
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    if (!tracking) return;
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not available in this browser.');
      setTracking(false);
      return;
    }
    setError(null);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const h = p.coords.heading;
        setPosition({
          lon: p.coords.longitude,
          lat: p.coords.latitude,
          accuracy: p.coords.accuracy,
          heading: h != null && !Number.isNaN(h) ? h : null,
          speed: p.coords.speed,
          ts: p.timestamp,
        });
      },
      (e) => {
        setError(e.message || 'Could not get your location.');
        setTracking(false);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 },
    );
    watchId.current = id;
    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [tracking]);

  const start = useCallback(() => setTracking(true), []);
  const stop = useCallback(() => {
    setTracking(false);
    setPosition(null);
  }, []);

  return { position, tracking, error, start, stop };
}
