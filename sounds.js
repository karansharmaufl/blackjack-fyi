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
  attack = null,
  curve = 1.8,
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
      // Cardstock grain: white noise with a fast paper decay
      const env = Math.pow(1 - i / len, curve);
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
    const atk = attack != null ? attack : Math.min(0.012, duration * 0.2);
    const g = envGain(gain, atk, gain * 0.45, duration, t0);
    if (!g) return;
    src.connect(filter);
    filter.connect(g);
    src.start(t0);
    src.stop(t0 + duration + 0.04);
  } catch {
    /* ignore */
  }
}

/**
 * Card pulled from a shoe: sharp lip slip → short scrape → soft felt land.
 * (Not a long felt whoosh.)
 */
function cardFlick({ land = true, brighter = false } = {}) {
  if (!enabled) return;
  const jitter = () => (Math.random() - 0.5);

  // 1) Snap / slip off the shoe lip — crisp, short, high
  noise({
    duration: 0.028 + Math.random() * 0.012,
    gain: brighter ? 0.07 : 0.058,
    band: (brighter ? 4200 : 3400) + jitter() * 400,
    filterType: "bandpass",
    q: 2.4,
    freqSlide: brighter ? 2600 : 2100,
    attack: 0.0015,
    curve: 3.2,
  });

  // 2) Card leaving the shoe — dry cardboard scrape
  noise({
    duration: 0.07 + Math.random() * 0.025,
    gain: brighter ? 0.048 : 0.04,
    delay: 0.012,
    band: (brighter ? 2100 : 1650) + jitter() * 180,
    filterType: "bandpass",
    q: 1.1,
    freqSlide: brighter ? 1100 : 850,
    attack: 0.004,
    curve: 2.4,
  });

  // 3) Thin paper edge hiss (keeps it from sounding like wind)
  noise({
    duration: 0.05,
    gain: 0.018,
    delay: 0.02,
    band: 5200 + jitter() * 300,
    filterType: "highpass",
    q: 0.7,
    freqSlide: 2800,
    attack: 0.002,
    curve: 2.8,
  });

  if (land) {
    // Soft slap onto felt
    tone({
      freq: 165 + jitter() * 18,
      duration: 0.055,
      type: "triangle",
      gain: 0.028,
      delay: 0.055,
      slideTo: 95,
    });
    noise({
      duration: 0.045,
      gain: 0.022,
      delay: 0.058,
      band: 380,
      filterType: "lowpass",
      q: 0.8,
      attack: 0.002,
      curve: 2.6,
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
