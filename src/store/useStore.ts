import { useSyncExternalStore } from 'react';

/**
 * Minimal dependency-free client store (no zustand needed).
 * Holds only non-sensitive UI/session hints; the server session is the
 * source of truth for authentication.
 */
export interface StoreState {
  isLoggedIn: boolean;
  username: string | null;
}

type Listener = () => void;

let state: StoreState = { isLoggedIn: false, username: null };
const listeners = new Set<Listener>();

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => state;

export const setStore = (patch: Partial<StoreState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const useStore = (): StoreState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
