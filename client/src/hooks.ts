import { useEffect, useState, useSyncExternalStore } from 'react';
import { lamport } from './lamport';
import { replica } from './replica';

export const useReplica = () => useSyncExternalStore(replica.subscribe, replica.getSnapshot);

export const useLamport = () =>
  useSyncExternalStore(
    (fn) => {
      const un = lamport.subscribe(fn);
      return () => void un();
    },
    () => lamport.value,
  );

/** Re-renderiza periodicamente (contadores regressivos). */
export function useNow(ms = 500) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return replica.serverNow();
}
