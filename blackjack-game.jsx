import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback, useId } from "react";
import { CASINOS, getDefaultCasino, getCasinoTheme } from "./casinos.js";

const FELT = {
  mark: "#E8DFC7",
  markDim: "rgba(232,223,199,0.35)",
  gold: "#C9A227",
  wood: "#4A2F1A",
  ink: "rgba(0,0,0,0.18)",
};

const SUITS = {
  H: { symbol: "♥", color: "#9B2C2C" },
  D: { symbol: "♦", color: "#9B2C2C" },
  S: { symbol: "♠", color: "#1A1A1A" },
  C: { symbol: "♣", color: "#1A1A1A" },
};

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT_KEYS = ["H", "D", "S", "C"];

const CHIP_DENOMS = [
  {
    value: 1,
    band: "#F4EFE3",
    mark: "#C9A227",
    markAlt: "#E8D48A",
    center: "#FFFEF9",
    ink: "#141414",
    face: "#F4EFE3",
    rim: "#C9A227",
    edge: "#D9D0BC",
    spot: "#C9A227",
  },
  {
    value: 5,
    band: "#A8D0E8",
    mark: "#2E6F9A",
    markAlt: "#7EB6D4",
    center: "#FFFEF9",
    ink: "#141414",
    // kept for stack shadow / legacy callers
    face: "#A8D0E8",
    rim: "#C9A227",
    edge: "#7EB6D4",
    spot: "#2E6F9A",
  },
  {
    value: 10,
    band: "#1F6B42",
    mark: "#D7EFE0",
    markAlt: "#8FCBAA",
    center: "#FFFEF9",
    ink: "#141414",
    face: "#1F6B42",
    rim: "#C9A227",
    edge: "#0F3F26",
    spot: "#D7EFE0",
  },
  {
    value: 25,
    band: "#A31F2B",
    mark: "#F7E4E6",
    markAlt: "#E39AA1",
    center: "#FFFEF9",
    ink: "#141414",
    face: "#A31F2B",
    rim: "#C9A227",
    edge: "#6B1218",
    spot: "#F7E4E6",
  },
  {
    value: 100,
    band: "#1A1A1A",
    mark: "#C9A227",
    markAlt: "#E8D48A",
    center: "#FFFEF9",
    ink: "#141414",
    face: "#1A1A1A",
    rim: "#C9A227",
    edge: "#050505",
    spot: "#C9A227",
  },
  {
    value: 500,
    band: "#5B2C6F",
    mark: "#E8D48A",
    markAlt: "#C39BD3",
    center: "#FFFEF9",
    ink: "#141414",
    face: "#5B2C6F",
    rim: "#C9A227",
    edge: "#3B1A48",
    spot: "#E8D48A",
  },
];

const DEFAULT_DECKS = 2;
const STARTING_BANK = 1000;
const DEAL_STEP_MS = 380;
const DEAL_FLIGHT_MS = 360;
const DEALER_DRAW_MS = 520;
const CHIP_FLY_MS = 700;
const SHUFFLE_MS = 2000;
const SHUFFLE_DECK_MS = 850;
const SHUFFLE_STACK_MS = 700;
const AUTO_DEAL_PAUSE_MS = 650;
const CHIP_ORDER = [500, 100, 25, 10, 5, 1];
/** Short shoes (1–2) finish faster for auto-deal analytics; multi-deck still available. */
const DECK_OPTIONS = [1, 2, 4, 6, 8];

/** Survives React Strict Mode remount so boot shuffle isn't cancelled mid-flight. */
let shoeSessionBootstrapped = false;

function createSessionStats(bank = STARTING_BANK) {
  return {
    rounds: 0,
    hands: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    blackjacks: 0,
    busts: 0,
    totalWagered: 0,
    netProfit: 0,
    peakBank: bank,
    lowBank: bank,
    startBank: bank,
    endBank: bank,
    startedAt: Date.now(),
    endedAt: null,
    endReason: null,
  };
}

function applyRoundToStats(stats, settledHands, bankAfter) {
  const next = { ...stats };
  next.rounds += 1;
  for (const h of settledHands) {
    next.hands += 1;
    next.totalWagered += h.bet || 0;
    next.totalWagered += h.sideBets?.pairs || 0;
    next.totalWagered += h.sideBets?.twentyOnePlus3 || 0;
    if (h.outcome === "blackjack" || h.status === "blackjack") {
      next.blackjacks += 1;
      next.wins += 1;
    } else if (h.outcome === "win" || h.status === "won") {
      next.wins += 1;
    } else if (h.outcome === "push" || h.status === "push") {
      next.pushes += 1;
    } else {
      next.losses += 1;
    }
    if (h.status === "bust") next.busts += 1;
  }
  next.endBank = bankAfter;
  next.peakBank = Math.max(next.peakBank, bankAfter);
  next.lowBank = Math.min(next.lowBank, bankAfter);
  // Prefer bank delta for net so doubles/splits/side bets stay consistent
  next.netProfit = bankAfter - next.startBank;
  return next;
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function endReasonLabel(reason) {
  if (reason === "shoe") return "Cut card — shoe complete";
  if (reason === "bank") return "Bankroll exhausted";
  if (reason === "manual") return "Session ended";
  return "Session complete";
}

function chipStyle(value) {
  return CHIP_DENOMS.find((c) => c.value === value) || CHIP_DENOMS[0];
}

/** Chips offered at a table given min/max bets. */
function chipsForTable(minBet = 5, maxBet = 1000) {
  const floor =
    [...CHIP_DENOMS].reverse().find((c) => c.value <= minBet)?.value ?? minBet;
  return CHIP_DENOMS.filter((c) => c.value >= floor && c.value <= maxBet);
}

/** Arc label + watermark initials for branded chips. */
function chipBrand(name) {
  const raw = String(name || "Blackjack").trim();
  const upper = raw.toUpperCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2
      ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
      : upper.slice(0, 2);
  return {
    label: upper.length > 22 ? `${upper.slice(0, 21)}…` : upper,
    initials: initials || "BJ",
    fontSize: upper.length > 18 ? 4.4 : upper.length > 14 ? 5 : upper.length > 10 ? 5.6 : 6.2,
    tracking: upper.length > 16 ? 0.04 : upper.length > 12 ? 0.08 : 0.12,
  };
}

/** Visual stack pieces for a bet (nearest $5). */
function chipsForAmount(amount, max = 6) {
  let left = Math.max(0, Math.round(Number(amount) / 5) * 5);
  const out = [];
  for (const d of CHIP_ORDER) {
    const meta = chipStyle(d);
    while (left >= d && out.length < max) {
      out.push({ ...meta, id: `${d}-${out.length}` });
      left -= d;
    }
  }
  if (!out.length && amount > 0) out.push({ ...chipStyle(5), id: "5-0" });
  return out;
}

let cardSeq = 0;
function nextCardId() {
  cardSeq += 1;
  return `c${cardSeq}`;
}

let handSeq = 0;
function nextHandId() {
  handSeq += 1;
  return `h${handSeq}`;
}

function makeOrderedDeck() {
  const cards = [];
  for (const suit of SUIT_KEYS) {
    for (const rank of RANKS) {
      cards.push({ rank, suit, id: nextCardId() });
    }
  }
  return cards;
}

function fisherYates(list) {
  const cards = list.slice();
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** Interleave two halves like a table riffle. */
function riffleHalves(deck) {
  const mid = Math.floor(deck.length / 2);
  const left = deck.slice(0, mid);
  const right = deck.slice(mid);
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const takeL = Math.min(left.length - i, 1 + Math.floor(Math.random() * 3));
    for (let k = 0; k < takeL; k += 1) merged.push(left[i++]);
    const takeR = Math.min(right.length - j, 1 + Math.floor(Math.random() * 3));
    for (let k = 0; k < takeR; k += 1) merged.push(right[j++]);
  }
  return merged;
}

function makeShoe(decks = DEFAULT_DECKS) {
  const cards = [];
  for (let d = 0; d < decks; d += 1) {
    cards.push(...makeOrderedDeck());
  }
  return fisherYates(cards);
}

/** Build shoe by riffle-shuffling each deck half-and-half, then washing the stack. */
function buildRiffleShoe(decks = DEFAULT_DECKS) {
  const piles = [];
  for (let d = 0; d < decks; d += 1) {
    piles.push(riffleHalves(fisherYates(makeOrderedDeck())));
  }
  return fisherYates(piles.flat());
}

/** Move `fraction` of cards from the deal end to the bottom (player cut). */
function applyPlayerCut(shoe, fraction) {
  const n = shoe.length;
  if (n < 4) return shoe.slice();
  const pct = Math.min(0.85, Math.max(0.15, fraction));
  const take = Math.max(1, Math.min(n - 1, Math.round(n * pct)));
  const moved = shoe.slice(n - take);
  const rest = shoe.slice(0, n - take);
  return [...moved, ...rest];
}

function drawFromShoe(shoe) {
  if (shoe.length === 0) return { card: null, shoe };
  const next = shoe.slice();
  const raw = next.pop();
  return {
    card: {
      ...raw,
      dealKey: `${raw.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      faceDown: false,
    },
    shoe: next,
  };
}

function rankValue(rank) {
  if (rank === "A") return 11;
  if (["K", "Q", "J", "10"].includes(rank)) return 10;
  return Number(rank);
}

/** Best blackjack total + soft flag. */
function evaluateHand(cards, { revealHole = true } = {}) {
  const visible = cards.filter((c) => !c.faceDown || revealHole);
  if (visible.length === 0) {
    return { total: 0, soft: false, bust: false, blackjack: false };
  }
  let total = 0;
  let aces = 0;
  for (const c of visible) {
    total += rankValue(c.rank);
    if (c.rank === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0 && total <= 21;
  const blackjack =
    visible.length === 2 && total === 21 && cards.length === 2 && !cards.some((c) => c.fromSplitHand);
  return { total, soft, bust: total > 21, blackjack };
}

function isPair(cards) {
  if (cards.length !== 2) return false;
  return rankValue(cards[0].rank) === rankValue(cards[1].rank);
}

function canDouble(hand, bank) {
  if (hand.status !== "active") return false;
  if (hand.cards.length !== 2) return false;
  if (hand.splitAces) return false;
  return bank >= hand.bet;
}

function canSplit(hand, bank) {
  if (hand.status !== "active") return false;
  if (hand.fromSplit) return false;
  if (!isPair(hand.cards)) return false;
  return bank >= hand.bet;
}

/** Dealer draws until 17+; optionally hits soft 17. */
function dealerPlayOut(cards, shoe, { hitSoft17 = false } = {}) {
  let nextCards = cards.map((c) => ({ ...c, faceDown: false }));
  let nextShoe = shoe;
  while (true) {
    const ev = evaluateHand(nextCards);
    if (ev.total > 17) break;
    if (ev.total < 17 || (ev.total === 17 && hitSoft17 && ev.soft)) {
      const drawn = drawFromShoe(nextShoe);
      if (!drawn.card) break;
      nextCards = [...nextCards, drawn.card];
      nextShoe = drawn.shoe;
      continue;
    }
    break;
  }
  return { cards: nextCards, shoe: nextShoe };
}

function formatMoney(n) {
  const v = Math.round(n * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Settle one player hand vs dealer.
 * Bets are already deducted at deal/double/split time.
 * - credit: amount returned to bank
 * - profit: round P&L for this hand (win even money = +bet, BJ = +1.5×bet, push = 0, lose = −bet)
 * - outcome: win | loss | push | blackjack (for banner)
 */
function settleHand(hand, dealerEval, { bjPayout = "3:2" } = {}) {
  const bet = hand.bet;
  const bjMult = bjPayout === "6:5" ? 1.2 : 1.5;

  if (hand.status === "bust" || hand.status === "lost") {
    return {
      status: "lost",
      credit: 0,
      profit: -bet,
      outcome: "loss",
    };
  }

  if (hand.status === "blackjack") {
    if (dealerEval.blackjack) {
      return { status: "push", credit: bet, profit: 0, outcome: "push" };
    }
    const profit = bet * bjMult;
    return {
      status: "blackjack",
      credit: bet + profit,
      profit,
      outcome: "blackjack",
    };
  }

  const player = evaluateHand(hand.cards);
  if (player.bust) {
    return {
      status: "lost",
      credit: 0,
      profit: -bet,
      outcome: "loss",
    };
  }
  if (dealerEval.blackjack) {
    return {
      status: "lost",
      credit: 0,
      profit: -bet,
      outcome: "loss",
    };
  }
  if (dealerEval.bust || player.total > dealerEval.total) {
    return {
      status: "won",
      credit: bet * 2,
      profit: bet,
      outcome: "win",
    };
  }
  if (player.total < dealerEval.total) {
    return {
      status: "lost",
      credit: 0,
      profit: -bet,
      outcome: "loss",
    };
  }
  return { status: "push", credit: bet, profit: 0, outcome: "push" };
}

function cardColor(suit) {
  return suit === "H" || suit === "D" ? "red" : "black";
}

function pokerRank(rank) {
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  return Number(rank);
}

/** Perfect Pairs: mixed 6:1, colored 12:1, perfect 25:1 */
function evaluatePerfectPairs(cards) {
  if (!cards || cards.length < 2) return null;
  const [a, b] = cards;
  if (a.rank !== b.rank) return null;
  if (a.suit === b.suit) {
    return { key: "perfect", mult: 25, label: "PERFECT PAIR", short: "PP 25:1" };
  }
  if (cardColor(a.suit) === cardColor(b.suit)) {
    return { key: "colored", mult: 12, label: "COLORED PAIR", short: "PP 12:1" };
  }
  return { key: "mixed", mult: 6, label: "MIXED PAIR", short: "PP 6:1" };
}

/** 21+3 using player first two + dealer upcard. */
function evaluateTwentyOnePlus3(playerCards, dealerUp) {
  if (!playerCards || playerCards.length < 2 || !dealerUp) return null;
  const three = [playerCards[0], playerCards[1], dealerUp];
  const ranks = three.map((c) => pokerRank(c.rank)).sort((a, b) => a - b);
  const suits = three.map((c) => c.suit);
  const flush = suits[0] === suits[1] && suits[1] === suits[2];
  const trips = ranks[0] === ranks[1] && ranks[1] === ranks[2];
  const straightNormal = ranks[0] + 1 === ranks[1] && ranks[1] + 1 === ranks[2];
  const straightWheel = ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14;
  const straight = straightNormal || straightWheel;

  if (flush && trips) {
    return { key: "suitedTrips", mult: 100, label: "SUITED TRIPS", short: "21+3 100:1" };
  }
  if (flush && straight) {
    return { key: "straightFlush", mult: 40, label: "STRAIGHT FLUSH", short: "21+3 40:1" };
  }
  if (trips) {
    return { key: "trips", mult: 30, label: "THREE OF A KIND", short: "21+3 30:1" };
  }
  if (straight) {
    return { key: "straight", mult: 10, label: "STRAIGHT", short: "21+3 10:1" };
  }
  if (flush) {
    return { key: "flush", mult: 5, label: "FLUSH", short: "21+3 5:1" };
  }
  return null;
}

function settleSideBet(bet, result) {
  if (!bet || bet <= 0) {
    return { bet: 0, credit: 0, profit: 0, result: null, outcome: null };
  }
  if (!result) {
    return { bet, credit: 0, profit: -bet, result: null, outcome: "loss" };
  }
  const profit = bet * result.mult;
  return {
    bet,
    credit: bet + profit,
    profit,
    result,
    outcome: "win",
    label: result.label,
    short: result.short,
  };
}

const SIDE_BET_TARGETS = [
  { id: "main", label: "MAIN", hint: "Blackjack bet" },
  { id: "pairs", label: "PAIRS", hint: "6:1 · 12:1 · 25:1" },
  { id: "twentyOnePlus3", label: "21+3", hint: "5:1 → 100:1" },
];

function OutcomeBanner({ outcome, compact = false, text: textOverride = null }) {
  if (!outcome && !textOverride) return null;
  const map = {
    win: { text: "WIN", color: "#E8C547", glow: "rgba(232,197,71,0.55)" },
    blackjack: {
      text: "BLACKJACK",
      color: "#F0D060",
      glow: "rgba(240,208,96,0.65)",
    },
    loss: { text: "LOSS", color: "#E25555", glow: "rgba(226,85,85,0.5)" },
    push: { text: "PUSH", color: "#E8DFC7", glow: "rgba(232,223,199,0.35)" },
    twentyone: {
      text: "21",
      color: "#E8C547",
      glow: "rgba(232,197,71,0.55)",
    },
  };
  const cfg = map[outcome] || map.win;
  const displayText = textOverride || cfg.text;
  const long = displayText.length > 8;

  return (
    <div
      className="bj-outcome-banner"
      style={{
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: compact ? (long ? 13 : 20) : long ? 18 : 28,
        letterSpacing: long ? 1.2 : 4,
        color: cfg.color,
        textShadow: `0 0 14px ${cfg.glow}, 0 2px 4px rgba(0,0,0,0.65)`,
        animation: "outcomeBurst 0.55s cubic-bezier(0.2, 1.2, 0.3, 1) both",
        lineHeight: 1,
        textAlign: "center",
        whiteSpace: "nowrap",
      }}
    >
      {displayText}
    </div>
  );
}

function buildDealSequence(handCount) {
  const steps = [];
  for (let i = 0; i < handCount; i += 1) {
    steps.push({ to: "player", handIndex: i });
  }
  steps.push({ to: "dealer", hole: false });
  for (let i = 0; i < handCount; i += 1) {
    steps.push({ to: "player", handIndex: i });
  }
  steps.push({ to: "dealer", hole: true });
  return steps;
}

function Card({ rank, suit, faceDown = false, dealKey, flipping = false, compact = false }) {
  const suitMeta = SUITS[suit] || SUITS.S;
  const w = compact ? 56 : 72;
  const h = compact ? 78 : 100;
  // Run entrance/flip once, then clear — re-applying cardDeal (opacity 0) on
  // later renders was making the dealer's hole card vanish after the flip.
  const [motion, setMotion] = useState(() => (flipping ? "flip" : "deal"));

  useLayoutEffect(() => {
    if (flipping) setMotion("flip");
  }, [flipping, dealKey]);

  useEffect(() => {
    if (motion === "none") return undefined;
    const t = window.setTimeout(() => setMotion("none"), DEAL_FLIGHT_MS + 40);
    return () => window.clearTimeout(t);
  }, [motion]);

  const face = faceDown ? (
    <div className="bj-card-face bj-card-back">
      <div className="bj-card-back-pattern" aria-hidden />
      <div className="bj-card-back-inner">
        <div className="bj-card-back-motif" />
      </div>
    </div>
  ) : (
    <div className="bj-card-face bj-card-front" style={{ color: suitMeta.color }}>
      <div className="bj-card-front-sheen" aria-hidden />
      <div className="bj-card-corner bj-card-corner-tl">
        <div className="bj-card-rank">{rank}</div>
        <div className="bj-card-suit">{suitMeta.symbol}</div>
      </div>
      <div className="bj-card-center">{suitMeta.symbol}</div>
      <div className="bj-card-corner bj-card-corner-br">
        <div className="bj-card-rank">{rank}</div>
        <div className="bj-card-suit">{suitMeta.symbol}</div>
      </div>
    </div>
  );

  const animation =
    motion === "flip"
      ? `cardFlip ${DEAL_FLIGHT_MS}ms ease-out forwards`
      : motion === "deal"
        ? `cardDeal ${DEAL_FLIGHT_MS}ms cubic-bezier(0.16, 0.84, 0.28, 1) forwards`
        : "none";

  return (
    <div
      className={`bj-card${compact ? " is-compact" : ""}`}
      aria-label={faceDown ? "Face-down card" : `${rank} of ${suitMeta.symbol}`}
      style={{
        width: w,
        height: h,
        flexShrink: 0,
        transformStyle: "preserve-3d",
        animation,
      }}
    >
      {face}
    </div>
  );
}

/** Realistic acrylic dealing shoe — card-back stack + exit lip. */
function DealerShoe({ remaining, total = DEFAULT_DECKS * 52, shuffling = false }) {
  const pct = Math.max(0, Math.min(1, remaining / total));
  const layers = Math.max(1, Math.min(12, Math.round(1 + pct * 11)));
  const deckDepth = Math.max(6, Math.round(8 + pct * 34));

  return (
    <div
      className={`bj-shoe${shuffling ? " bj-shoe-shuffle" : ""}`}
      aria-label={`Card shoe, ${remaining} cards remaining`}
      title={`${remaining} / ${total}`}
    >
      <div className="bj-shoe-shell">
        <div className="bj-shoe-glass" aria-hidden />
        <div className="bj-shoe-rail" aria-hidden />
        <div className="bj-shoe-bed">
          <div className="bj-shoe-deck" style={{ height: deckDepth }}>
            {Array.from({ length: layers }, (_, i) => (
              <div
                key={i}
                className="bj-shoe-card"
                style={{
                  bottom: i * 2.4,
                  zIndex: i + 1,
                  animationDelay: shuffling ? `${i * 40}ms` : undefined,
                }}
              >
                <div className="bj-shoe-card-face">
                  <div className="bj-shoe-card-motif" />
                </div>
              </div>
            ))}
          </div>
          {remaining > 0 && (
            <div className="bj-shoe-next">
              <div className="bj-shoe-card-face">
                <div className="bj-shoe-card-motif" />
              </div>
            </div>
          )}
          {shuffling && (
            <div className="bj-shoe-riffle" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <div
                  key={i}
                  className="bj-shoe-riffle-card"
                  style={{
                    "--riffle-x": `${(i - 2) * 16}px`,
                    "--riffle-r": `${(i - 2) * 14}deg`,
                    animationDelay: `${i * 70}ms`,
                  }}
                >
                  <div className="bj-shoe-card-face">
                    <div className="bj-shoe-card-motif" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bj-shoe-lip" aria-hidden />
        <div className="bj-shoe-badge">
          <span>{shuffling ? "···" : remaining}</span>
        </div>
      </div>
    </div>
  );
}

/** Ornate ceramic chip — scalloped rim, gold ring, casino name on both arcs. */
function ChipFace({
  value,
  band,
  mark,
  markAlt,
  center,
  ink,
  face,
  spot,
  rim,
  size,
  casinoName = "Blackjack",
}) {
  const uid = useId().replace(/:/g, "");
  const goldId = `chip-gold-${uid}`;
  const glitterId = `chip-glitter-${uid}`;
  const topPath = `chip-top-${uid}`;
  const botPath = `chip-bot-${uid}`;
  const rimBand = band || face || "#A8D0E8";
  const markA = mark || spot || "#2E6F9A";
  const markB = markAlt || rim || "#7EB6D4";
  const faceCenter = center || "#FFFEF9";
  const textInk = ink || "#141414";
  const brand = chipBrand(casinoName);
  const valueText = `$${value}`;
  const valueSize = value >= 100 ? 20 : value >= 25 ? 22 : 24;
  const chipFont = "'Bebas Neue', sans-serif";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden
      style={{ display: "block", width: "100%", height: "100%" }}
    >
      <defs>
        <linearGradient id={goldId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F8ECC0" />
          <stop offset="25%" stopColor="#E0B84A" />
          <stop offset="50%" stopColor="#C9A227" />
          <stop offset="75%" stopColor="#F0D978" />
          <stop offset="100%" stopColor="#A67C1A" />
        </linearGradient>
        <filter id={glitterId} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="1.1"
            numOctaves="3"
            stitchTiles="stitch"
            result="noise"
          />
          <feColorMatrix
            in="noise"
            type="matrix"
            values="0 0 0 0 0.85
                    0 0 0 0 0.68
                    0 0 0 0 0.25
                    0 0 0 0.55 0"
            result="goldNoise"
          />
          <feComposite in="goldNoise" in2="SourceGraphic" operator="in" result="clipped" />
          <feBlend in="SourceGraphic" in2="clipped" mode="screen" />
        </filter>
        <path id={topPath} d="M 22,57 A 28.5,28.5 0 0,1 78,57" fill="none" />
        <path id={botPath} d="M 78,57 A 28.5,28.5 0 0,1 22,57" fill="none" />
      </defs>

      {/* Base ceramic disc */}
      <circle cx="50" cy="50" r="49" fill="#FFFEF9" />
      <circle cx="50" cy="50" r="49" fill="none" stroke="#E4DCC8" strokeWidth="0.6" />

      {/* Colored outer band */}
      <circle
        cx="50"
        cy="50"
        r="44.5"
        fill="none"
        stroke={rimBand}
        strokeWidth="9.5"
      />

      {/* White scallops biting into the band */}
      {Array.from({ length: 8 }, (_, i) => {
        const deg = i * 45;
        const rad = ((deg - 90) * Math.PI) / 180;
        const x = 50 + Math.cos(rad) * 39.2;
        const y = 50 + Math.sin(rad) * 39.2;
        return <circle key={`sc-${deg}`} cx={x} cy={y} r="5.2" fill={faceCenter} />;
      })}

      {/* Alternating rim icons: teardrop + crown tab */}
      {Array.from({ length: 8 }, (_, i) => {
        const deg = i * 45 + 22.5;
        const isCrown = i % 2 === 1;
        return (
          <g key={`ic-${deg}`} transform={`rotate(${deg} 50 50)`}>
            {isCrown ? (
              <g transform="translate(50, 8.5)">
                <rect x="-4.2" y="-1.2" width="8.4" height="6.2" rx="1.2" fill={faceCenter} />
                <path
                  d="M -2.8 3.2 L -2.8 0.4 L -1.2 -1.2 L 0 0.2 L 1.2 -1.2 L 2.8 0.4 L 2.8 3.2 Z"
                  fill={markB}
                />
              </g>
            ) : (
              <ellipse
                cx="50"
                cy="9.2"
                rx="2.4"
                ry="3.3"
                fill={markA}
              />
            )}
          </g>
        );
      })}

      {/* Inner white field under gold ring */}
      <circle cx="50" cy="50" r="33.5" fill={faceCenter} />

      {/* Metallic glitter gold ring */}
      <circle
        cx="50"
        cy="50"
        r="33.2"
        fill="none"
        stroke={`url(#${goldId})`}
        strokeWidth="3.4"
        filter={`url(#${glitterId})`}
      />
      <circle
        cx="50"
        cy="50"
        r="31.2"
        fill="none"
        stroke="#F6E7B0"
        strokeWidth="0.55"
        opacity="0.85"
      />

      {/* Faint watermark initials */}
      <text
        x="50"
        y="52"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#D9D2C4"
        fontFamily={chipFont}
        fontSize="26"
        opacity="0.5"
        letterSpacing="1"
        style={{ userSelect: "none" }}
      >
        {brand.initials}
      </text>

      {/* Casino name — top + bottom arcs */}
      <text
        fill={textInk}
        fontFamily={chipFont}
        fontSize={brand.fontSize}
        letterSpacing={`${brand.tracking}em`}
        style={{ userSelect: "none" }}
      >
        <textPath href={`#${topPath}`} startOffset="50%" textAnchor="middle">
          {brand.label}
        </textPath>
      </text>
      <text
        fill={textInk}
        fontFamily={chipFont}
        fontSize={brand.fontSize}
        letterSpacing={`${brand.tracking}em`}
        style={{ userSelect: "none" }}
      >
        <textPath href={`#${botPath}`} startOffset="50%" textAnchor="middle">
          {brand.label}
        </textPath>
      </text>

      {/* Denomination */}
      <text
        x="50"
        y="51"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={textInk}
        fontFamily={chipFont}
        fontSize={valueSize}
        letterSpacing="0.5"
        style={{ userSelect: "none" }}
      >
        {valueText}
      </text>
    </svg>
  );
}

function FeltChip({
  value,
  band,
  mark,
  markAlt,
  center,
  ink,
  face,
  spot,
  rim,
  edge,
  size = 52,
  offset = 0,
  casinoName = "Blackjack",
}) {
  // Light stack depth: show a bit more rim, soft shadow, tiny scale toward camera
  const overlap = offset ? -Math.round(size * 0.68) : 0;
  const lift = offset * 1.15;
  const scale = 1 + offset * 0.014;
  const shadowY = 2.5 + offset * 0.9;
  const shadowBlur = 5 + offset * 0.7;
  const shadowAlpha = 0.32 + offset * 0.05;

  return (
    <div
      aria-hidden
      className="bj-felt-chip"
      style={{
        position: "relative",
        width: size,
        height: size,
        marginTop: overlap,
        borderRadius: "50%",
        flexShrink: 0,
        transform: `translateY(${-lift}px) scale(${scale})`,
        transformOrigin: "50% 85%",
        filter: `drop-shadow(0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,${shadowAlpha}))`,
        zIndex: offset + 1,
      }}
    >
      <ChipFace
        value={value}
        band={band}
        mark={mark}
        markAlt={markAlt}
        center={center}
        ink={ink}
        face={face}
        spot={spot}
        rim={rim}
        edge={edge}
        size={size}
        casinoName={casinoName}
      />
    </div>
  );
}

/** Bet stack on the felt. fly: idle | to-dealer | to-player | from-dealer */
function BetChipStack({
  amount,
  fly = "idle",
  size = 52,
  delay = 0,
  casinoName = "Blackjack",
}) {
  const chips = chipsForAmount(amount, 5);
  if (!chips.length) return null;
  const anim =
    fly === "to-dealer"
      ? "chipFlyDealer"
      : fly === "to-player"
        ? "chipFlyPlayer"
        : fly === "from-dealer"
          ? "chipFlyFromDealer"
          : undefined;

  return (
    <div
      className={`bj-bet-stack${fly === "idle" ? " is-idle" : ""}`}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column-reverse",
        alignItems: "center",
        width: size + 8,
        overflow: "visible",
        filter: "none",
        animation: anim
          ? `${anim} ${CHIP_FLY_MS}ms cubic-bezier(0.22, 0.75, 0.3, 1) both`
          : undefined,
        animationDelay: anim ? `${delay}ms` : undefined,
      }}
      title={`$${formatMoney(amount)}`}
    >
      <div
        className="bj-bet-stack-shadow"
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          bottom: Math.max(2, Math.round(size * 0.04)),
          width: Math.round(size * 0.74),
          height: Math.round(size * 0.16),
          transform: "translateX(-50%)",
          borderRadius: "50%",
          background: "rgba(0,0,0,0.38)",
          filter: "blur(4px)",
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
      {chips.map((c, i) => (
        <FeltChip
          key={c.id}
          value={c.value}
          band={c.band}
          mark={c.mark}
          markAlt={c.markAlt}
          center={c.center}
          face={c.face}
          rim={c.rim}
          ink={c.ink}
          edge={c.edge}
          spot={c.spot}
          size={size}
          offset={i}
          casinoName={casinoName}
        />
      ))}
    </div>
  );
}

function FeltHand({
  label,
  cards,
  totalLabel,
  bet = 0,
  sideBets = null,
  sideResults = null,
  sideChipFly = "idle",
  active = false,
  waiting = false,
  status = "active",
  outcome = null,
  payoutAmount = 0,
  chipFly = "idle",
  flash = null,
  compact = false,
  ghost = false,
  role = "player",
  casinoName = "Blackjack",
}) {
  // Display cards as stored — hole stays face-down until finishRoundToDealer
  // flips it. Forcing face-up via revealHole made the flip remount start blank.
  const shown = cards;
  const isDealer = role === "dealer";
  const isWin = status === "won" || status === "blackjack";
  const chipsCleared = chipFly === "done";
  const showPayStack =
    !chipsCleared &&
    payoutAmount > 0 &&
    isWin &&
    (chipFly === "from-dealer" || chipFly === "to-player");
  const betFly =
    chipFly === "to-dealer" || chipFly === "to-player" ? chipFly : "idle";
  const payFly =
    chipFly === "from-dealer"
      ? "from-dealer"
      : chipFly === "to-player"
        ? "to-player"
        : "idle";
  const flyingAway = chipFly === "to-dealer" || chipFly === "to-player";
  const pairsBet = sideBets?.pairs || 0;
  const plus3Bet = sideBets?.twentyOnePlus3 || 0;
  const sideCleared = sideChipFly === "done";
  const showSideStacks = !sideCleared && (pairsBet > 0 || plus3Bet > 0);
  const bothSideWins =
    sideResults?.pairs?.outcome === "win" &&
    sideResults?.twentyOnePlus3?.outcome === "win";
  const sideBannerText =
    !sideCleared && sideChipFly !== "idle"
      ? bothSideWins
        ? "SIDE BETS!"
        : sideResults?.pairs?.outcome === "win"
          ? sideResults.pairs.short
          : sideResults?.twentyOnePlus3?.outcome === "win"
            ? sideResults.twentyOnePlus3.short
            : null
      : null;

  const sideFlyFor = (outcome) => {
    if (!outcome || sideChipFly === "idle" || sideChipFly === "done") return "idle";
    if (outcome === "win") {
      if (sideChipFly === "pay") return "from-dealer";
      if (sideChipFly === "collect") return "to-player";
      return "idle";
    }
    if (outcome === "loss") {
      if (sideChipFly === "collect" || sideChipFly === "pay") return "to-dealer";
      return "idle";
    }
    return "idle";
  };

  const pairsFly = sideFlyFor(sideResults?.pairs?.outcome);
  const plus3Fly = sideFlyFor(sideResults?.twentyOnePlus3?.outcome);
  const pairsPayAmt =
    sideResults?.pairs?.outcome === "win"
      ? Math.max(0, (sideResults.pairs.credit || 0) - pairsBet)
      : 0;
  const plus3PayAmt =
    sideResults?.twentyOnePlus3?.outcome === "win"
      ? Math.max(0, (sideResults.twentyOnePlus3.credit || 0) - plus3Bet)
      : 0;

  const total = (
    <div
      className={`bj-hand-total${active ? " is-active" : ""}`}
      style={{ opacity: ghost && !cards.length ? 0.45 : 1 }}
    >
      <span className="bj-hand-label">{label}</span>
      <span className="bj-hand-score">{totalLabel}</span>
      {active ? <span className="bj-hand-turn">TURN</span> : null}
    </div>
  );

  const cardRow = (
    <div
      className="bj-cards"
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-end",
        minHeight: compact ? 64 : 92,
        height: compact ? 64 : 92,
        boxSizing: "border-box",
      }}
    >
      {shown.map((c, i) => (
        <div
          key={c.dealKey || `${c.rank}-${c.suit}-${i}`}
          style={{
            marginLeft: i === 0 ? 0 : compact ? -20 : -28,
            zIndex: i + 1,
            position: "relative",
          }}
        >
          <Card
            dealKey={c.dealKey || `${c.rank}-${c.suit}-${i}`}
            rank={c.rank}
            suit={c.suit}
            faceDown={c.faceDown}
            flipping={c.flipping}
            compact={compact}
          />
        </div>
      ))}
    </div>
  );

  const chipPlaceholder = (
    <div
      className="bj-chip-spot bj-chip-spot-ph"
      aria-hidden
      style={{
        width: compact ? 78 : 92,
        minWidth: compact ? 78 : 92,
        minHeight: compact ? 100 : 128,
        visibility: "hidden",
        pointerEvents: "none",
        flexShrink: 0,
      }}
    />
  );

  const chipSpot =
    (bet > 0 || showSideStacks) && !chipsCleared ? (
      <div
        className={`bj-chip-spot${active ? " is-active" : ""}${flyingAway ? " is-clearing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
          width: compact ? (showSideStacks ? 110 : 78) : showSideStacks ? 130 : 92,
          minWidth: compact ? (showSideStacks ? 110 : 78) : showSideStacks ? 130 : 92,
          minHeight: compact ? 100 : 128,
          padding: 0,
          boxSizing: "border-box",
          overflow: "visible",
          position: "relative",
          transition: "opacity 0.35s ease",
          opacity: flyingAway ? 0.35 : 1,
          flexShrink: 0,
        }}
      >
        <div
          className="bj-chip-spot-stack"
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            gap: compact ? 4 : 6,
            minHeight: compact ? 84 : 108,
            position: "relative",
            zIndex: 1,
            overflow: "visible",
          }}
        >
          {showSideStacks && pairsBet > 0 && (
            <div className="bj-side-stack" title={`Pairs $${formatMoney(pairsBet)}`}>
              {pairsPayAmt > 0 &&
                (sideChipFly === "pay" || sideChipFly === "collect") && (
                  <BetChipStack
                    key={`pp-pay-${sideChipFly}`}
                    amount={pairsPayAmt}
                    fly={pairsFly === "from-dealer" ? "from-dealer" : pairsFly}
                    size={compact ? 34 : 40}
                    casinoName={casinoName}
                  />
                )}
              <BetChipStack
                key={`pp-${pairsFly}-${sideChipFly}`}
                amount={pairsBet}
                fly={pairsFly === "from-dealer" ? "idle" : pairsFly}
                size={compact ? 34 : 40}
                casinoName={casinoName}
              />
              <div className="bj-side-tag">PP</div>
            </div>
          )}
          {bet > 0 && (
            <BetChipStack
              key={`bet-${betFly}-${chipFly}`}
              amount={bet}
              fly={betFly}
              size={compact ? 64 : 78}
              casinoName={casinoName}
            />
          )}
          {showPayStack && (
            <BetChipStack
              key={`pay-${payFly}-${chipFly}`}
              amount={payoutAmount}
              fly={payFly}
              size={compact ? 64 : 78}
              delay={40}
              casinoName={casinoName}
            />
          )}
          {showSideStacks && plus3Bet > 0 && (
            <div className="bj-side-stack" title={`21+3 $${formatMoney(plus3Bet)}`}>
              {plus3PayAmt > 0 &&
                (sideChipFly === "pay" || sideChipFly === "collect") && (
                  <BetChipStack
                    key={`p3-pay-${sideChipFly}`}
                    amount={plus3PayAmt}
                    fly={plus3Fly === "from-dealer" ? "from-dealer" : plus3Fly}
                    size={compact ? 34 : 40}
                    casinoName={casinoName}
                  />
                )}
              <BetChipStack
                key={`p3-${plus3Fly}-${sideChipFly}`}
                amount={plus3Bet}
                fly={plus3Fly === "from-dealer" ? "idle" : plus3Fly}
                size={compact ? 34 : 40}
                casinoName={casinoName}
              />
              <div className="bj-side-tag">21+3</div>
            </div>
          )}
        </div>
        {!flyingAway && (
          <div className="bj-bet-amount" style={{ position: "relative", zIndex: 1 }}>
            ${formatMoney(bet + (showSideStacks ? pairsBet + plus3Bet : 0))}
          </div>
        )}
      </div>
    ) : isDealer ? null : (
      chipPlaceholder
    );

  const payoutTag =
    flash || sideBannerText || (outcome && chipFly === "done") ? (
      <OutcomeBanner
        outcome={flash || (sideBannerText ? "win" : outcome)}
        text={
          flash
            ? null
            : sideBannerText && !(outcome && chipFly === "done")
              ? sideBannerText
              : null
        }
        compact={compact}
      />
    ) : (
      <div className="bj-outcome-ph" aria-hidden />
    );

  return (
    <div
      className={[
        "bj-hand",
        `bj-hand-${role}`,
        active ? "is-active" : "",
        waiting ? "is-waiting" : "",
        ghost ? "is-ghost" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-current={active ? "true" : undefined}
    >
      {active ? <div className="bj-hand-active-glow" aria-hidden /> : null}
      {isDealer ? (
        <>
          {total}
          {cardRow}
        </>
      ) : (
        <>
          {chipSpot}
          {cardRow}
          {total}
          {payoutTag}
        </>
      )}
    </div>
  );
}


function Chip({
  value,
  band,
  mark,
  markAlt,
  center,
  ink,
  face,
  rim,
  edge,
  spot,
  selected,
  onClick,
  disabled,
  size = 56,
  casinoName = "Blackjack",
}) {
  const ringPad = 7;
  return (
    <button
      type="button"
      className={`bj-select-chip${selected ? " is-selected" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={`$${value} chip`}
      aria-pressed={selected}
      style={{
        position: "relative",
        width: size + ringPad * 2,
        height: size + ringPad * 2,
        padding: ringPad,
        boxSizing: "border-box",
        borderRadius: "50%",
        border: "none",
        background: "transparent",
        cursor: disabled ? "default" : "pointer",
        transform: selected ? "scale(1.05)" : "none",
        transition: "transform 0.15s, filter 0.15s",
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
        overflow: "visible",
        filter: selected
          ? "drop-shadow(0 5px 10px rgba(0,0,0,0.5))"
          : "drop-shadow(0 4px 8px rgba(0,0,0,0.45))",
      }}
    >
      {selected ? (
        <span className="bj-select-chip-ring" aria-hidden />
      ) : null}
      <span
        className="bj-select-chip-face"
        style={{
          display: "block",
          width: size,
          height: size,
          position: "relative",
          borderRadius: "50%",
        }}
      >
        <ChipFace
          value={value}
          band={band}
          mark={mark}
          markAlt={markAlt}
          center={center}
          ink={ink}
          face={face}
          rim={rim}
          edge={edge}
          spot={spot}
          size={size}
          casinoName={casinoName}
        />
      </span>
    </button>
  );
}

function ActionButton({
  label,
  onClick,
  primary = false,
  disabled = false,
  wide = false,
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: wide ? "1 1 100%" : "1 1 0",
        minWidth: wide ? "100%" : 0,
        padding: "12px 0",
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: primary ? 20 : 16,
        letterSpacing: 2,
        color: primary || !disabled ? "#1A1A1A" : "rgba(26,26,26,0.45)",
        background: disabled
          ? "#6E8C7B"
          : primary
            ? FELT.gold
            : "#E8DFC7",
        border: "none",
        borderRadius: 10,
        cursor: disabled ? "default" : "pointer",
        boxShadow: disabled
          ? "none"
          : `0 4px 0 ${primary ? "#8A6E1B" : "#A89870"}`,
        transform: disabled ? "translateY(4px)" : "translateY(0)",
        transition: "all 0.15s",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {label}
    </button>
  );
}

function CasinoSelectScreen({
  selected,
  onSelect,
  onEnter,
  query,
  onQuery,
  onClose,
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CASINOS;
    return CASINOS.filter(
      (c) =>
        c.state.toLowerCase().includes(q) ||
        c.abbr.toLowerCase().includes(q) ||
        c.city.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
    );
  }, [query]);

  return (
    <div className="bj-casino-overlay" role="dialog" aria-modal="true" aria-label="Switch casino">
      <style>{`
        .bj-casino-overlay {
          position: fixed;
          inset: 0;
          z-index: 80;
          background: rgba(4, 16, 12, 0.72);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 16px 12px;
          overflow-y: auto;
          font-family: 'Inter', sans-serif;
        }
        .bj-casino-shell {
          width: min(560px, 100%);
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: calc(100dvh - 32px);
          margin: auto;
        }
        .bj-casino-panel {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 16px;
          border-radius: 18px;
          border: 1.5px solid rgba(232,223,199,0.28);
          background: radial-gradient(ellipse at 50% 0%, #0B4530 0%, #073024 55%, #052018 100%);
          box-shadow: 0 20px 50px rgba(0,0,0,0.5);
          max-height: calc(100dvh - 32px);
        }
        .bj-casino-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .bj-casino-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(26px, 7vw, 36px);
          letter-spacing: 0.14em;
          color: #F0E6D2;
          text-shadow: 0 2px 4px rgba(0,0,0,0.4);
        }
        .bj-casino-sub {
          color: rgba(232,223,199,0.65);
          font-size: 13px;
          margin-top: 2px;
        }
        .bj-casino-close {
          border: 1px solid rgba(232,223,199,0.35);
          background: transparent;
          color: rgba(232,223,199,0.75);
          border-radius: 999px;
          width: 36px;
          height: 36px;
          font-size: 18px;
          cursor: pointer;
          flex-shrink: 0;
          line-height: 1;
        }
        .bj-casino-search {
          width: 100%;
          padding: 12px 14px;
          border-radius: 12px;
          border: 1.5px solid rgba(232,223,199,0.35);
          background: rgba(5,32,24,0.72);
          color: #F0E6D2;
          font-size: 15px;
          outline: none;
        }
        .bj-casino-search:focus { border-color: #C9A227; }
        .bj-casino-search::placeholder { color: rgba(232,223,199,0.4); }
        .bj-casino-list {
          flex: 1;
          min-height: 180px;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          border-radius: 14px;
          border: 1.5px solid rgba(232,223,199,0.28);
          background: rgba(5,32,24,0.55);
          display: flex;
          flex-direction: column;
        }
        .bj-casino-row {
          display: grid;
          grid-template-columns: 52px 1fr;
          gap: 10px;
          align-items: center;
          padding: 12px 14px;
          border: none;
          border-bottom: 1px solid rgba(232,223,199,0.12);
          background: transparent;
          color: #E8DFC7;
          text-align: left;
          cursor: pointer;
          font: inherit;
        }
        .bj-casino-row:last-child { border-bottom: none; }
        .bj-casino-row:hover { background: rgba(201,162,39,0.08); }
        .bj-casino-row.is-selected {
          background: rgba(201,162,39,0.16);
          box-shadow: inset 3px 0 0 #C9A227;
        }
        .bj-casino-abbr {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          letter-spacing: 0.06em;
          color: #C9A227;
          text-align: center;
        }
        .bj-casino-name {
          font-weight: 600;
          font-size: 14px;
          color: #F0E6D2;
        }
        .bj-casino-meta {
          font-size: 12px;
          color: rgba(232,223,199,0.55);
          margin-top: 2px;
        }
        .bj-casino-empty {
          padding: 28px 16px;
          text-align: center;
          color: rgba(232,223,199,0.5);
          font-size: 14px;
        }
        .bj-casino-enter {
          width: 100%;
          padding: 14px 16px;
          border-radius: 12px;
          border: 1.5px solid #C9A227;
          background: linear-gradient(180deg, #C9A227 0%, #A8861A 100%);
          color: #1A1205;
          font-family: 'Bebas Neue', sans-serif;
          font-size: 20px;
          letter-spacing: 0.12em;
          cursor: pointer;
        }
        .bj-casino-enter:disabled { opacity: 0.4; cursor: default; }
      `}</style>

      <div className="bj-casino-shell">
        <div className="bj-casino-panel">
          <div className="bj-casino-head">
            <div>
              <div className="bj-casino-title">SWITCH CASINO</div>
              <div className="bj-casino-sub">50 states · pick a city floor</div>
            </div>
            {onClose ? (
              <button
                type="button"
                className="bj-casino-close"
                onClick={onClose}
                aria-label="Close"
              >
                ×
              </button>
            ) : null}
          </div>

          <input
            className="bj-casino-search"
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search state, city, or casino…"
            aria-label="Search casinos"
            autoFocus
          />

          <div className="bj-casino-list" role="listbox" aria-label="Casinos by state">
            {filtered.length === 0 ? (
              <div className="bj-casino-empty">No casinos match that search</div>
            ) : (
              filtered.map((c) => {
                const isSelected = selected?.abbr === c.abbr;
                return (
                  <button
                    key={c.abbr}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`bj-casino-row${isSelected ? " is-selected" : ""}`}
                    onClick={() => onSelect(c)}
                    onDoubleClick={() => {
                      onSelect(c);
                      onEnter(c);
                    }}
                  >
                    <div className="bj-casino-abbr">{c.abbr}</div>
                    <div>
                      <div className="bj-casino-name">{c.name}</div>
                      <div className="bj-casino-meta">
                        {c.city}, {c.state} · min ${c.minBet}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <button
            type="button"
            className="bj-casino-enter"
            disabled={!selected}
            onClick={() => selected && onEnter(selected)}
          >
            {selected ? `PLAY AT ${selected.name.toUpperCase()}` : "SELECT A CASINO"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({
  open,
  onClose,
  bjPayout,
  onBjPayout,
  hitSoft17,
  onHitSoft17,
  deckCount,
  onDeckCount,
  playerCut,
  onPlayerCut,
  autoDeal,
  onAutoDeal,
  sideBetsEnabled,
  onSideBetsEnabled,
  canEdit,
  onRestart,
  onEndSession,
  canEndSession,
}) {
  if (!open) return null;
  return (
    <div className="bj-settings-overlay" role="dialog" aria-modal="true" aria-label="Table settings">
      <div className="bj-settings-panel">
        <div className="bj-settings-head">
          <div>
            <div className="bj-settings-title">TABLE RULES</div>
            <div className="bj-settings-sub">
              {canEdit ? "Changes apply to the next deal" : "Finish the hand to edit rules"}
            </div>
          </div>
          <button type="button" className="bj-settings-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={`bj-settings-section${canEdit ? "" : " is-locked"}`}>
          <div className="bj-settings-label">Blackjack pays</div>
          <div className="bj-settings-seg">
            {["3:2", "6:5"].map((opt) => (
              <button
                key={opt}
                type="button"
                className={`bj-settings-seg-btn${bjPayout === opt ? " is-on" : ""}`}
                disabled={!canEdit}
                onClick={() => onBjPayout(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        <div className={`bj-settings-section${canEdit ? "" : " is-locked"}`}>
          <div className="bj-settings-label">Dealer on soft 17</div>
          <div className="bj-settings-seg">
            <button
              type="button"
              className={`bj-settings-seg-btn${!hitSoft17 ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => onHitSoft17(false)}
            >
              STAND
            </button>
            <button
              type="button"
              className={`bj-settings-seg-btn${hitSoft17 ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => onHitSoft17(true)}
            >
              HIT
            </button>
          </div>
        </div>

        <div className={`bj-settings-section${canEdit ? "" : " is-locked"}`}>
          <div className="bj-settings-label">Decks in shoe</div>
          <div className="bj-settings-seg bj-settings-decks">
            {DECK_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`bj-settings-seg-btn${deckCount === n ? " is-on" : ""}`}
                disabled={!canEdit}
                onClick={() => onDeckCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="bj-settings-hint">
            Prefer 1–2 decks for short auto-deal sessions — the cut card ends the
            shoe and opens analytics.
          </div>
        </div>

        <div className={`bj-settings-section${canEdit ? "" : " is-locked"}`}>
          <div className="bj-settings-label">Player cut</div>
          <div className="bj-settings-seg">
            <button
              type="button"
              className={`bj-settings-seg-btn${playerCut ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => onPlayerCut(true)}
            >
              ON
            </button>
            <button
              type="button"
              className={`bj-settings-seg-btn${!playerCut ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => onPlayerCut(false)}
            >
              OFF
            </button>
          </div>
          <div className="bj-settings-hint">
            On by default — before every new shoe you tap a spot in the deck to
            place the cut card (no slider, no card count).
          </div>
        </div>

        <div className="bj-settings-section">
          <div className="bj-settings-label">Auto-deal</div>
          <div className="bj-settings-seg">
            <button
              type="button"
              className={`bj-settings-seg-btn${!autoDeal ? " is-on" : ""}`}
              onClick={() => onAutoDeal(false)}
            >
              OFF
            </button>
            <button
              type="button"
              className={`bj-settings-seg-btn${autoDeal ? " is-on" : ""}`}
              onClick={() => onAutoDeal(true)}
            >
              ON
            </button>
          </div>
          <div className="bj-settings-hint">
            After each settle, deals the next round with your current bet. You
            still play the hand. Session ends at the cut card or when the bank
            can’t cover the bet — then analytics open.
          </div>
        </div>

        <div className={`bj-settings-section${canEdit ? "" : " is-locked"}`}>
          <div className="bj-settings-label">Side bets</div>
          <div className="bj-settings-seg">
            <button
              type="button"
              className={`bj-settings-seg-btn${!sideBetsEnabled ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => onSideBetsEnabled(false)}
            >
              OFF
            </button>
            <button
              type="button"
              className={`bj-settings-seg-btn${sideBetsEnabled ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => onSideBetsEnabled(true)}
            >
              ON
            </button>
          </div>
          <div className="bj-settings-hint">
            Optional Perfect Pairs and 21+3. When on, choose MAIN / PAIRS / 21+3
            before tapping chips.
          </div>
        </div>

        {canEndSession ? (
          <button
            type="button"
            className="bj-settings-restart"
            style={{ borderColor: "rgba(232,223,199,0.45)", background: "transparent", color: "#F0E6D2" }}
            onClick={onEndSession}
          >
            END SESSION · VIEW ANALYTICS
          </button>
        ) : null}

        <button
          type="button"
          className="bj-settings-restart"
          disabled={!canEdit}
          onClick={onRestart}
        >
          RESTART GAME
        </button>
        <div className="bj-settings-hint">
          Resets the bank, reshuffles every deck half-and-half, loads the shoe,
          then asks you to cut when Player cut is on.
        </div>
      </div>
    </div>
  );
}

function AnalyticsOverlay({
  open,
  stats,
  meta,
  onClose,
  onNewSession,
}) {
  if (!open || !stats) return null;
  const decided = Math.max(1, stats.wins + stats.losses);
  const winRate = Math.round((stats.wins / decided) * 100);
  const duration = formatDuration(
    (stats.endedAt || Date.now()) - (stats.startedAt || Date.now())
  );
  const net = stats.netProfit;
  const netColor = net > 0 ? "#7ED4A0" : net < 0 ? "#E39AA1" : "#E8DFC7";
  const rows = [
    { label: "Rounds", value: String(stats.rounds) },
    { label: "Hands", value: String(stats.hands) },
    { label: "Wins", value: String(stats.wins) },
    { label: "Losses", value: String(stats.losses) },
    { label: "Pushes", value: String(stats.pushes) },
    { label: "Blackjacks", value: String(stats.blackjacks) },
    { label: "Busts", value: String(stats.busts) },
    { label: "Win rate", value: `${winRate}%` },
    {
      label: "Wagered",
      value: `$${Math.round(stats.totalWagered).toLocaleString()}`,
    },
    {
      label: "Peak bank",
      value: `$${Math.round(stats.peakBank).toLocaleString()}`,
    },
    {
      label: "Low bank",
      value: `$${Math.round(stats.lowBank).toLocaleString()}`,
    },
    { label: "Duration", value: duration },
  ];

  return (
    <div className="bj-settings-overlay" role="dialog" aria-modal="true" aria-label="Session analytics">
      <div className="bj-settings-panel bj-analytics-panel">
        <div className="bj-settings-head">
          <div>
            <div className="bj-settings-title">SESSION ANALYTICS</div>
            <div className="bj-settings-sub">{endReasonLabel(stats.endReason)}</div>
          </div>
          <button type="button" className="bj-settings-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {meta ? (
          <div className="bj-analytics-meta">
            {meta.casino}
            {" · "}
            {meta.decks}-deck · BJ {meta.bjPayout} · {meta.hitSoft17 ? "H17" : "S17"}
          </div>
        ) : null}

        <div className="bj-analytics-hero">
          <div className="bj-analytics-hero-label">NET RESULT</div>
          <div className="bj-analytics-hero-value" style={{ color: netColor }}>
            {net > 0 ? "+" : net < 0 ? "−" : ""}
            ${Math.abs(Math.round(net)).toLocaleString()}
          </div>
          <div className="bj-analytics-hero-bank">
            ${Math.round(stats.startBank).toLocaleString()}
            {" → "}
            ${Math.round(stats.endBank).toLocaleString()}
          </div>
        </div>

        <div className="bj-analytics-grid">
          {rows.map((r) => (
            <div key={r.label} className="bj-analytics-cell">
              <div className="bj-analytics-cell-label">{r.label}</div>
              <div className="bj-analytics-cell-value">{r.value}</div>
            </div>
          ))}
        </div>

        <button type="button" className="bj-settings-restart" onClick={onNewSession}>
          NEW SHOE · PLAY AGAIN
        </button>
        <button
          type="button"
          className="bj-settings-restart"
          style={{
            borderColor: "rgba(232,223,199,0.35)",
            background: "transparent",
            color: "#F0E6D2",
            marginTop: -4,
          }}
          onClick={onClose}
        >
          CLOSE
        </button>
      </div>
    </div>
  );
}

/** Full-table shuffle ceremony: each deck split & riffled, then stacked into the shoe. */
function ShuffleCeremony({ decks, stage }) {
  // stage: riffling | stacking
  return (
    <div className="bj-shuffle-overlay" aria-live="polite" aria-label="Shuffling shoe">
      <div className="bj-shuffle-panel">
        <div className="bj-shuffle-title">
          {stage === "stacking" ? "LOADING SHOE" : "SHUFFLING"}
        </div>
        <div className="bj-shuffle-sub">
          {stage === "stacking"
            ? `Stacking ${decks} deck${decks === 1 ? "" : "s"} into the shoe`
            : `Riffling each of ${decks} deck${decks === 1 ? "" : "s"} half and half`}
        </div>
        <div className="bj-shuffle-decks" data-count={decks}>
          {Array.from({ length: decks }, (_, i) => (
            <div
              key={i}
              className={`bj-shuffle-deck${stage === "riffling" ? " is-riffle" : " is-stack"}`}
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <div className="bj-shuffle-half bj-shuffle-half-l" />
              <div className="bj-shuffle-half bj-shuffle-half-r" />
              <div className="bj-shuffle-deck-label">D{i + 1}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Player places the cut card into the shuffled stack. */
/** Player places the cut card by eye into a dense stack — no slider, no count. */
function CutOverlay({ onCut }) {
  const stackRef = useRef(null);
  const [hoverFrac, setHoverFrac] = useState(null);
  const [placedFrac, setPlacedFrac] = useState(null);
  const layers = 52;

  const fracFromPointer = (clientX) => {
    const el = stackRef.current;
    if (!el) return 0.5;
    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    // Valid cut band — ends are soft-blocked so you can't dump the whole shoe
    return Math.min(0.78, Math.max(0.22, x));
  };

  const active = placedFrac ?? hoverFrac;

  return (
    <div className="bj-cut-overlay" role="dialog" aria-modal="true" aria-label="Cut the cards">
      <div className="bj-cut-panel">
        <div className="bj-cut-title">PLACE THE CUT</div>
        <div className="bj-cut-sub">
          Find a spot in the stack and tap it. The yellow cut card goes there —
          everything above moves to the bottom of the shoe. No second chances.
        </div>

        <div
          className="bj-cut-deck"
          ref={stackRef}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={active != null ? Math.round(active * 100) : 50}
          aria-label="Cut position in the deck"
          tabIndex={0}
          onMouseMove={(e) => {
            if (placedFrac != null) return;
            setHoverFrac(fracFromPointer(e.clientX));
          }}
          onMouseLeave={() => {
            if (placedFrac == null) setHoverFrac(null);
          }}
          onClick={(e) => {
            const f = fracFromPointer(e.clientX);
            setPlacedFrac(f);
            setHoverFrac(f);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Enter") return;
            e.preventDefault();
            const base = placedFrac ?? hoverFrac ?? 0.5;
            if (e.key === "Enter") {
              setPlacedFrac(base);
              return;
            }
            const next = Math.min(
              0.78,
              Math.max(0.22, base + (e.key === "ArrowRight" ? 0.03 : -0.03))
            );
            setHoverFrac(next);
            setPlacedFrac(null);
          }}
        >
          <div className="bj-cut-deck-felt" aria-hidden />
          {Array.from({ length: layers }, (_, i) => {
            const t = i / (layers - 1);
            // Slight fan + jitter so depth is hard to read precisely
            const jitter = ((i * 17) % 7) - 3;
            return (
              <span
                key={i}
                className="bj-cut-spine"
                style={{
                  left: `${4 + t * 88}%`,
                  top: `${18 + (jitter % 5)}px`,
                  zIndex: i + 1,
                  transform: `rotate(${(t - 0.5) * 6 + jitter * 0.15}deg)`,
                }}
              />
            );
          })}
          {active != null && (
            <div
              className={`bj-cut-wedge${placedFrac != null ? " is-set" : ""}`}
              style={{ left: `${4 + active * 88}%` }}
              aria-hidden
            >
              <span className="bj-cut-wedge-label">CUT</span>
            </div>
          )}
          {placedFrac == null && hoverFrac == null && (
            <div className="bj-cut-hint">Tap a card in the stack</div>
          )}
        </div>

        <button
          type="button"
          className="bj-cut-confirm"
          disabled={placedFrac == null}
          onClick={() => placedFrac != null && onCut(placedFrac)}
        >
          {placedFrac == null ? "CHOOSE A SPOT" : "BURN THE CUT"}
        </button>
      </div>
    </div>
  );
}

export default function BlackjackGame() {
  const [casino, setCasino] = useState(getDefaultCasino);
  const [draftCasino, setDraftCasino] = useState(getDefaultCasino);
  const [casinoQuery, setCasinoQuery] = useState("");
  const [pickingCasino, setPickingCasino] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bjPayout, setBjPayout] = useState("3:2");
  const [hitSoft17, setHitSoft17] = useState(false);
  const [deckCount, setDeckCount] = useState(DEFAULT_DECKS);
  const [playerCut, setPlayerCut] = useState(true);
  const [autoDeal, setAutoDeal] = useState(false);
  const [sideBetsEnabled, setSideBetsEnabled] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [phase, setPhase] = useState("betting");
  const [betAmount, setBetAmount] = useState(() => getDefaultCasino().minBet);
  const [lastChip, setLastChip] = useState(() => getDefaultCasino().minBet);
  const [sideBetPairs, setSideBetPairs] = useState(0);
  const [sideBet213, setSideBet213] = useState(0);
  const [betTarget, setBetTarget] = useState("main");
  const [handCount, setHandCount] = useState(1);
  const [bank, setBank] = useState(STARTING_BANK);
  const [sessionStats, setSessionStats] = useState(() =>
    createSessionStats(STARTING_BANK)
  );
  const [analytics, setAnalytics] = useState(null);
  const [dealerCards, setDealerCards] = useState([]);
  const [hands, setHands] = useState([]);
  const [activeHandIndex, setActiveHandIndex] = useState(0);
  const shoeSize = deckCount * 52;
  const [shoeRemaining, setShoeRemaining] = useState(0);
  /** idle | pay | collect | done — main bet settle */
  const [chipFlyPhase, setChipFlyPhase] = useState("idle");
  /** idle | pay | collect | done — side bets resolve right after the deal */
  const [sideChipFly, setSideChipFly] = useState("idle");
  const [shuffling, setShuffling] = useState(false);
  /** idle | riffling | stacking | cutting */
  const [shuffleStage, setShuffleStage] = useState("idle");
  const [pendingDealAfterShuffle, setPendingDealAfterShuffle] = useState(false);

  const shoeRef = useRef([]);
  const reshuffleAtRef = useRef(Math.floor(DEFAULT_DECKS * 52 * 0.25));
  const rulesRef = useRef({
    bjPayout: "3:2",
    hitSoft17: false,
    deckCount: DEFAULT_DECKS,
    playerCut: true,
  });
  const timersRef = useRef([]);
  const handsRef = useRef([]);
  const dealerRef = useRef([]);
  const bankRef = useRef(STARTING_BANK);
  const activeIndexRef = useRef(0);
  const pendingShoeRef = useRef(null);
  const shuffleLockRef = useRef(false);
  const autoDealRef = useRef(false);
  const sessionStatsRef = useRef(sessionStats);
  const analyticsOpenRef = useRef(false);
  const endSessionRef = useRef(() => {});

  const clearTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  };

  const syncShoeCount = () => setShoeRemaining(shoeRef.current.length);

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    rulesRef.current = { bjPayout, hitSoft17, deckCount, playerCut };
  }, [bjPayout, hitSoft17, deckCount, playerCut]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsNarrow(!!mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    mq.addListener?.(apply);
    return () => {
      mq.removeEventListener?.("change", apply);
      mq.removeListener?.(apply);
    };
  }, []);

  useEffect(() => {
    handsRef.current = hands;
  }, [hands]);

  useEffect(() => {
    dealerRef.current = dealerCards;
  }, [dealerCards]);

  useEffect(() => {
    bankRef.current = bank;
  }, [bank]);

  useEffect(() => {
    activeIndexRef.current = activeHandIndex;
  }, [activeHandIndex]);

  useEffect(() => {
    autoDealRef.current = autoDeal;
  }, [autoDeal]);

  useEffect(() => {
    sessionStatsRef.current = sessionStats;
  }, [sessionStats]);

  useEffect(() => {
    analyticsOpenRef.current = !!analytics;
  }, [analytics]);

  const resetSessionStats = useCallback((nextBank = STARTING_BANK) => {
    const fresh = createSessionStats(nextBank);
    sessionStatsRef.current = fresh;
    setSessionStats(fresh);
  }, []);

  const endSession = useCallback((reason = "manual") => {
    if (analyticsOpenRef.current) return;
    const snapshot = {
      ...sessionStatsRef.current,
      endBank: bankRef.current,
      netProfit: bankRef.current - sessionStatsRef.current.startBank,
      endedAt: Date.now(),
      endReason: reason,
    };
    sessionStatsRef.current = snapshot;
    setSessionStats(snapshot);
    setAnalytics(snapshot);
    setAutoDeal(false);
    autoDealRef.current = false;
    setChipFlyPhase("idle");
    setHands([]);
    handsRef.current = [];
    setDealerCards([]);
    dealerRef.current = [];
    setPhase("betting");
    setSettingsOpen(false);
  }, []);

  useEffect(() => {
    endSessionRef.current = endSession;
  }, [endSession]);

  const tableChips = useMemo(
    () => chipsForTable(casino.minBet, casino.maxBet),
    [casino.minBet, casino.maxBet]
  );

  const effectivePairs = sideBetsEnabled ? sideBetPairs : 0;
  const effective213 = sideBetsEnabled ? sideBet213 : 0;
  const perHandCost = betAmount + effectivePairs + effective213;
  const maxAffordableHands = Math.max(
    1,
    perHandCost > 0 ? Math.floor(bank / perHandCost) : 1
  );
  const totalStake = perHandCost * handCount;
  const canAffordDeal =
    bank >= totalStake &&
    betAmount >= casino.minBet &&
    betAmount <= casino.maxBet &&
    handCount >= 1 &&
    !shuffling &&
    shuffleStage === "idle";

  const addChipToBet = (value) => {
    if (phase !== "betting" || shuffling) return;
    const target = sideBetsEnabled ? betTarget : "main";
    const pairs = sideBetPairs;
    const plus3 = sideBet213;
    let nextMain = betAmount;
    let nextPairs = pairs;
    let nextPlus3 = plus3;

    if (target === "pairs") {
      nextPairs = pairs + value;
      if (nextPairs > casino.maxBet) return;
    } else if (target === "twentyOnePlus3") {
      nextPlus3 = plus3 + value;
      if (nextPlus3 > casino.maxBet) return;
    } else {
      nextMain = betAmount + value;
      if (nextMain > casino.maxBet) return;
    }

    const nextPerHand = nextMain + nextPairs + nextPlus3;
    if (nextPerHand * handCount > bank) return;

    if (target === "pairs") setSideBetPairs(nextPairs);
    else if (target === "twentyOnePlus3") setSideBet213(nextPlus3);
    else setBetAmount(nextMain);

    setLastChip(value);
    const maxHands = Math.max(1, Math.floor(bank / nextPerHand) || 1);
    if (handCount > maxHands) setHandCount(maxHands);
  };

  const clearBet = () => {
    if (phase !== "betting" || shuffling) return;
    const target = sideBetsEnabled ? betTarget : "main";
    if (target === "pairs") setSideBetPairs(0);
    else if (target === "twentyOnePlus3") setSideBet213(0);
    else setBetAmount(0);
  };

  const activeSideAmount =
    sideBetsEnabled && betTarget === "pairs"
      ? sideBetPairs
      : sideBetsEnabled && betTarget === "twentyOnePlus3"
        ? sideBet213
        : betAmount;

  const canEditSettings =
    phase === "betting" && !shuffling && shuffleStage === "idle";

  const revealHole = phase === "dealer" || phase === "settle";
  const seatCount = phase === "betting" ? handCount : Math.max(hands.length, 1);
  const compact = seatCount >= 3;
  const manySeats = seatCount > 4;

  const setSideBetsOn = (on) => {
    setSideBetsEnabled(on);
    if (!on) {
      setSideBetPairs(0);
      setSideBet213(0);
      setBetTarget("main");
    }
  };

  const dealerTotal = useMemo(() => {
    if (dealerCards.length === 0) return "—";
    const { total } = evaluateHand(dealerCards, { revealHole });
    return String(total);
  }, [dealerCards, revealHole]);

  const showTable = phase !== "betting";

  const beginPlayerCut = useCallback((shoe, { dealAfter = false } = {}) => {
    pendingShoeRef.current = shoe;
    setPendingDealAfterShuffle(dealAfter);
    setShuffleStage("cutting");
    setShuffling(true);
  }, []);

  const completePlayerCut = useCallback((fraction) => {
    const base =
      pendingShoeRef.current || buildRiffleShoe(rulesRef.current.deckCount);
    const cutShoe = applyPlayerCut(base, fraction);
    shoeRef.current = cutShoe;
    reshuffleAtRef.current = Math.floor(cutShoe.length * 0.25);
    syncShoeCount();
    pendingShoeRef.current = null;
    shuffleLockRef.current = false;
    setShuffleStage("idle");
    setShuffling(false);
  }, []);

  /** Animate half/half riffle per deck → stack → optional cut. */
  const runShuffleCeremony = useCallback(
    ({ dealAfter = false, resetBank = false } = {}) => {
      clearTimers();
      shuffleLockRef.current = true;
      setSettingsOpen(false);
      setShuffling(true);
      setShoeRemaining(0);
      setShuffleStage("riffling");
      setHands([]);
      handsRef.current = [];
      setDealerCards([]);
      dealerRef.current = [];
      setChipFlyPhase("idle");
      setSideChipFly("idle");
      setPhase("betting");
      setActiveHandIndex(0);
      setPendingDealAfterShuffle(dealAfter);

      if (resetBank) {
        setBank(STARTING_BANK);
        bankRef.current = STARTING_BANK;
        const fresh = createSessionStats(STARTING_BANK);
        sessionStatsRef.current = fresh;
        setSessionStats(fresh);
        setAnalytics(null);
      }

      const decks = rulesRef.current.deckCount;
      const riffleMs = Math.max(SHUFFLE_DECK_MS, decks * 160 + 500);

      const stackId = window.setTimeout(() => {
        setShuffleStage("stacking");
      }, riffleMs);
      timersRef.current.push(stackId);

      const doneId = window.setTimeout(() => {
        const shoe = buildRiffleShoe(decks);
        shuffleLockRef.current = false;
        if (rulesRef.current.playerCut) {
          beginPlayerCut(shoe, { dealAfter });
        } else {
          shoeRef.current = shoe;
          reshuffleAtRef.current = Math.floor(shoe.length * 0.25);
          syncShoeCount();
          setShuffling(false);
          setShuffleStage("idle");
        }
      }, riffleMs + SHUFFLE_STACK_MS);
      timersRef.current.push(doneId);
    },
    [beginPlayerCut]
  );

  // First visit: shuffle then cut before any deal (module flag survives Strict Mode)
  useEffect(() => {
    if (shoeSessionBootstrapped) {
      // Remount after boot timers were cleared — recover with cut (or shoe) once
      if (!shoeRef.current.length && shuffleStage === "idle" && !shuffling) {
        const shoe = buildRiffleShoe(rulesRef.current.deckCount);
        if (rulesRef.current.playerCut) beginPlayerCut(shoe, { dealAfter: false });
        else {
          shoeRef.current = shoe;
          reshuffleAtRef.current = Math.floor(shoe.length * 0.25);
          syncShoeCount();
        }
      }
      return undefined;
    }
    shoeSessionBootstrapped = true;
    runShuffleCeremony({ dealAfter: false, resetBank: false });
    return undefined;
    // intentionally once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishRoundToDealer = useCallback(() => {
    setPhase("dealer");

    const id = window.setTimeout(() => {
      // Flip hole — keep the same dealKey so we don't remount into an
      // opacity-0 entrance; Card picks up flipping and runs cardFlip once.
      let dealer = dealerRef.current.map((c) => ({
        ...c,
        faceDown: false,
        flipping: !!c.faceDown,
      }));
      setDealerCards(dealer);
      dealerRef.current = dealer;

      const clearFlip = window.setTimeout(() => {
        const cleared = dealerRef.current.map((c) => ({ ...c, flipping: false }));
        dealerRef.current = cleared;
        setDealerCards(cleared);
      }, DEAL_FLIGHT_MS + 60);
      timersRef.current.push(clearFlip);

      const currentHands = handsRef.current;
      const needsDealerDraw = currentHands.some((h) => h.status === "standing");

      const runSettle = (finalDealer) => {
        const dealerEval = evaluateHand(finalDealer);
        let creditTotal = 0;

        const settled = currentHands.map((h) => {
          const handForSettle =
            h.status === "bust"
              ? { ...h, status: "bust" }
              : h.status === "blackjack"
                ? h
                : { ...h, status: "standing" };
          const result = settleHand(handForSettle, dealerEval, {
            bjPayout: rulesRef.current.bjPayout,
          });
          creditTotal += result.credit;
          return {
            ...h,
            status: result.status,
            flipping: false,
            outcome: result.outcome,
            profit: result.profit,
            credit: result.credit,
            payoutAmount: Math.max(0, result.credit - h.bet),
            flash: null,
          };
        });

        setHands(settled);
        handsRef.current = settled;
        setPhase("settle");
        const anyWin = settled.some(
          (h) => h.status === "won" || h.status === "blackjack"
        );

        // Wins: dealer pays chips onto the bet, then stacks return to the player.
        // Losses: bet chips travel to the dealer. Pushes: bet returns to player.
        if (anyWin) setChipFlyPhase("pay");
        else setChipFlyPhase("collect");

        const collectDelay = anyWin ? CHIP_FLY_MS + 100 : 30;
        if (anyWin) {
          const t = window.setTimeout(
            () => setChipFlyPhase("collect"),
            collectDelay
          );
          timersRef.current.push(t);
        }

        const finishId = window.setTimeout(() => {
          let nextBank = bankRef.current + creditTotal;
          if (nextBank < 0) nextBank = 0;
          const nextStats = applyRoundToStats(
            sessionStatsRef.current,
            settled,
            nextBank
          );
          sessionStatsRef.current = nextStats;
          setSessionStats(nextStats);
          setBank(nextBank);
          bankRef.current = nextBank;
          setChipFlyPhase("done");
          // Remove bet stacks from the felt after they finish flying.
          setHands((prev) => {
            const cleared = prev.map((h) => ({
              ...h,
              bet: 0,
              payoutAmount: 0,
              sideBets: { pairs: 0, twentyOnePlus3: 0 },
            }));
            handsRef.current = cleared;
            return cleared;
          });
        }, collectDelay + CHIP_FLY_MS + 80);
        timersRef.current.push(finishId);
      };

      if (!needsDealerDraw) {
        const settleId = window.setTimeout(() => runSettle(dealer), 450);
        timersRef.current.push(settleId);
        return;
      }

      // Compute full dealer hand, then reveal draws one at a time
      const played = dealerPlayOut(dealer, shoeRef.current, {
        hitSoft17: rulesRef.current.hitSoft17,
      });
      shoeRef.current = played.shoe;
      syncShoeCount();
      const finalCards = played.cards;
      const extra = finalCards.slice(dealer.length);

      const revealExtra = (i) => {
        if (i >= extra.length) {
          runSettle(dealerRef.current);
          return;
        }
        const next = [...dealerRef.current, extra[i]];
        dealerRef.current = next;
        setDealerCards(next);
        const t = window.setTimeout(() => revealExtra(i + 1), DEALER_DRAW_MS);
        timersRef.current.push(t);
      };

      const startDraw = window.setTimeout(() => revealExtra(0), 500);
      timersRef.current.push(startDraw);
    }, 280);
    timersRef.current.push(id);
  }, []);

  const advanceAfterHand = useCallback(
    (nextHands, fromIndex) => {
      handsRef.current = nextHands;
      setHands(nextHands);

      let idx = fromIndex + 1;
      while (idx < nextHands.length && nextHands[idx].status !== "active") {
        idx += 1;
      }

      if (idx >= nextHands.length) {
        finishRoundToDealer();
        return;
      }
      setActiveHandIndex(idx);
      activeIndexRef.current = idx;
      setPhase("player");
    },
    [finishRoundToDealer]
  );

  const beginPlayerPhase = useCallback(
    (dealtHands, dealtDealer) => {
      const dealerUp =
        dealtDealer.find((c) => !c.faceDown) || dealtDealer[0] || null;
      const dealerPeekBJ = evaluateHand(
        dealtDealer.map((c) => ({ ...c, faceDown: false }))
      ).blackjack;

      let sideCreditTotal = 0;
      let anySideBet = false;
      let anySideWin = false;
      let nextHands = dealtHands.map((h) => {
        const pairsRes = settleSideBet(
          h.sideBets?.pairs || 0,
          evaluatePerfectPairs(h.cards)
        );
        const plus3Res = settleSideBet(
          h.sideBets?.twentyOnePlus3 || 0,
          evaluateTwentyOnePlus3(h.cards, dealerUp)
        );
        sideCreditTotal += pairsRes.credit + plus3Res.credit;
        if ((h.sideBets?.pairs || 0) > 0 || (h.sideBets?.twentyOnePlus3 || 0) > 0) {
          anySideBet = true;
        }
        if (pairsRes.outcome === "win" || plus3Res.outcome === "win") {
          anySideWin = true;
        }

        const ev = evaluateHand(h.cards);
        let status = "active";
        let flash = null;
        if (ev.blackjack && !h.fromSplit) {
          status = "blackjack";
          flash = "blackjack";
        } else if (ev.total === 21) {
          status = "standing";
          flash = "twentyone";
        }

        return {
          ...h,
          status,
          flash,
          sideResults: { pairs: pairsRes, twentyOnePlus3: plus3Res },
        };
      });

      if (sideCreditTotal > 0) {
        const nextBank = bankRef.current + sideCreditTotal;
        bankRef.current = nextBank;
        setBank(nextBank);
      }

      handsRef.current = nextHands;
      setHands(nextHands);

      // Side bets pay/collect immediately — don't wait for the main hand.
      if (anySideBet) {
        if (anySideWin) setSideChipFly("pay");
        else setSideChipFly("collect");

        const sideCollectDelay = anySideWin ? CHIP_FLY_MS + 80 : 30;
        if (anySideWin) {
          const payT = window.setTimeout(() => setSideChipFly("collect"), sideCollectDelay);
          timersRef.current.push(payT);
        }
        const clearT = window.setTimeout(() => {
          setHands((prev) => {
            const cleared = prev.map((h) => ({
              ...h,
              sideBets: { pairs: 0, twentyOnePlus3: 0 },
            }));
            handsRef.current = cleared;
            return cleared;
          });
          setSideChipFly("done");
        }, sideCollectDelay + CHIP_FLY_MS + 60);
        timersRef.current.push(clearT);
      } else {
        setSideChipFly("idle");
      }

      // Clear 21 / BJ flash after a beat
      const flashClear = window.setTimeout(() => {
        setHands((prev) =>
          prev.map((h) => (h.flash ? { ...h, flash: null } : h))
        );
      }, 900);
      timersRef.current.push(flashClear);

      if (dealerPeekBJ) {
        const t = window.setTimeout(() => finishRoundToDealer(), 650);
        timersRef.current.push(t);
        return;
      }

      let idx = 0;
      while (idx < nextHands.length && nextHands[idx].status !== "active") {
        idx += 1;
      }
      if (idx >= nextHands.length) {
        const t = window.setTimeout(() => finishRoundToDealer(), 700);
        timersRef.current.push(t);
        return;
      }
      setActiveHandIndex(idx);
      activeIndexRef.current = idx;
      setPhase("player");
    },
    [finishRoundToDealer]
  );

  const runDeal = useCallback(() => {
    const pairs = sideBetsEnabled ? sideBetPairs : 0;
    const plus3 = sideBetsEnabled ? sideBet213 : 0;
    const stake = (betAmount + pairs + plus3) * handCount;
    const nextBank = bankRef.current - stake;
    setBank(nextBank);
    bankRef.current = nextBank;

    const initialHands = Array.from({ length: handCount }, (_, i) => ({
      id: nextHandId(),
      cards: [],
      bet: betAmount,
      sideBets: {
        pairs,
        twentyOnePlus3: plus3,
      },
      sideResults: null,
      status: "active",
      fromSplit: false,
      splitAces: false,
      seat: i + 1,
    }));

    setHands(initialHands);
    handsRef.current = initialHands;
    setDealerCards([]);
    dealerRef.current = [];
    setChipFlyPhase("idle");
    setSideChipFly("idle");
    setPhase("dealing");
    setActiveHandIndex(0);

    const sequence = buildDealSequence(handCount);
    let workingHands = initialHands.map((h) => ({ ...h, cards: [] }));
    let workingDealer = [];

    sequence.forEach((step, index) => {
      const id = window.setTimeout(() => {
        let drawn = drawFromShoe(shoeRef.current);
        if (!drawn.card) {
          shoeRef.current = makeShoe();
          drawn = drawFromShoe(shoeRef.current);
        }
        if (!drawn.card) return;
        shoeRef.current = drawn.shoe;
        syncShoeCount();

        if (step.to === "player") {
          const card = { ...drawn.card };
          workingHands = workingHands.map((h, hi) =>
            hi === step.handIndex ? { ...h, cards: [...h.cards, card] } : h
          );
          setHands(workingHands.map((h) => ({ ...h })));
          handsRef.current = workingHands;
        } else {
          const card = { ...drawn.card, faceDown: !!step.hole };
          workingDealer = [...workingDealer, card];
          setDealerCards(workingDealer.map((c) => ({ ...c })));
          dealerRef.current = workingDealer;
        }
      }, DEAL_STEP_MS * (index + 1));
      timersRef.current.push(id);
    });

    const doneId = window.setTimeout(() => {
      beginPlayerPhase(workingHands, workingDealer);
    }, DEAL_STEP_MS * (sequence.length + 1));
    timersRef.current.push(doneId);
  }, [betAmount, sideBetPairs, sideBet213, sideBetsEnabled, handCount, beginPlayerPhase]);

  useEffect(() => {
    if (!pendingDealAfterShuffle) return;
    if (shuffling || shuffleStage !== "idle") return;
    setPendingDealAfterShuffle(false);
    runDeal();
  }, [pendingDealAfterShuffle, shuffling, shuffleStage, runDeal]);

  const handleDeal = () => {
    if (!canAffordDeal || phase !== "betting" || shuffling) return;
    if (analyticsOpenRef.current) return;
    clearTimers();

    const needsShuffle = shoeRef.current.length <= reshuffleAtRef.current;
    if (needsShuffle) {
      // Auto-deal sessions end at the cut card instead of reshuffling mid-run.
      if (autoDealRef.current && sessionStatsRef.current.rounds > 0) {
        endSessionRef.current("shoe");
        return;
      }
      runShuffleCeremony({ dealAfter: true });
      return;
    }

    runDeal();
  };

  const handleRestartGame = () => {
    if (!canEditSettings) return;
    setAnalytics(null);
    setAutoDeal(false);
    autoDealRef.current = false;
    resetSessionStats(STARTING_BANK);
    runShuffleCeremony({ dealAfter: false, resetBank: true });
  };

  const handleNewSessionFromAnalytics = () => {
    setAnalytics(null);
    clearTimers();
    setBank(STARTING_BANK);
    bankRef.current = STARTING_BANK;
    resetSessionStats(STARTING_BANK);
    setBetAmount(casino.minBet);
    setHandCount(1);
    setHands([]);
    handsRef.current = [];
    setDealerCards([]);
    dealerRef.current = [];
    setChipFlyPhase("idle");
    setPhase("betting");
    setSettingsOpen(false);
    runShuffleCeremony({ dealAfter: false, resetBank: false });
  };

  const handleDeckCountChange = (n) => {
    setDeckCount(n);
    rulesRef.current = { ...rulesRef.current, deckCount: n };
  };

  const updateActiveHand = (updater) => {
    const idx = activeIndexRef.current;
    const next = handsRef.current.map((h, i) => (i === idx ? updater(h) : h));
    return next;
  };

  const handleHit = () => {
    if (phase !== "player") return;
    const idx = activeIndexRef.current;
    const hand = handsRef.current[idx];
    if (!hand || hand.status !== "active") return;

    const drawn = drawFromShoe(shoeRef.current);
    if (!drawn.card) return;
    shoeRef.current = drawn.shoe;
    syncShoeCount();

    const cards = [...hand.cards, drawn.card];
    const ev = evaluateHand(cards);
    let status = "active";
    let flash = null;
    if (ev.bust) status = "bust";
    else if (ev.total === 21) {
      status = "standing";
      flash = "twentyone";
    }

    const nextHands = updateActiveHand((h) => ({
      ...h,
      cards,
      status,
      flash,
    }));
    handsRef.current = nextHands;
    setHands(nextHands);

    if (status === "bust" || status === "standing") {
      const delay = flash ? 700 : 400;
      const t = window.setTimeout(() => {
        const cleared = handsRef.current.map((h, i) =>
          i === idx ? { ...h, flash: null } : h
        );
        advanceAfterHand(cleared, idx);
      }, delay);
      timersRef.current.push(t);
    }
  };

  const handleStand = () => {
    if (phase !== "player") return;
    const idx = activeIndexRef.current;
    const nextHands = updateActiveHand((h) => ({ ...h, status: "standing" }));
    advanceAfterHand(nextHands, idx);
  };

  const handleDouble = () => {
    if (phase !== "player") return;
    const idx = activeIndexRef.current;
    const hand = handsRef.current[idx];
    if (!hand || !canDouble(hand, bankRef.current)) return;

    const nextBank = bankRef.current - hand.bet;
    setBank(nextBank);
    bankRef.current = nextBank;

    const drawn = drawFromShoe(shoeRef.current);
    if (!drawn.card) return;
    shoeRef.current = drawn.shoe;
    syncShoeCount();

    const cards = [...hand.cards, drawn.card];
    const ev = evaluateHand(cards);
    const status = ev.bust ? "bust" : "standing";
    const flash = !ev.bust && ev.total === 21 ? "twentyone" : null;
    const nextHands = updateActiveHand((h) => ({
      ...h,
      cards,
      bet: h.bet * 2,
      status,
      flash,
    }));
    handsRef.current = nextHands;
    setHands(nextHands);
    const t = window.setTimeout(() => {
      const cleared = handsRef.current.map((h, i) =>
        i === idx ? { ...h, flash: null } : h
      );
      advanceAfterHand(cleared, idx);
    }, flash ? 700 : 350);
    timersRef.current.push(t);
  };

  const handleSplit = () => {
    if (phase !== "player") return;
    const idx = activeIndexRef.current;
    const hand = handsRef.current[idx];
    if (!hand || !canSplit(hand, bankRef.current)) return;

    const nextBank = bankRef.current - hand.bet;
    setBank(nextBank);
    bankRef.current = nextBank;

    const [c1, c2] = hand.cards;
    const splittingAces = c1.rank === "A" && c2.rank === "A";

    const d1 = drawFromShoe(shoeRef.current);
    shoeRef.current = d1.shoe;
    const d2 = drawFromShoe(shoeRef.current);
    shoeRef.current = d2.shoe;
    syncShoeCount();

    const handA = {
      ...hand,
      id: nextHandId(),
      cards: [
        { ...c1, fromSplitHand: true },
        { ...d1.card, fromSplitHand: true },
      ],
      fromSplit: true,
      splitAces: splittingAces,
      status: splittingAces ? "standing" : "active",
      // Side bets already resolved on the original two cards
      sideBets: { pairs: 0, twentyOnePlus3: 0 },
    };
    const handB = {
      id: nextHandId(),
      cards: [
        { ...c2, fromSplitHand: true },
        { ...d2.card, fromSplitHand: true },
      ],
      bet: hand.bet,
      sideBets: { pairs: 0, twentyOnePlus3: 0 },
      sideResults: null,
      fromSplit: true,
      splitAces: splittingAces,
      status: splittingAces ? "standing" : "active",
      seat: hand.seat,
    };

    // Split 21 is not natural BJ, but auto-stands (no further hits)
    const patch = (h) => {
      const ev = evaluateHand(h.cards);
      if (h.splitAces) {
        return { ...h, status: "standing", flash: ev.total === 21 ? "twentyone" : null };
      }
      if (ev.bust) return { ...h, status: "bust" };
      if (ev.total === 21) {
        return { ...h, status: "standing", flash: "twentyone" };
      }
      return h;
    };

    const nextHands = [
      ...handsRef.current.slice(0, idx),
      patch(handA),
      patch(handB),
      ...handsRef.current.slice(idx + 1),
    ];

    handsRef.current = nextHands;
    setHands(nextHands);

    const clearFlashLater = window.setTimeout(() => {
      setHands((prev) =>
        prev.map((h) => (h.flash ? { ...h, flash: null } : h))
      );
    }, 800);
    timersRef.current.push(clearFlashLater);

    if (splittingAces) {
      // Both auto-stood — find next active or dealer
      let nextIdx = idx + 2;
      while (
        nextIdx < nextHands.length &&
        nextHands[nextIdx].status !== "active"
      ) {
        nextIdx += 1;
      }
      if (nextIdx >= nextHands.length) {
        const t = window.setTimeout(() => finishRoundToDealer(), 650);
        timersRef.current.push(t);
      } else {
        setActiveHandIndex(nextIdx);
        activeIndexRef.current = nextIdx;
      }
      return;
    }

    // If first split hand already has 21, skip ahead to the next active hand
    let playIdx = idx;
    while (
      playIdx < nextHands.length &&
      nextHands[playIdx].status !== "active"
    ) {
      playIdx += 1;
    }
    if (playIdx >= nextHands.length) {
      const t = window.setTimeout(() => finishRoundToDealer(), 650);
      timersRef.current.push(t);
      return;
    }
    setActiveHandIndex(playIdx);
    activeIndexRef.current = playIdx;
    setPhase("player");
  };

  const handleNewRound = () => {
    clearTimers();
    let nextBank = bankRef.current;
    if (nextBank <= 0) {
      if (sessionStatsRef.current.rounds > 0) {
        endSessionRef.current("bank");
        return;
      }
      nextBank = STARTING_BANK;
      setBank(nextBank);
      bankRef.current = nextBank;
      resetSessionStats(nextBank);
    }
    const nextBet =
      betAmount >= casino.minBet && betAmount <= casino.maxBet
        ? betAmount
        : casino.minBet;
    if (nextBet !== betAmount) setBetAmount(nextBet);
    const nextPerHand = nextBet + sideBetPairs + sideBet213;
    const maxHands = Math.max(1, Math.floor(nextBank / Math.max(1, nextPerHand)) || 1);
    if (handCount > maxHands) setHandCount(maxHands);
    setHands([]);
    handsRef.current = [];
    setDealerCards([]);
    dealerRef.current = [];
    setActiveHandIndex(0);
    setChipFlyPhase("idle");
    setSideChipFly("idle");
    setPhase("betting");
  };

  // Auto-deal: after settle chips finish, continue or end the session.
  useEffect(() => {
    if (!autoDeal) return;
    if (analytics) return;
    if (phase !== "settle") return;
    if (chipFlyPhase !== "done") return;
    if (shuffling || shuffleStage !== "idle") return;

    const stake =
      Math.max(casino.minBet, betAmount + effectivePairs + effective213) *
      Math.max(1, handCount);
    const bankNow = bankRef.current;
    const shoeLow = shoeRef.current.length <= reshuffleAtRef.current;

    if (bankNow <= 0 || bankNow < stake) {
      endSession("bank");
      return undefined;
    }
    if (shoeLow) {
      endSession("shoe");
      return undefined;
    }

    const t = window.setTimeout(() => {
      if (!autoDealRef.current || analyticsOpenRef.current) return;
      handleNewRound();
      const dealT = window.setTimeout(() => {
        if (!autoDealRef.current || analyticsOpenRef.current) return;
        const cost = (betAmount + effectivePairs + effective213) * handCount;
        if (bankRef.current < cost) {
          endSessionRef.current("bank");
          return;
        }
        if (shoeRef.current.length <= reshuffleAtRef.current) {
          endSessionRef.current("shoe");
          return;
        }
        runDeal();
      }, 220);
      timersRef.current.push(dealT);
    }, AUTO_DEAL_PAUSE_MS);

    timersRef.current.push(t);
    return () => window.clearTimeout(t);
    // handleNewRound/runDeal/endSession are stable enough via refs for this loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoDeal,
    analytics,
    phase,
    chipFlyPhase,
    shuffling,
    shuffleStage,
    betAmount,
    sideBetPairs,
    sideBet213,
    sideBetsEnabled,
    handCount,
    casino.minBet,
  ]);

  const flyForHand = (status) => {
    if (chipFlyPhase === "pay") {
      if (status === "won" || status === "blackjack") return "from-dealer";
      return "idle";
    }
    if (chipFlyPhase === "collect") {
      if (status === "lost" || status === "bust") return "to-dealer";
      if (status === "won" || status === "blackjack" || status === "push") {
        return "to-player";
      }
    }
    if (chipFlyPhase === "done") return "done";
    return "idle";
  };

  const activeHand = hands[activeHandIndex];
  const hitEnabled = phase === "player" && activeHand?.status === "active";
  const standEnabled = hitEnabled;
  const doubleEnabled =
    phase === "player" && activeHand && canDouble(activeHand, bank);
  const splitEnabled =
    phase === "player" && activeHand && canSplit(activeHand, bank);

  const openCasinoPicker = () => {
    if (phase !== "betting" || shuffling || shuffleStage !== "idle") return;
    setDraftCasino(casino);
    setPickingCasino(true);
  };

  const applyCasino = (c) => {
    setCasino(c);
    setDraftCasino(c);
    setPickingCasino(false);
    setBetAmount(c.minBet);
    setSideBetPairs(0);
    setSideBet213(0);
    setBetTarget("main");
    const tray = chipsForTable(c.minBet, c.maxBet);
    setLastChip(tray[0]?.value ?? c.minBet);
    const maxHands = Math.max(1, Math.floor(bank / c.minBet) || 1);
    if (handCount > maxHands) setHandCount(maxHands);
  };

  const theme = getCasinoTheme(casino);

  return (
    <div
      className="bj-page"
      data-theme={theme.id}
      style={{
        height: "100dvh",
        minHeight: "100dvh",
        maxHeight: "100dvh",
        background: `radial-gradient(ellipse at center, ${theme.page1} 0%, ${theme.page2} 70%, ${theme.page3} 100%)`,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        padding: "8px 10px calc(8px + env(safe-area-inset-bottom, 0px))",
        fontFamily: "'Inter', sans-serif",
        boxSizing: "border-box",
        "--casino-accent": theme.accent,
        "--felt-1": theme.felt1,
        "--felt-2": theme.felt2,
        "--felt-3": theme.felt3,
        transition: "background 0.55s ease",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap');
        *, *::before, *::after { box-sizing: border-box; }
        @keyframes cardDeal {
          0% { opacity: 0; transform: translate(60px, -80px) rotate(-16deg) scale(0.8); }
          100% { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(1); }
        }
        @keyframes cardFlip {
          0% { transform: scaleX(0.12) scale(0.96); opacity: 0.85; }
          100% { transform: scaleX(1) scale(1); opacity: 1; }
        }
        @keyframes outcomeBurst {
          0% {
            opacity: 0;
            transform: scale(0.55) translateY(10px);
            filter: blur(2px);
          }
          55% {
            opacity: 1;
            transform: scale(1.12) translateY(0);
            filter: blur(0);
          }
          100% {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        @keyframes chipFlyDealer {
          0% { opacity: 1; transform: translate(0, 0) scale(1); }
          100% { opacity: 0; transform: translate(0, -180px) scale(0.45); }
        }
        @keyframes chipFlyPlayer {
          0% { opacity: 1; transform: translate(0, 0) scale(1); }
          100% { opacity: 0; transform: translate(0, 120px) scale(0.5); }
        }
        @keyframes chipFlyFromDealer {
          0% { opacity: 0; transform: translate(0, -150px) scale(0.45); }
          100% { opacity: 1; transform: translate(0, 0) scale(1); }
        }
        @keyframes chipSpotPulse {
          0%, 100% {
            box-shadow:
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 55%, transparent),
              inset 0 0 0 5px rgba(0,0,0,0.2),
              0 4px 12px rgba(0,0,0,0.25);
          }
          50% {
            box-shadow:
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 90%, transparent),
              inset 0 0 0 5px rgba(0,0,0,0.2),
              0 0 18px color-mix(in srgb, var(--casino-accent) 35%, transparent);
          }
        }
        @keyframes chipSpotNeon {
          0%, 100% {
            box-shadow:
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 50%, transparent),
              inset 0 0 0 5px rgba(0,0,0,0.25),
              0 0 8px color-mix(in srgb, var(--casino-accent) 25%, transparent);
          }
          50% {
            box-shadow:
              inset 0 0 0 2px var(--casino-accent),
              inset 0 0 0 5px rgba(0,0,0,0.25),
              0 0 22px color-mix(in srgb, var(--casino-accent) 45%, transparent);
          }
        }
        @keyframes chipIdleSpinGlow {
          0% { filter: brightness(1); }
          50% { filter: brightness(1.12); }
          100% { filter: brightness(1); }
        }
        @keyframes tableBreathe {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.06); }
        }
        @keyframes tableNeonSweep {
          0%, 100% {
            box-shadow:
              0 18px 40px rgba(0,0,0,0.5),
              inset 0 0 70px rgba(0,0,0,0.28),
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 25%, transparent);
          }
          50% {
            box-shadow:
              0 18px 40px rgba(0,0,0,0.5),
              inset 0 0 80px rgba(0,0,0,0.22),
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 55%, transparent),
              0 0 28px color-mix(in srgb, var(--casino-accent) 20%, transparent);
          }
        }
        @keyframes tableDesertShimmer {
          0%, 100% { background-position: 50% 40%; }
          50% { background-position: 54% 36%; }
        }
        @keyframes tableCoastalDrift {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        @keyframes tableMountainMist {
          0%, 100% { filter: saturate(1) brightness(1); }
          50% { filter: saturate(1.08) brightness(1.04); }
        }
        @keyframes tableJazzFlicker {
          0%, 100% { filter: brightness(1); }
          40% { filter: brightness(1.05); }
          42% { filter: brightness(0.97); }
          60% { filter: brightness(1.04); }
        }
        @keyframes tableGoldSpark {
          0%, 100% {
            box-shadow:
              0 18px 40px rgba(0,0,0,0.5),
              inset 0 0 70px rgba(0,0,0,0.28),
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 30%, transparent);
          }
          50% {
            box-shadow:
              0 18px 40px rgba(0,0,0,0.5),
              inset 0 0 60px rgba(0,0,0,0.22),
              inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 70%, transparent);
          }
        }
        @keyframes tableMidnightPulse {
          0%, 100% { filter: brightness(1) contrast(1); }
          50% { filter: brightness(1.07) contrast(1.04); }
        }
        .bj-chip-spot {
          position: relative;
          overflow: visible !important;
        }
        .bj-bet-stack.is-idle .bj-felt-chip {
          /* no transform idle motion — avoids clipping */
        }
        [data-theme="neon"] .bj-bet-stack.is-idle .bj-felt-chip { animation: chipIdleSpinGlow 1.4s ease-in-out infinite; }
        [data-theme="goldrush"] .bj-bet-stack.is-idle .bj-felt-chip { animation: chipIdleSpinGlow 1.8s ease-in-out infinite; }
        [data-theme="velvet"] .bj-table-felt { animation: tableBreathe 4.5s ease-in-out infinite; }
        [data-theme="neon"] .bj-table-felt { animation: tableNeonSweep 2.4s ease-in-out infinite; }
        [data-theme="desert"] .bj-table-felt {
          background-size: 120% 120%;
          animation: tableDesertShimmer 6s ease-in-out infinite, tableBreathe 5s ease-in-out infinite;
        }
        [data-theme="coastal"] .bj-table-felt { animation: tableBreathe 4s ease-in-out infinite; }
        [data-theme="mountain"] .bj-table-felt { animation: tableMountainMist 5.5s ease-in-out infinite; }
        [data-theme="jazz"] .bj-table-felt { animation: tableJazzFlicker 3.2s ease-in-out infinite; }
        [data-theme="goldrush"] .bj-table-felt { animation: tableGoldSpark 2.8s ease-in-out infinite; }
        [data-theme="midnight"] .bj-table-felt { animation: tableMidnightPulse 4.2s ease-in-out infinite; }
        @keyframes shoeShake {
          0%, 100% { transform: rotate(-18deg) translate(0, 0); }
          15% { transform: rotate(-22deg) translate(-3px, -2px); }
          30% { transform: rotate(-14deg) translate(4px, 1px); }
          45% { transform: rotate(-24deg) translate(-2px, 2px); }
          60% { transform: rotate(-12deg) translate(3px, -1px); }
          75% { transform: rotate(-20deg) translate(-1px, 1px); }
        }
        @keyframes shoeCardRiffle {
          0% { transform: translate(0, 0) rotate(-2deg); opacity: 1; }
          35% { transform: translate(var(--riffle-x), -28px) rotate(var(--riffle-r)); opacity: 1; }
          70% { transform: translate(calc(var(--riffle-x) * -0.4), -8px) rotate(calc(var(--riffle-r) * -0.5)); opacity: 0.95; }
          100% { transform: translate(0, 0) rotate(-2deg); opacity: 1; }
        }
        @keyframes shoeCardFlutter {
          0%, 100% { transform: translateX(0) rotate(-2deg); }
          50% { transform: translateX(6px) rotate(3deg); }
        }
        .bj-card {
          overflow: hidden;
          border-radius: 8px;
          background: #F8F4EA;
        }
        .bj-card-face {
          width: 100%;
          height: 100%;
          border-radius: 8px;
          box-sizing: border-box;
          overflow: hidden;
          position: relative;
        }
        .bj-card-back {
          background:
            radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.1) 0%, transparent 45%),
            linear-gradient(145deg, #146B4A 0%, #0B4530 48%, #06281C 100%);
          border: 2px solid ${FELT.gold};
          box-shadow:
            0 6px 14px rgba(0,0,0,0.45),
            inset 0 0 0 1px rgba(255,255,255,0.08);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .bj-card-back-pattern {
          position: absolute;
          inset: 5px;
          border-radius: 4px;
          background:
            repeating-linear-gradient(
              45deg,
              rgba(201, 162, 39, 0.22) 0 1px,
              transparent 1px 7px
            ),
            repeating-linear-gradient(
              -45deg,
              rgba(201, 162, 39, 0.18) 0 1px,
              transparent 1px 7px
            ),
            linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.28));
          border: 1px solid rgba(201, 162, 39, 0.35);
          pointer-events: none;
        }
        .bj-card-back-inner {
          width: 46%;
          height: 54%;
          border: 1.5px solid ${FELT.gold};
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          background:
            radial-gradient(circle at 50% 45%, rgba(201,162,39,0.28) 0%, transparent 65%),
            rgba(4, 22, 16, 0.55);
          box-shadow: inset 0 0 0 1px rgba(0,0,0,0.25);
          position: relative;
          z-index: 1;
        }
        .bj-card-back-motif {
          width: 12px;
          height: 12px;
          transform: rotate(45deg);
          background: ${FELT.gold};
          box-shadow: 0 0 0 2px rgba(4, 22, 16, 0.45);
          opacity: 0.95;
        }
        .bj-card-front {
          background:
            radial-gradient(ellipse at 20% 15%, #FFFEF8 0%, transparent 40%),
            linear-gradient(165deg, #FFFEF9 0%, #F4EEDC 55%, #EBE3CF 100%);
          border: 1.5px solid #C9B98A;
          box-shadow:
            0 6px 14px rgba(0,0,0,0.42),
            inset 0 0 0 1px rgba(255,255,255,0.65);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          padding: 6px 8px;
        }
        .bj-card-front-sheen {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background:
            linear-gradient(125deg, rgba(255,255,255,0.35) 0%, transparent 38%, transparent 100%);
          pointer-events: none;
        }
        .bj-card.is-compact .bj-card-front {
          padding: 4px 5px;
        }
        .bj-card-corner {
          line-height: 1;
          position: relative;
          z-index: 1;
        }
        .bj-card-corner-br {
          align-self: flex-end;
          transform: rotate(180deg);
        }
        .bj-card-rank {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          letter-spacing: 0.5px;
          line-height: 1;
        }
        .bj-card.is-compact .bj-card-rank { font-size: 16px; }
        .bj-card-suit {
          font-size: 14px;
          margin-top: -2px;
          line-height: 1;
        }
        .bj-card.is-compact .bj-card-suit { font-size: 11px; }
        .bj-card-center {
          align-self: center;
          font-size: 28px;
          line-height: 1;
          opacity: 0.95;
          position: relative;
          z-index: 1;
        }
        .bj-card.is-compact .bj-card-center { font-size: 20px; }
        .bj-shoe {
          flex-shrink: 0;
          width: 118px;
          height: 150px;
          display: flex;
          align-items: flex-end;
          justify-content: flex-end;
          z-index: 2;
          filter: drop-shadow(0 12px 18px rgba(0,0,0,0.5));
        }
        .bj-shoe-shell {
          position: relative;
          width: 108px;
          height: 138px;
          border-radius: 12px 22px 14px 10px / 14px 26px 12px 10px;
          background:
            linear-gradient(155deg,
              rgba(220, 232, 236, 0.28) 0%,
              rgba(130, 155, 165, 0.32) 42%,
              rgba(40, 55, 65, 0.5) 100%);
          border: 1.5px solid rgba(230, 240, 245, 0.5);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.4),
            inset -6px 0 14px rgba(0,0,0,0.28),
            inset 0 -8px 16px rgba(0,0,0,0.22),
            0 2px 0 rgba(255,255,255,0.08);
          transform: rotate(-16deg) perspective(420px) rotateY(-8deg);
          transform-origin: 85% 90%;
          overflow: visible;
        }
        .bj-shoe-glass {
          position: absolute;
          inset: 3px 4px 18px 3px;
          border-radius: 7px 14px 6px 6px;
          background: linear-gradient(180deg,
            rgba(255,255,255,0.14) 0%,
            rgba(255,255,255,0.02) 40%,
            rgba(0,0,0,0.12) 100%);
          border: 1px solid rgba(255,255,255,0.18);
          pointer-events: none;
          z-index: 4;
        }
        .bj-shoe-rail {
          position: absolute;
          right: 3px;
          top: 8px;
          bottom: 16px;
          width: 7px;
          border-radius: 3px;
          background: linear-gradient(180deg,
            rgba(255,255,255,0.25),
            rgba(80,100,110,0.35));
          box-shadow: inset 1px 0 0 rgba(255,255,255,0.3);
          z-index: 5;
        }
        .bj-shoe-bed {
          position: absolute;
          left: 7px;
          right: 12px;
          top: 10px;
          bottom: 22px;
          border-radius: 4px;
          background:
            linear-gradient(165deg, #1a2a24 0%, #0c1814 55%, #08110e 100%);
          box-shadow: inset 0 3px 10px rgba(0,0,0,0.55);
          overflow: visible;
          z-index: 1;
        }
        .bj-shoe-deck {
          position: absolute;
          left: 5px;
          right: 5px;
          bottom: 18px;
          transition: height 0.35s ease;
        }
        .bj-shoe-card {
          position: absolute;
          left: 0;
          right: 0;
          height: 34px;
        }
        .bj-shoe-card-face {
          width: 100%;
          height: 100%;
          border-radius: 3px;
          background:
            repeating-linear-gradient(
              45deg,
              rgba(201, 162, 39, 0.2) 0 1px,
              transparent 1px 6px
            ),
            repeating-linear-gradient(
              -45deg,
              rgba(201, 162, 39, 0.16) 0 1px,
              transparent 1px 6px
            ),
            linear-gradient(145deg, #127A52 0%, #0B4530 48%, #073024 100%);
          border: 1.5px solid ${FELT.gold};
          box-shadow:
            0 1px 0 rgba(255,255,255,0.12) inset,
            0 2px 3px rgba(0,0,0,0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
        }
        .bj-shoe-card-face::before {
          content: "";
          position: absolute;
          inset: 3px;
          border: 1px solid rgba(201,162,39,0.55);
          border-radius: 2px;
          pointer-events: none;
        }
        .bj-shoe-card-motif {
          width: 10px;
          height: 10px;
          transform: rotate(45deg);
          background: ${FELT.gold};
          opacity: 0.9;
          box-shadow: 0 0 0 2px rgba(0,0,0,0.2);
        }
        .bj-shoe-next {
          position: absolute;
          left: 4px;
          right: 4px;
          bottom: 2px;
          height: 40px;
          z-index: 20;
          transform: translateY(6px) rotate(-1deg);
          filter: drop-shadow(0 4px 6px rgba(0,0,0,0.4));
        }
        .bj-shoe-next .bj-shoe-card-face {
          border-radius: 4px;
        }
        .bj-shoe-lip {
          position: absolute;
          left: 4px;
          right: 10px;
          bottom: 10px;
          height: 10px;
          border-radius: 0 0 6px 4px;
          background: linear-gradient(180deg,
            rgba(190,210,220,0.35),
            rgba(90,110,120,0.5));
          border-top: 1px solid rgba(255,255,255,0.25);
          z-index: 6;
          box-shadow: 0 3px 4px rgba(0,0,0,0.3);
        }
        .bj-shoe-badge {
          position: absolute;
          left: 50%;
          bottom: -2px;
          transform: translateX(-50%);
          min-width: 28px;
          padding: 1px 6px;
          border-radius: 999px;
          background: rgba(8, 18, 14, 0.75);
          border: 1px solid color-mix(in srgb, var(--casino-accent) 55%, transparent);
          z-index: 8;
          text-align: center;
        }
        .bj-shoe-badge span {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 12px;
          letter-spacing: 0.06em;
          color: var(--casino-accent, ${FELT.gold});
          font-variant-numeric: tabular-nums;
        }
        .bj-shoe-shuffle .bj-shoe-shell {
          animation: shoeShake 0.45s ease-in-out infinite;
        }
        .bj-shoe-shuffle .bj-shoe-card {
          animation: shoeCardFlutter 0.35s ease-in-out infinite;
        }
        .bj-shoe-riffle {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 25;
        }
        .bj-shoe-riffle-card {
          position: absolute;
          left: 6px;
          right: 6px;
          top: 10px;
          height: 36px;
          animation: shoeCardRiffle 0.7s ease-in-out infinite;
        }
        .bj-dealer-row {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1;
          position: relative;
          min-height: 0;
          align-self: stretch;
        }
        .bj-dealer-row .bj-shoe {
          position: absolute;
          right: 0;
          top: 4px;
          z-index: 3;
        }
        .bj-dealer-hand {
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          height: 100%;
          min-height: 0;
          /* Keep cards clear of the shoe without shifting their center */
          padding: 0 96px;
          box-sizing: border-box;
        }
        .bj-pays-banner {
          z-index: 1;
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          margin: 8px 0;
          pointer-events: none;
          text-align: center;
          min-height: 64px;
          flex-shrink: 0;
          padding: 8px 20px;
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          overflow: visible;
        }
        .bj-table-brand {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(22px, 4.2vw, 40px);
          font-weight: 700;
          letter-spacing: 0.08em;
          line-height: 1.05;
          text-transform: uppercase;
          color: var(--casino-accent, #C9A227);
          text-shadow:
            0 1px 0 rgba(255,255,255,0.12),
            0 2px 0 rgba(0,0,0,0.35),
            0 8px 24px color-mix(in srgb, var(--casino-accent, #C9A227) 35%, transparent);
          width: 100%;
          max-width: 100%;
          padding: 0 8px;
          box-sizing: border-box;
          overflow: visible;
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          hyphens: auto;
        }
        .bj-table-brand-rule {
          width: min(220px, 42vw);
          height: 2px;
          border-radius: 2px;
          background: linear-gradient(
            90deg,
            transparent 0%,
            color-mix(in srgb, var(--casino-accent, #C9A227) 75%, #F0E6D2) 50%,
            transparent 100%
          );
          opacity: 0.85;
          margin: 2px 0 1px;
        }
        .bj-pays-main {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(13px, 3vw, 18px);
          letter-spacing: 0.16em;
          color: rgba(232,223,199,0.72);
          text-shadow: 0 1px 0 rgba(0,0,0,0.35);
          white-space: nowrap;
        }
        .bj-pays-rules {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(10px, 2.4vw, 13px);
          letter-spacing: 0.12em;
          color: rgba(232,223,199,0.45);
          white-space: nowrap;
        }
        .bj-hand {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-width: 96px;
          max-width: 220px;
          flex: 1 1 0;
          padding: 4px;
          background: transparent;
          border: none;
          position: relative;
          z-index: 2;
          height: 100%;
          min-height: 0;
          overflow: visible;
        }
        .bj-hand.is-ghost { opacity: 0.6; }
        .bj-hand.is-waiting {
          opacity: 0.42;
          filter: saturate(0.7);
        }
        .bj-hand.is-active {
          z-index: 4;
          opacity: 1;
          filter: none;
        }
        .bj-hand-active-glow {
          position: absolute;
          inset: -4px -2px -2px;
          border-radius: 16px;
          border: 1.5px solid color-mix(in srgb, var(--casino-accent, #C9A227) 70%, #F0E6D2);
          background:
            radial-gradient(
              ellipse at 50% 70%,
              color-mix(in srgb, var(--casino-accent, #C9A227) 28%, transparent) 0%,
              transparent 68%
            );
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.25),
            0 0 18px color-mix(in srgb, var(--casino-accent, #C9A227) 35%, transparent);
          pointer-events: none;
          z-index: 0;
          animation: bjActivePulse 1.6s ease-in-out infinite;
        }
        @keyframes bjActivePulse {
          0%, 100% { opacity: 0.75; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.015); }
        }
        .bj-chip-spot,
        .bj-chip-spot-ph {
          overflow: visible;
          flex-shrink: 0;
        }
        .bj-bet-stack {
          overflow: visible;
        }
        .bj-hand-dealer .bj-cards,
        .bj-hand-player .bj-cards {
          min-height: 92px !important;
          height: 92px;
        }
        .bj-hand-player .bj-cards {
          margin-bottom: 2px;
        }
        .bj-hand-player .bj-hand-total {
          margin-top: 2px;
        }
        .bj-outcome-ph {
          height: 28px;
          min-height: 28px;
          width: 1px;
          visibility: hidden;
          pointer-events: none;
        }
        .bj-outcome-banner {
          min-height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .bj-chip-spot-ph {
          display: block;
        }
        .bj-hand.is-active .bj-hand-label {
          color: #F0E6D2;
        }
        .bj-hand.is-active .bj-hand-total {
          background: color-mix(in srgb, var(--casino-accent, #C9A227) 28%, rgba(5, 24, 18, 0.82));
          border: 1px solid color-mix(in srgb, var(--casino-accent, #C9A227) 75%, transparent);
          box-shadow: 0 0 12px color-mix(in srgb, var(--casino-accent, #C9A227) 30%, transparent);
        }
        .bj-hand-turn {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 11px;
          letter-spacing: 0.16em;
          color: #1A1205;
          background: var(--casino-accent, #C9A227);
          border-radius: 4px;
          padding: 1px 6px 0;
          line-height: 1.35;
          margin-left: 2px;
        }
        .bj-hand-total {
          display: flex;
          align-items: center;
          gap: 6px;
          position: relative;
          z-index: 3;
          padding: 2px 8px;
          border-radius: 8px;
          background: rgba(5, 24, 18, 0.55);
          backdrop-filter: blur(2px);
          border: 1px solid transparent;
        }
        .bj-hand-label {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 13px;
          letter-spacing: 0.16em;
          color: rgba(232,223,199,0.55);
        }
        .bj-hand-score {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          letter-spacing: 0.04em;
          color: var(--casino-accent, #C9A227);
          min-width: 20px;
          text-align: center;
          text-shadow: 0 1px 2px rgba(0,0,0,0.4);
          font-variant-numeric: tabular-nums;
        }
        .bj-bet-amount {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 14px;
          letter-spacing: 1.5px;
          color: var(--casino-accent, #C9A227);
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
          line-height: 1;
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation: none !important; transition: none !important; }
        }
        button:focus-visible {
          outline: 2px solid #C9A227;
          outline-offset: 2px;
        }
        .bj-shell {
          width: min(1080px, 100%);
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
        }
        .bj-title,
        .bj-casino-tag {
          display: none;
        }
        .bj-controls-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          width: 100%;
          min-width: 0;
        }
        .bj-casino-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          max-width: min(100%, 440px);
          padding: 3px 3px 3px 10px;
          border-radius: 999px;
          border: 1px solid color-mix(in srgb, var(--casino-accent, #C9A227) 35%, rgba(232,223,199,0.22));
          background: rgba(0,0,0,0.22);
        }
        .bj-casino-pill-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          letter-spacing: 0.02em;
          color: rgba(232,223,199,0.72);
        }
        .bj-casino-pill-name {
          color: var(--casino-accent, #C9A227);
          font-weight: 600;
        }
        .bj-casino-change {
          border: 1px solid color-mix(in srgb, var(--casino-accent) 55%, transparent);
          background: rgba(0,0,0,0.22);
          color: rgba(232,223,199,0.85);
          border-radius: 999px;
          width: 28px;
          height: 28px;
          padding: 0;
          font-size: 14px;
          line-height: 1;
          cursor: pointer;
          font-family: inherit;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .bj-casino-change:disabled {
          opacity: 0.35;
          cursor: default;
        }
        .bj-casino-change:hover:not(:disabled) {
          border-color: var(--casino-accent);
          color: #F0E6D2;
          background: color-mix(in srgb, var(--casino-accent) 18%, transparent);
        }
        .bj-settings-gear {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          border: 1px solid rgba(232,223,199,0.35);
          background: transparent;
          color: rgba(232,223,199,0.75);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex-shrink: 0;
          padding: 0;
        }
        .bj-settings-gear:hover:not(:disabled) {
          border-color: var(--casino-accent);
          color: #F0E6D2;
          background: color-mix(in srgb, var(--casino-accent) 18%, transparent);
        }
        .bj-settings-gear:disabled { opacity: 0.35; cursor: default; }
        .bj-settings-overlay {
          position: fixed;
          inset: 0;
          z-index: 90;
          background: rgba(4, 16, 12, 0.72);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px 12px;
        }
        .bj-settings-panel {
          width: min(420px, 100%);
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 18px 16px 16px;
          border-radius: 18px;
          border: 1.5px solid rgba(232,223,199,0.28);
          background: radial-gradient(ellipse at 50% 0%, #0B4530 0%, #073024 55%, #052018 100%);
          box-shadow: 0 20px 50px rgba(0,0,0,0.5);
          font-family: 'Inter', sans-serif;
        }
        .bj-settings-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .bj-settings-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 28px;
          letter-spacing: 0.14em;
          color: #F0E6D2;
        }
        .bj-settings-sub {
          color: rgba(232,223,199,0.6);
          font-size: 12px;
          margin-top: 2px;
        }
        .bj-settings-close {
          border: 1px solid rgba(232,223,199,0.35);
          background: transparent;
          color: rgba(232,223,199,0.75);
          border-radius: 999px;
          width: 36px;
          height: 36px;
          font-size: 18px;
          cursor: pointer;
          line-height: 1;
        }
        .bj-settings-section { display: flex; flex-direction: column; gap: 8px; }
        .bj-settings-section.is-locked { opacity: 0.45; }
        .bj-settings-label {
          font-family: 'Bebas Neue', sans-serif;
          letter-spacing: 0.12em;
          font-size: 14px;
          color: rgba(232,223,199,0.7);
        }
        .bj-settings-seg {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .bj-settings-seg-btn {
          flex: 1 1 0;
          min-width: 56px;
          padding: 10px 8px;
          border-radius: 10px;
          border: 1.5px solid rgba(232,223,199,0.28);
          background: rgba(5,32,24,0.72);
          color: rgba(232,223,199,0.75);
          font-family: 'Bebas Neue', sans-serif;
          letter-spacing: 0.1em;
          font-size: 16px;
          cursor: pointer;
        }
        .bj-settings-seg-btn.is-on {
          border-color: var(--casino-accent, #C9A227);
          color: #1A1A1A;
          background: var(--casino-accent, #C9A227);
        }
        .bj-settings-seg-btn:disabled { cursor: default; }
        .bj-settings-decks .bj-settings-seg-btn { flex: 0 0 calc(20% - 5px); min-width: 0; }
        .bj-settings-hint {
          color: rgba(232,223,199,0.5);
          font-size: 12px;
          line-height: 1.4;
        }
        .bj-settings-restart {
          margin-top: 4px;
          width: 100%;
          padding: 12px;
          border: none;
          border-radius: 10px;
          font-family: 'Bebas Neue', sans-serif;
          letter-spacing: 0.14em;
          font-size: 18px;
          background: #E8DFC7;
          color: #1A1A1A;
          cursor: pointer;
          box-shadow: 0 4px 0 #A89870;
        }
        .bj-settings-restart:disabled {
          opacity: 0.45;
          cursor: default;
          box-shadow: none;
          transform: translateY(4px);
        }
        .bj-auto-toggle {
          flex: 0 0 auto;
          min-width: 72px;
          padding: 12px 14px;
          font-family: 'Bebas Neue', sans-serif;
          font-size: 16px;
          letter-spacing: 2px;
          color: rgba(232,223,199,0.75);
          background: transparent;
          border: 1.5px solid rgba(232,223,199,0.35);
          border-radius: 10px;
          cursor: pointer;
        }
        .bj-select-chip-ring {
          position: absolute;
          inset: 2px;
          border-radius: 50%;
          border: 2.5px solid var(--casino-accent, #C9A227);
          box-shadow: 0 0 10px color-mix(in srgb, var(--casino-accent, #C9A227) 45%, transparent);
          pointer-events: none;
          z-index: 2;
        }
        .bj-bet-targets {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .bj-bet-target {
          flex: 1 1 0;
          min-width: 72px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 1px;
          padding: 6px 8px 5px;
          border-radius: 8px;
          border: 1px solid rgba(232,223,199,0.28);
          background: rgba(0,0,0,0.18);
          color: rgba(232,223,199,0.7);
          cursor: pointer;
          font-family: inherit;
        }
        .bj-bet-target.is-on {
          border-color: var(--casino-accent, #C9A227);
          background: color-mix(in srgb, var(--casino-accent, #C9A227) 18%, rgba(0,0,0,0.2));
          color: #F0E6D2;
        }
        .bj-bet-target-label {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 13px;
          letter-spacing: 0.12em;
        }
        .bj-bet-target-amt {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 16px;
          letter-spacing: 0.04em;
          color: var(--casino-accent, #C9A227);
        }
        .bj-side-stack {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }
        .bj-side-tag {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: rgba(232,223,199,0.75);
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(201,162,39,0.45);
          border-radius: 4px;
          padding: 0 4px;
          line-height: 1.4;
        }
        .bj-auto-toggle.is-on {
          color: #1A1205;
          background: linear-gradient(180deg, #C9A227 0%, #A8861A 100%);
          border-color: #C9A227;
        }
        .bj-analytics-panel {
          width: min(460px, 100%);
          max-height: min(92dvh, 720px);
          overflow: auto;
        }
        .bj-analytics-meta {
          font-size: 12px;
          color: rgba(232,223,199,0.55);
          letter-spacing: 0.02em;
        }
        .bj-analytics-hero {
          text-align: center;
          padding: 10px 8px 14px;
          border-radius: 12px;
          border: 1px solid rgba(232,223,199,0.18);
          background: rgba(0,0,0,0.18);
        }
        .bj-analytics-hero-label {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 13px;
          letter-spacing: 0.18em;
          color: rgba(232,223,199,0.55);
        }
        .bj-analytics-hero-value {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 42px;
          letter-spacing: 0.04em;
          line-height: 1.05;
          margin-top: 4px;
        }
        .bj-analytics-hero-bank {
          margin-top: 4px;
          font-size: 13px;
          color: rgba(232,223,199,0.6);
          font-variant-numeric: tabular-nums;
        }
        .bj-analytics-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .bj-analytics-cell {
          padding: 10px 10px 8px;
          border-radius: 10px;
          border: 1px solid rgba(232,223,199,0.14);
          background: rgba(0,0,0,0.14);
        }
        .bj-analytics-cell-label {
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: rgba(232,223,199,0.5);
        }
        .bj-analytics-cell-value {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          letter-spacing: 0.04em;
          color: #F0E6D2;
          margin-top: 2px;
        }
        .bj-shuffle-overlay,
        .bj-cut-overlay {
          position: fixed;
          inset: 0;
          z-index: 95;
          background: rgba(4, 16, 12, 0.78);
          backdrop-filter: blur(7px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .bj-shuffle-panel,
        .bj-cut-panel {
          width: min(520px, 100%);
          padding: 22px 18px 18px;
          border-radius: 18px;
          border: 1.5px solid rgba(232,223,199,0.28);
          background: radial-gradient(ellipse at 50% 0%, #0B4530 0%, #073024 55%, #052018 100%);
          box-shadow: 0 20px 50px rgba(0,0,0,0.55);
          text-align: center;
        }
        .bj-shuffle-title,
        .bj-cut-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(28px, 7vw, 36px);
          letter-spacing: 0.16em;
          color: #F0E6D2;
        }
        .bj-shuffle-sub,
        .bj-cut-sub {
          color: rgba(232,223,199,0.65);
          font-size: 13px;
          margin: 6px 0 18px;
          font-family: 'Inter', sans-serif;
        }
        .bj-shuffle-decks {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          justify-content: center;
          min-height: 110px;
          align-items: center;
        }
        .bj-shuffle-deck {
          position: relative;
          width: 54px;
          height: 78px;
        }
        .bj-shuffle-half {
          position: absolute;
          width: 42px;
          height: 58px;
          border-radius: 5px;
          border: 1.5px solid #C9A227;
          background:
            linear-gradient(145deg, #0E5A3F 0%, #09402C 55%, #073024 100%);
          box-shadow: 0 6px 12px rgba(0,0,0,0.4);
        }
        .bj-shuffle-half-l { left: 0; top: 8px; }
        .bj-shuffle-half-r { right: 0; top: 8px; }
        .bj-shuffle-deck.is-riffle .bj-shuffle-half-l {
          animation: bjRiffleL 0.65s ease-in-out 4 alternate;
        }
        .bj-shuffle-deck.is-riffle .bj-shuffle-half-r {
          animation: bjRiffleR 0.65s ease-in-out 4 alternate;
        }
        .bj-shuffle-deck.is-stack .bj-shuffle-half-l,
        .bj-shuffle-deck.is-stack .bj-shuffle-half-r {
          animation: bjStackIn 0.55s ease-out both;
          left: 6px;
          right: auto;
        }
        .bj-shuffle-deck-label {
          position: absolute;
          left: 0;
          right: 0;
          bottom: -2px;
          font-family: 'Bebas Neue', sans-serif;
          font-size: 12px;
          letter-spacing: 0.08em;
          color: rgba(232,223,199,0.55);
        }
        @keyframes bjRiffleL {
          from { transform: translate(-8px, 4px) rotate(-10deg); }
          to { transform: translate(4px, -6px) rotate(-2deg); }
        }
        @keyframes bjRiffleR {
          from { transform: translate(8px, -2px) rotate(10deg); }
          to { transform: translate(-2px, 6px) rotate(2deg); }
        }
        @keyframes bjStackIn {
          from { transform: translateY(-18px) scale(0.92); opacity: 0.5; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        .bj-cut-deck {
          position: relative;
          height: 120px;
          margin: 8px 0 18px;
          border-radius: 14px;
          cursor: crosshair;
          touch-action: manipulation;
          overflow: hidden;
          border: 1.5px solid rgba(232,223,199,0.22);
          background: radial-gradient(ellipse at 50% 60%, #0a3d2c 0%, #041810 75%);
          box-shadow: inset 0 0 40px rgba(0,0,0,0.45);
        }
        .bj-cut-deck:focus-visible {
          outline: 2px solid var(--casino-accent, #C9A227);
          outline-offset: 2px;
        }
        .bj-cut-deck-felt {
          position: absolute;
          inset: 0;
          opacity: 0.35;
          background:
            repeating-linear-gradient(
              90deg,
              transparent 0 6px,
              rgba(0,0,0,0.08) 6px 7px
            );
          pointer-events: none;
        }
        .bj-cut-spine {
          position: absolute;
          width: 38px;
          height: 64px;
          margin-left: -19px;
          border-radius: 4px;
          border: 1.5px solid rgba(201,162,39,0.55);
          background:
            linear-gradient(145deg, #127a52 0%, #0a4a32 48%, #062a1c 100%);
          box-shadow:
            1px 0 0 rgba(0,0,0,0.35),
            0 4px 8px rgba(0,0,0,0.3);
          pointer-events: none;
        }
        .bj-cut-spine::after {
          content: "";
          position: absolute;
          inset: 5px 6px;
          border: 1px solid rgba(201,162,39,0.35);
          border-radius: 2px;
          opacity: 0.7;
        }
        .bj-cut-wedge {
          position: absolute;
          top: 8px;
          width: 14px;
          height: 88px;
          margin-left: -7px;
          z-index: 80;
          border-radius: 3px;
          background: linear-gradient(180deg, #F8ECC0 0%, #C9A227 42%, #8F7014 100%);
          box-shadow:
            0 0 14px rgba(201,162,39,0.55),
            0 6px 12px rgba(0,0,0,0.45);
          pointer-events: none;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: left 0.05s linear;
        }
        .bj-cut-wedge.is-set {
          box-shadow:
            0 0 18px rgba(201,162,39,0.75),
            0 6px 14px rgba(0,0,0,0.5);
        }
        .bj-cut-wedge-label {
          writing-mode: vertical-rl;
          transform: rotate(180deg);
          font-family: 'Bebas Neue', sans-serif;
          font-size: 11px;
          letter-spacing: 0.14em;
          color: rgba(26,26,26,0.85);
        }
        .bj-cut-hint {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Inter', sans-serif;
          font-size: 13px;
          color: rgba(240,230,210,0.55);
          pointer-events: none;
          z-index: 90;
          text-shadow: 0 1px 3px rgba(0,0,0,0.6);
        }
        .bj-cut-confirm {
          width: 100%;
          padding: 12px;
          border: none;
          border-radius: 10px;
          font-family: 'Bebas Neue', sans-serif;
          letter-spacing: 0.16em;
          font-size: 20px;
          background: #C9A227;
          color: #1A1A1A;
          cursor: pointer;
          box-shadow: 0 4px 0 #8A6E1B;
        }
        .bj-cut-confirm:disabled {
          opacity: 0.4;
          cursor: default;
          box-shadow: none;
          transform: translateY(4px);
        }
        .bj-table {
          width: 100%;
          flex: 1 1 auto;
          height: auto;
          min-height: 0;
          max-height: none;
          background: transparent;
          border-radius: 28px 28px 120px 120px / 24px 24px 78px 78px;
          border: 14px solid #4A2F1A;
          box-shadow:
            0 22px 48px rgba(0,0,0,0.55),
            0 0 0 1px rgba(232,223,199,0.08),
            inset 0 0 0 1px rgba(0,0,0,0.35);
          padding: clamp(12px, 2vw, 22px) clamp(10px, 3.5vw, 34px) clamp(28px, 4.5vw, 48px);
          position: relative;
          display: grid;
          grid-template-rows: minmax(120px, 0.9fr) auto minmax(200px, 1.35fr);
          align-items: center;
          justify-items: center;
          gap: 16px;
          overflow: visible;
          box-sizing: border-box;
        }
        .bj-table-felt {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: radial-gradient(ellipse at 50% 40%, var(--felt-1) 0%, var(--felt-2) 55%, var(--felt-3) 100%);
          box-shadow: inset 0 0 70px rgba(0,0,0,0.28), inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 25%, transparent);
          pointer-events: none;
          z-index: 0;
          overflow: hidden;
          transition: background 0.55s ease;
        }
        .bj-rail {
          position: absolute;
          inset: 8px;
          border-radius: 24px 24px 120px 120px / 20px 20px 80px 80px;
          border: 1.5px dashed rgba(232,223,199,0.35);
          pointer-events: none;
        }
        .bj-dealer {
          width: min(100%, 340px);
          display: flex;
          justify-content: center;
        }
        .bj-banner {
          display: none;
        }
        .bj-player-zone {
          width: 100%;
          height: 100%;
          min-height: 0;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          gap: 4px;
          padding: 8px 4px 10px;
          align-self: stretch;
          overflow: visible;
        }
        .bj-seats-wrap {
          width: 100%;
          height: 100%;
          overflow: visible;
          padding: 10px 0 6px;
          display: flex;
          align-items: flex-end;
          -webkit-overflow-scrolling: touch;
        }
        .bj-seats-wrap.is-scroll {
          overflow-x: auto;
        }
        .bj-seats {
          display: flex;
          gap: 18px;
          align-items: flex-end;
          justify-content: center;
          min-width: 100%;
          height: 100%;
          padding: 8px 4px;
          overflow: visible;
        }
        .bj-seat-player,
        .bj-seat-dealer {
          transform: none;
        }
        .bj-controls {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px 10px;
          border: 1.5px solid rgba(232,223,199,0.35);
          border-radius: 14px;
          background: rgba(5,32,24,0.72);
          overflow: visible;
          flex-shrink: 0;
        }
        .bj-controls-top {
          overflow: visible;
          padding: 4px 2px 2px;
        }
        .bj-actions {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .bj-action-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        @media (max-width: 640px) {
          .bj-page {
            height: 100dvh !important;
            min-height: 100dvh !important;
            max-height: 100dvh !important;
            padding: 4px 4px calc(4px + env(safe-area-inset-bottom, 0px)) !important;
            align-items: stretch !important;
            overflow: hidden !important;
          }
          .bj-shell {
            width: 100%;
            height: 100%;
            min-height: 0;
            flex: 1 1 auto;
            gap: 4px;
            align-items: stretch;
            justify-content: flex-start;
          }
          .bj-title,
          .bj-casino-tag {
            display: none;
          }
          .bj-controls-meta {
            gap: 6px;
          }
          .bj-casino-pill {
            max-width: 100%;
            padding: 2px 2px 2px 8px;
          }
          .bj-casino-pill-text { font-size: 11px; }
          .bj-casino-change,
          .bj-settings-gear { width: 26px; height: 26px; font-size: 12px; }
          .bj-table {
            flex: 1 1 auto;
            width: 100%;
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            border-radius: 14px 14px 36px 36px;
            border-width: 6px;
            padding: 8px 6px 18px;
            gap: 10px;
            overflow: hidden;
            grid-template-rows: minmax(0, 0.85fr) auto minmax(0, 1.45fr);
            align-self: stretch;
            box-shadow:
              0 12px 28px rgba(0,0,0,0.5),
              0 0 0 1px rgba(232,223,199,0.06);
          }
          .bj-rail {
            border-radius: 10px 10px 28px 28px;
            inset: 3px;
          }
          .bj-dealer-row {
            min-height: 0;
            height: 100%;
            width: 100%;
            align-self: stretch;
          }
          .bj-dealer-hand {
            padding: 0 64px;
            height: 100%;
          }
          .bj-dealer-row .bj-shoe {
            top: 2px;
            right: 2px;
            transform: none;
          }
          .bj-pays-banner { margin: 6px 0; gap: 3px; min-height: 52px; flex-shrink: 0; padding: 6px 12px; width: 100%; }
          .bj-table-brand {
            font-size: clamp(18px, 5vw, 28px);
            letter-spacing: 0.06em;
          }
          .bj-table-brand-rule { width: min(160px, 48vw); margin: 1px 0; }
          .bj-pays-main {
            font-size: 12px;
            letter-spacing: 0.1em;
          }
          .bj-pays-rules {
            font-size: 10px;
            letter-spacing: 0.08em;
          }
          .bj-player-zone {
            padding: 4px 2px 6px;
            min-height: 0;
          }
          .bj-seats-wrap {
            padding: 4px 0 2px;
            min-height: 0;
            overflow: visible;
          }
          .bj-seats-wrap.is-scroll {
            overflow-x: auto;
          }
          .bj-seats { gap: 6px; min-height: 0; }
          .bj-hand {
            min-width: 0 !important;
            max-width: none !important;
            flex: 1 1 auto !important;
            gap: 4px;
            padding: 2px;
          }
          .bj-hand-dealer .bj-cards,
          .bj-hand-player .bj-cards {
            min-height: 108px !important;
            height: 108px !important;
          }
          .bj-outcome-ph,
          .bj-outcome-banner {
            min-height: 22px;
            height: 22px;
          }
          .bj-hand-total {
            padding: 1px 6px;
            gap: 4px;
          }
          .bj-hand-label { font-size: 11px; letter-spacing: 0.1em; }
          .bj-hand-score { font-size: 18px; }
          .bj-chip-spot,
          .bj-chip-spot-ph {
            width: 72px !important;
            min-width: 72px !important;
            min-height: 96px !important;
          }
          .bj-controls {
            flex-shrink: 0;
            padding: 8px 8px 8px !important;
            overflow: visible !important;
            border-radius: 12px;
            gap: 6px;
          }
          .bj-controls-top {
            padding: 2px 2px 0 !important;
            overflow: visible !important;
            gap: 6px !important;
          }
          .bj-card { width: 76px !important; height: 108px !important; }
          .bj-card.is-compact { width: 62px !important; height: 88px !important; }
          .bj-card-front { padding: 5px 6px !important; }
          .bj-card-rank { font-size: 20px !important; }
          .bj-card.is-compact .bj-card-rank { font-size: 16px !important; }
          .bj-card-suit { font-size: 13px !important; }
          .bj-card.is-compact .bj-card-suit { font-size: 11px !important; }
          .bj-card-center { font-size: 30px !important; }
          .bj-card.is-compact .bj-card-center { font-size: 22px !important; }
          .bj-card-back-inner { width: 48%; height: 56%; }
          .bj-card-back-motif { width: 11px; height: 11px; }
          .bj-cards {
            min-height: 108px !important;
            padding-left: 0 !important;
          }
          .bj-cards > div {
            margin-left: -28px !important;
          }
          .bj-cards > div:first-child {
            margin-left: 0 !important;
          }
          .bj-shoe { width: 96px; height: 124px; }
          .bj-shoe-shell { width: 88px; height: 114px; }
          .bj-shoe-next { height: 34px; }
          .bj-shoe-card { height: 38px; }
          .bj-select-chip {
            width: auto !important;
            height: auto !important;
            overflow: visible !important;
          }
          .bj-select-chip-face {
            width: 52px !important;
            height: 52px !important;
          }
          .bj-select-chip-face svg {
            width: 52px !important;
            height: 52px !important;
          }
          .bj-bank-label { font-size: 10px !important; margin-bottom: 0 !important; }
          .bj-bank-value { font-size: 20px !important; }
          .bj-hands-row { gap: 6px !important; }
          .bj-hands-label { font-size: 12px !important; }
          .bj-hands-btn {
            width: 30px !important;
            height: 30px !important;
            font-size: 18px !important;
          }
          .bj-hands-count { font-size: 22px !important; min-width: 28px !important; }
          .bj-action-row { gap: 6px; }
          .bj-action-row > button {
            flex: 1 1 calc(25% - 6px);
            min-width: 0;
            padding: 10px 0 !important;
            font-size: 14px !important;
            letter-spacing: 1px !important;
          }
          .bj-action-row > .bj-auto-toggle {
            flex: 0 0 auto;
            min-width: 64px;
            padding: 10px 12px !important;
          }
          .bj-footer-note { display: none; }
        }
        @media (max-width: 640px) and (max-height: 700px) {
          .bj-pays-rules { display: none; }
          .bj-pays-banner { min-height: 48px; }
          .bj-table-brand { font-size: clamp(20px, 6.5vw, 28px); }
          .bj-pays-main { font-size: 11px; }
          .bj-card { width: 68px !important; height: 96px !important; }
          .bj-card.is-compact { width: 56px !important; height: 80px !important; }
          .bj-card-rank { font-size: 18px !important; }
          .bj-card.is-compact .bj-card-rank { font-size: 15px !important; }
          .bj-card-center { font-size: 26px !important; }
          .bj-card.is-compact .bj-card-center { font-size: 20px !important; }
          .bj-hand-dealer .bj-cards,
          .bj-hand-player .bj-cards,
          .bj-cards {
            min-height: 96px !important;
            height: 96px !important;
          }
          .bj-chip-spot,
          .bj-chip-spot-ph {
            width: 64px !important;
            min-width: 64px !important;
            min-height: 76px !important;
          }
          .bj-select-chip {
            width: auto !important;
            height: auto !important;
            padding: 6px !important;
            overflow: visible !important;
          }
          .bj-select-chip-face {
            width: 48px !important;
            height: 48px !important;
          }
          .bj-select-chip-face svg {
            width: 48px !important;
            height: 48px !important;
          }
        }
      `}</style>

      <div className="bj-shell">
        <div className="bj-table">
          <div className="bj-table-felt" aria-hidden />
          <div className="bj-rail" aria-hidden />

          <div className="bj-dealer-row">
            <div className="bj-dealer-hand">
              <FeltHand
                role="dealer"
                label="DEALER"
                cards={showTable ? dealerCards : []}
                totalLabel={showTable ? dealerTotal : "—"}
                active={phase === "dealer"}
                status="active"
                compact={compact}
              />
            </div>
            <DealerShoe
              remaining={shoeRemaining}
              total={shoeSize}
              shuffling={shuffling || shuffleStage === "riffling" || shuffleStage === "stacking"}
            />
          </div>

          <div className="bj-pays-banner" aria-hidden>
            <div className="bj-table-brand">{casino.name}</div>
            <div className="bj-table-brand-rule" />
            <div className="bj-pays-main">
              BLACKJACK PAYS {bjPayout === "6:5" ? "6 TO 5" : "3 TO 2"}
            </div>
            <div className="bj-pays-rules">
              {hitSoft17
                ? "DEALER HITS SOFT 17"
                : "DEALER MUST STAND ON ALL 17s"}
              {sideBetsEnabled ? " · PAIRS · 21+3" : ""}
            </div>
          </div>

          <div className="bj-player-zone">
            <div className={`bj-seats-wrap${manySeats ? " is-scroll" : ""}`}>
              <div
                className="bj-seats"
                data-count={seatCount}
                style={{
                  width: manySeats ? "max-content" : "100%",
                  margin: manySeats ? "0 auto" : undefined,
                }}
              >
                {showTable
                  ? hands.map((h, i) => {
                      const ev = evaluateHand(h.cards);
                      const displayLabel =
                        hands.length === 1 ? "YOU" : `H${i + 1}`;
                      const isActiveHand =
                        phase === "player" && i === activeHandIndex;
                      const isWaitingHand =
                        phase === "player" &&
                        hands.length > 1 &&
                        i !== activeHandIndex;
                      return (
                        <FeltHand
                          key={h.id}
                          role="player"
                          label={displayLabel}
                          cards={h.cards}
                          totalLabel={h.cards.length ? String(ev.total) : "—"}
                          bet={h.bet}
                          sideBets={h.sideBets}
                          sideResults={h.sideResults}
                          sideChipFly={sideChipFly}
                          active={isActiveHand}
                          waiting={isWaitingHand}
                          status={h.status}
                          outcome={phase === "settle" ? h.outcome : null}
                          flash={h.flash || null}
                          payoutAmount={h.payoutAmount || 0}
                          chipFly={
                            phase === "settle" ? flyForHand(h.status) : "idle"
                          }
                          compact={compact || hands.length > 2}
                          casinoName={casino.name}
                        />
                      );
                    })
                  : Array.from({ length: handCount }, (_, i) => (
                      <FeltHand
                        key={`seat-${i}`}
                        role="player"
                        label={handCount === 1 ? "YOU" : `H${i + 1}`}
                        cards={[]}
                        totalLabel="—"
                        bet={betAmount}
                        sideBets={
                          sideBetsEnabled
                            ? {
                                pairs: sideBetPairs,
                                twentyOnePlus3: sideBet213,
                              }
                            : null
                        }
                        active={false}
                        status="active"
                        compact={handCount >= 3}
                        ghost
                        casinoName={casino.name}
                      />
                    ))}
              </div>
            </div>
          </div>
        </div>

        <div className="bj-controls">
          <div className="bj-controls-meta">
            <div className="bj-casino-pill">
              <div className="bj-casino-pill-text" title={`${casino.name} · ${casino.city}, ${casino.abbr}`}>
                <span className="bj-casino-pill-name">{casino.name}</span>
                {" · "}
                {casino.city}, {casino.abbr}
              </div>
              <button
                type="button"
                className="bj-casino-change"
                disabled={phase !== "betting" || shuffling || shuffleStage !== "idle"}
                onClick={openCasinoPicker}
                aria-label="Switch casino"
                title="Switch casino"
              >
                ⇄
              </button>
              <button
                type="button"
                className="bj-settings-gear"
                disabled={shuffleStage !== "idle"}
                onClick={() => setSettingsOpen(true)}
                aria-label="Table settings"
                title="Table settings"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                  <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.6.24-1.14.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.49.39 1.03.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.6-.24 1.14-.55 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
                </svg>
              </button>
            </div>
          </div>
          <div
            className="bj-controls-top"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                minWidth: 0,
                flex: 1,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: 13,
                    letterSpacing: 1.5,
                    color: "rgba(232,223,199,0.55)",
                  }}
                >
                  MIN ${casino.minBet}
                  <span style={{ opacity: 0.55 }}> · </span>
                  MAX ${casino.maxBet.toLocaleString()}
                </span>
                {phase === "betting" && (
                  <button
                    type="button"
                    onClick={clearBet}
                    disabled={activeSideAmount === 0}
                    style={{
                      fontFamily: "'Bebas Neue', sans-serif",
                      fontSize: 12,
                      letterSpacing: 1.5,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${FELT.markDim}`,
                      background: "transparent",
                      color: FELT.mark,
                      cursor: activeSideAmount === 0 ? "default" : "pointer",
                      opacity: activeSideAmount === 0 ? 0.35 : 0.85,
                    }}
                  >
                    CLEAR
                  </button>
                )}
                <span
                  style={{
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: 18,
                    letterSpacing: 1,
                    color: FELT.gold,
                    marginLeft: "auto",
                  }}
                >
                  TOTAL ${totalStake.toLocaleString()}
                </span>
              </div>
              {phase === "betting" && sideBetsEnabled && (
                <div className="bj-bet-targets" role="tablist" aria-label="Bet target">
                  {SIDE_BET_TARGETS.map((t) => {
                    const amount =
                      t.id === "main"
                        ? betAmount
                        : t.id === "pairs"
                          ? sideBetPairs
                          : sideBet213;
                    const on = betTarget === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        className={`bj-bet-target${on ? " is-on" : ""}`}
                        onClick={() => setBetTarget(t.id)}
                        title={t.hint}
                      >
                        <span className="bj-bet-target-label">{t.label}</span>
                        <span className="bj-bet-target-amt">${amount}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div
                className="bj-chip-tray"
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                  padding: "6px 2px",
                  overflow: "visible",
                }}
              >
                {tableChips.map((c) => {
                  const target = sideBetsEnabled ? betTarget : "main";
                  const nextMain =
                    target === "main" ? betAmount + c.value : betAmount;
                  const nextPairs =
                    target === "pairs" ? sideBetPairs + c.value : sideBetPairs;
                  const nextPlus3 =
                    target === "twentyOnePlus3"
                      ? sideBet213 + c.value
                      : sideBet213;
                  const nextTargetAmt =
                    target === "pairs"
                      ? nextPairs
                      : target === "twentyOnePlus3"
                        ? nextPlus3
                        : nextMain;
                  const nextPerHand = nextMain + nextPairs + nextPlus3;
                  const wouldExceedMax = nextTargetAmt > casino.maxBet;
                  const wouldExceedBank = nextPerHand * handCount > bank;
                  const chipDisabled =
                    phase !== "betting" || wouldExceedMax || wouldExceedBank;
                  return (
                    <Chip
                      key={c.value}
                      {...c}
                      size={64}
                      casinoName={casino.name}
                      selected={lastChip === c.value && activeSideAmount > 0}
                      disabled={chipDisabled}
                      onClick={() => addChipToBet(c.value)}
                    />
                  );
                })}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div
                className="bj-bank-label"
                style={{
                  fontSize: 11,
                  color: "rgba(232,223,199,0.5)",
                  letterSpacing: 1,
                  marginBottom: 2,
                }}
              >
                BANK
              </div>
              <div
                className="bj-bank-value"
                style={{
                  fontFamily: "'Bebas Neue', sans-serif",
                  fontSize: 26,
                  color: FELT.mark,
                  letterSpacing: 1,
                }}
              >
                ${bank.toLocaleString()}
              </div>
            </div>
          </div>

          {phase === "betting" ? (
            <div
              className="bj-hands-row"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  className="bj-hands-label"
                  style={{
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: 14,
                    letterSpacing: 2,
                    color: "rgba(232,223,199,0.55)",
                  }}
                >
                  HANDS
                </span>
                <button
                  type="button"
                  className="bj-hands-btn"
                  disabled={handCount <= 1}
                  onClick={() => {
                    if (handCount > 1) setHandCount((n) => n - 1);
                  }}
                  aria-label="Fewer hands"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    border: `1.5px solid ${FELT.markDim}`,
                    background: "transparent",
                    color: FELT.mark,
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: 22,
                    cursor: handCount <= 1 ? "default" : "pointer",
                    opacity: handCount <= 1 ? 0.35 : 1,
                  }}
                >
                  −
                </button>
                <span
                  className="bj-hands-count"
                  style={{
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: 28,
                    color: FELT.gold,
                    minWidth: 36,
                    textAlign: "center",
                    letterSpacing: 1,
                  }}
                >
                  {handCount}
                </span>
                <button
                  type="button"
                  className="bj-hands-btn"
                  disabled={handCount >= maxAffordableHands}
                  onClick={() => {
                    if (handCount < maxAffordableHands) {
                      setHandCount((n) => n + 1);
                    }
                  }}
                  aria-label="More hands"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    border: `1.5px solid ${FELT.markDim}`,
                    background: "transparent",
                    color: FELT.mark,
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: 22,
                    cursor:
                      handCount >= maxAffordableHands ? "default" : "pointer",
                    opacity: handCount >= maxAffordableHands ? 0.35 : 1,
                  }}
                >
                  +
                </button>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(232,223,199,0.55)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                Total ${totalStake}
                {sideBetsEnabled && (sideBetPairs || sideBet213)
                  ? ` · main $${betAmount}${sideBetPairs ? ` · pairs $${sideBetPairs}` : ""}${sideBet213 ? ` · 21+3 $${sideBet213}` : ""}`
                  : ""}
                {shoeRemaining <= reshuffleAtRef.current + 20 ? " · shoe low" : ""}
              </div>
            </div>
          ) : null}

        <div className="bj-actions">
          {phase === "betting" && (
            <div className="bj-action-row" style={{ width: "100%", gap: 8 }}>
              <ActionButton
                label={shuffling ? "SHUFFLING…" : "DEAL"}
                primary
                disabled={!canAffordDeal}
                onClick={handleDeal}
              />
              <button
                type="button"
                className={`bj-auto-toggle${autoDeal ? " is-on" : ""}`}
                onClick={() => setAutoDeal((v) => !v)}
                aria-pressed={autoDeal}
                title="Auto-deal next rounds after settle"
              >
                AUTO
              </button>
            </div>
          )}

          {phase === "dealing" && (
            <ActionButton
              label="DEALING…"
              primary
              wide
              disabled
              onClick={() => {}}
            />
          )}

          {phase === "player" && (
            <div className="bj-action-row">
              <ActionButton
                label="HIT"
                disabled={!hitEnabled}
                onClick={handleHit}
              />
              <ActionButton
                label="STAND"
                disabled={!standEnabled}
                onClick={handleStand}
              />
              <ActionButton
                label="DOUBLE"
                disabled={!doubleEnabled}
                onClick={handleDouble}
              />
              <ActionButton
                label="SPLIT"
                disabled={!splitEnabled}
                onClick={handleSplit}
              />
            </div>
          )}

          {phase === "dealer" && (
            <ActionButton
              label="DEALER…"
              primary
              wide
              disabled
              onClick={() => {}}
            />
          )}

          {phase === "settle" && (
            autoDeal ? (
              <div className="bj-action-row" style={{ width: "100%", gap: 8 }}>
                <ActionButton
                  label="AUTO-DEAL…"
                  primary
                  wide
                  disabled
                  onClick={() => {}}
                />
                <ActionButton
                  label="STOP"
                  onClick={() => setAutoDeal(false)}
                />
              </div>
            ) : (
              <div className="bj-action-row" style={{ width: "100%", gap: 8 }}>
                <ActionButton
                  label="NEW ROUND"
                  primary
                  wide
                  onClick={handleNewRound}
                />
                {sessionStats.rounds > 0 ? (
                  <ActionButton
                    label="STATS"
                    onClick={() => endSession("manual")}
                  />
                ) : null}
              </div>
            )
          )}
        </div>
        </div>

        {phase === "betting" && (
          <div
            className="bj-footer-note"
            style={{
              textAlign: "center",
              fontSize: 11,
              color: "rgba(232,223,199,0.45)",
              paddingBottom: 8,
            }}
          >
            {deckCount}-deck shoe · BJ {bjPayout} ·{" "}
            {hitSoft17 ? "H17" : "S17"}
            {playerCut ? " · player cut" : ""}
            {autoDeal ? " · auto-deal" : ""}
            {" · hands limited by bank"}
            {sessionStats.rounds > 0
              ? ` · ${sessionStats.rounds} round${sessionStats.rounds === 1 ? "" : "s"}`
              : ""}
          </div>
        )}
      </div>

      {pickingCasino ? (
        <CasinoSelectScreen
          selected={draftCasino}
          onSelect={setDraftCasino}
          onEnter={applyCasino}
          onClose={() => {
            setDraftCasino(casino);
            setPickingCasino(false);
          }}
          query={casinoQuery}
          onQuery={setCasinoQuery}
        />
      ) : null}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        bjPayout={bjPayout}
        onBjPayout={setBjPayout}
        hitSoft17={hitSoft17}
        onHitSoft17={setHitSoft17}
        deckCount={deckCount}
        onDeckCount={handleDeckCountChange}
        playerCut={playerCut}
        onPlayerCut={setPlayerCut}
        autoDeal={autoDeal}
        onAutoDeal={setAutoDeal}
        sideBetsEnabled={sideBetsEnabled}
        onSideBetsEnabled={setSideBetsOn}
        canEdit={canEditSettings}
        onRestart={handleRestartGame}
        onEndSession={() => endSession("manual")}
        canEndSession={sessionStats.rounds > 0 && phase === "betting"}
      />

      <AnalyticsOverlay
        open={!!analytics}
        stats={analytics}
        meta={{
          casino: casino.name,
          decks: deckCount,
          bjPayout,
          hitSoft17,
        }}
        onClose={() => setAnalytics(null)}
        onNewSession={handleNewSessionFromAnalytics}
      />

      {(shuffleStage === "riffling" || shuffleStage === "stacking") && (
        <ShuffleCeremony decks={deckCount} stage={shuffleStage} />
      )}

      {shuffleStage === "cutting" && (
        <CutOverlay onCut={completePlayerCut} />
      )}
    </div>
  );
}
