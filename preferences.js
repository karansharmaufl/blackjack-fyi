/** Persist table preferences in the browser (localStorage). */

import { CASINOS, getDefaultCasino } from "./casinos.js";

const STORAGE_KEY = "bj-prefs-v1";
const COOKIE_NAME = "bj_setup";

const DEFAULTS = {
  setupComplete: false,
  casinoAbbr: null,
  bjPayout: "3:2",
  hitSoft17: false,
  deckCount: 2,
  playerCut: true,
  autoDeal: false,
  sideBetsEnabled: false,
  soundEnabled: true,
};

function writeSetupCookie(complete) {
  try {
    const maxAge = 60 * 60 * 24 * 365 * 2; // 2 years
    if (complete) {
      document.cookie = `${COOKIE_NAME}=1; path=/; max-age=${maxAge}; SameSite=Lax`;
    } else {
      document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
    }
  } catch {
    /* ignore */
  }
}

export function loadPreferences() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...parsed,
      setupComplete: !!parsed.setupComplete,
      bjPayout: parsed.bjPayout === "6:5" ? "6:5" : "3:2",
      hitSoft17: !!parsed.hitSoft17,
      deckCount: [1, 2, 4, 6, 8].includes(parsed.deckCount)
        ? parsed.deckCount
        : DEFAULTS.deckCount,
      playerCut: parsed.playerCut !== false,
      autoDeal: !!parsed.autoDeal,
      sideBetsEnabled: !!parsed.sideBetsEnabled,
      soundEnabled: parsed.soundEnabled !== false,
      casinoAbbr:
        typeof parsed.casinoAbbr === "string" ? parsed.casinoAbbr : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(partial) {
  const current = loadPreferences();
  const next = { ...current, ...partial };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    writeSetupCookie(!!next.setupComplete);
  } catch {
    /* ignore */
  }
  return next;
}

export function clearPreferences() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  writeSetupCookie(false);
  return { ...DEFAULTS };
}

export function casinoFromPreferences(prefs) {
  if (!prefs?.casinoAbbr) return getDefaultCasino();
  return (
    CASINOS.find((c) => c.abbr === prefs.casinoAbbr) || getDefaultCasino()
  );
}

export function hasCompletedSetup(prefs = loadPreferences()) {
  return !!(prefs.setupComplete && prefs.casinoAbbr);
}
