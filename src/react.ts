import { useCallback, useSyncExternalStore } from 'react';

/** Anything hue-web exposes as a live value: a store, an effect manager. */
export interface Subscribable<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

/**
 * Subscribes a component to a hue-web store or effect manager.
 *
 * ```tsx
 * const { lights } = useHue(store);
 * const active = useHue(effects, (s) => s.active);
 * ```
 *
 * A `select`or must return something stable (a field, a primitive), not a new
 * object or array on each call.
 */
export function useHue<T>(source: Subscribable<T>): T;
export function useHue<T, S>(source: Subscribable<T>, select: (snapshot: T) => S): S;
export function useHue<T, S>(source: Subscribable<T>, select?: (snapshot: T) => S): T | S {
  const read = useCallback(() => (select ? select(source.getSnapshot()) : source.getSnapshot()), [source, select]);
  return useSyncExternalStore(source.subscribe, read, read);
}
