import { invariant } from "./errors.js";

export const REVIEW_FOCI = Object.freeze([
  "correctness",
  "tests",
  "security",
  "error-handling",
  "simplicity"
]);

export const EFFORT_PROFILES = Object.freeze({
  standard: Object.freeze({
    researchLanes: 0,
    designAlternatives: 0,
    planSteps: 1,
    riskItems: 0,
    uniqueReads: 3,
    checkpoints: 0,
    reviewFoci: Object.freeze([])
  }),
  thorough: Object.freeze({
    researchLanes: 2,
    designAlternatives: 2,
    planSteps: 5,
    riskItems: 2,
    uniqueReads: 5,
    checkpoints: 1,
    reviewFoci: Object.freeze(["correctness", "tests", "error-handling"])
  }),
  max: Object.freeze({
    researchLanes: 3,
    designAlternatives: 3,
    planSteps: 8,
    riskItems: 3,
    uniqueReads: 8,
    checkpoints: 2,
    reviewFoci: REVIEW_FOCI
  })
});

export function normalizeEffortProfile(value = "standard") {
  const profile = String(value || "standard").trim().toLowerCase();
  invariant(Object.hasOwn(EFFORT_PROFILES, profile), "INVALID_INPUT", "effortProfile must be standard, thorough, or max");
  return profile;
}

export function requirementsFor(profile) {
  return EFFORT_PROFILES[normalizeEffortProfile(profile)];
}
