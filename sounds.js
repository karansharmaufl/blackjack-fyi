/** Lightweight felt SFX via Web Audio — no asset files. */

const STORAGE_KEY = "bj-sound";

let ctx = null;
let master = null;
let enabled = true;

try {
  enabled = localStorage.getItem(STORAGE_KEY) !== "0";
} catch {
  enabled = true;
}

export function getSoundEnabled() {
  return enabled;
}

export function setSoundEnabled(on) {
  enabled = !!on;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (enabled) unlockAudio();
}

function ensureCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function unlockAudio() {
  try {
    const c = ensureCtx();
    if (c && c.state === "suspended") c.resume();
  } catch {
    /* ignore */
  }
}

function now() {
  const c = ensureCtx();
  return c ? c.currentTime : 0;
}

function envGain(startGain, attack, sustain, release, t0) {
  const c = ensureCtx();
  if (!c || !master) return null;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, startGain), t0 + attack);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, sustain), t0 + attack + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + release);
  g.connect(master);
  return g;
}

function tone({
  freq = 440,
  duration = 0.12,
  type = "sine",
  gain = 0.08,
  delay = 0,
  slideTo = null,
}) {
  if (!enabled) return;
  try {
    const c = ensureCtx();
    if (!c) return;
    const t0 = now() + delay;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + duration);
    }
    const g = envGain(gain, 0.008, gain * 0.7, duration, t0);
    if (!g) return;
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  } catch {
    /* ignore */
  }
}

function noise({
  duration = 0.08,
  gain = 0.05,
  delay = 0,
  band = 1800,
  filterType = "bandpass",
  q = 0.9,
  freqSlide = null,
}) {
  if (!enabled) return;
  try {
    const c = ensureCtx();
    if (!c) return;
    const t0 = now() + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * duration));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      // Soft paper-ish grain: mix white + gentle roll-off envelope
      const env = Math.pow(1 - i / len, 1.35);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(band, t0);
    if (freqSlide != null) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, freqSlide),
        t0 + duration
      );
    }
    filter.Q.value = q;
    const g = envGain(gain, Math.min(0.02, duration * 0.25), gain * 0.5, duration, t0);
    if (!g) return;
    src.connect(filter);
    filter.connect(g);
    src.start(t0);
    src.stop(t0 + duration + 0.04);
  } catch {
    /* ignore */
  }
}

/** Slow card slide across felt: soft whoosh + gentle land. */
function cardFlick({ land = true, brighter = false } = {}) {
  if (!enabled) return;
  const jitter = () => (Math.random() - 0.5);
  // Long soft scrape (not a snap)
  noise({
    duration: 0.16 + Math.random() * 0.04,
    gain: brighter ? 0.038 : 0.032,
    band: (brighter ? 2200 : 1800) + jitter() * 250,
    filterType: "bandpass",
    q: 0.45,
    freqSlide: brighter ? 900 : 700,
  });
  // Airy paper trail
  noise({
    duration: 0.14,
    gain: 0.022,
    delay: 0.04,
    band: 900 + jitter() * 120,
    filterType: "lowpass",
    q: 0.6,
    freqSlide: 320,
  });
  if (land) {
    // Soft felt settle
    tone({
      freq: 140 + jitter() * 12,
      duration: 0.14,
      type: "sine",
      gain: 0.022,
      delay: 0.1,
      slideTo: 80,
    });
    noise({
      duration: 0.09,
      gain: 0.016,
      delay: 0.11,
      band: 220,
      filterType: "lowpass",
      q: 0.5,
    });
  }
}

export const sfx = {
  chip() {
    tone({ freq: 620, duration: 0.05, type: "triangle", gain: 0.05 });
    tone({ freq: 920, duration: 0.04, type: "sine", gain: 0.03, delay: 0.02 });
    noise({ duration: 0.035, gain: 0.028, band: 2400 });
  },
  deal() {
    cardFlick({ land: true, brighter: false });
  },
  flip() {
    // Turn-over: brighter scrape, then settle
    cardFlick({ land: true, brighter: true });
    tone({
      freq: 420,
      duration: 0.08,
      type: "triangle",
      gain: 0.03,
      delay: 0.04,
      slideTo: 560,
    });
  },
  win() {
    tone({ freq: 523, duration: 0.1, type: "sine", gain: 0.06 });
    tone({ freq: 659, duration: 0.12, type: "sine", gain: 0.055, delay: 0.08 });
    tone({ freq: 784, duration: 0.16, type: "triangle", gain: 0.05, delay: 0.16 });
  },
  blackjack() {
    tone({ freq: 587, duration: 0.1, type: "sine", gain: 0.065 });
    tone({ freq: 740, duration: 0.12, type: "sine", gain: 0.06, delay: 0.07 });
    tone({ freq: 880, duration: 0.14, type: "triangle", gain: 0.055, delay: 0.14 });
    tone({ freq: 1175, duration: 0.2, type: "sine", gain: 0.04, delay: 0.24 });
  },
  lose() {
    tone({ freq: 220, duration: 0.16, type: "triangle", gain: 0.05, slideTo: 140 });
    noise({ duration: 0.08, gain: 0.03, band: 400, delay: 0.02, filterType: "lowpass" });
  },
  push() {
    tone({ freq: 400, duration: 0.08, type: "sine", gain: 0.04 });
    tone({ freq: 400, duration: 0.08, type: "sine", gain: 0.03, delay: 0.1 });
  },
  shuffle() {
    for (let i = 0; i < 5; i += 1) {
      noise({
        duration: 0.09,
        gain: 0.024,
        band: 1400 + i * 160,
        filterType: "bandpass",
        q: 0.55,
        delay: i * 0.09,
        freqSlide: 700 + i * 60,
      });
    }
  },
  cut() {
    cardFlick({ land: true, brighter: false });
  },
  click() {
    tone({ freq: 760, duration: 0.03, type: "square", gain: 0.02 });
  },
};

export function playSettleSounds(hands) {
  if (!enabled || !hands?.length) return;
  const statuses = hands.map((h) => h.status);
  if (statuses.some((s) => s === "blackjack")) {
    sfx.blackjack();
    return;
  }
  if (statuses.some((s) => s === "won")) {
    sfx.win();
    return;
  }
  if (statuses.every((s) => s === "push")) {
    sfx.push();
    return;
  }
  if (statuses.some((s) => s === "lost" || s === "bust")) {
    sfx.lose();
  }
}
