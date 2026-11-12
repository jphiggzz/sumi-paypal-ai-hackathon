"use client";

import { useSyncExternalStore } from "react";

// Based on the supplied clips, with a shorter welcome handoff for review.
export const referenceMotion = {
  stepExitDuration: 180,
  appRevealDuration: 350,
  welcomeDuration: 2400,
  welcomeExitDuration: 220,
  tourResponseDelay: 320,
  reflowDuration: 420,
  reflowEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
  responseDuration: 4933,
} as const;

const query = "(prefers-reduced-motion: reduce)";
const getReducedMotion = () => window.matchMedia(query).matches;
const getServerReducedMotion = () => false;
function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useReferenceReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getServerReducedMotion,
  );
}
