import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { CASINOS, getDefaultCasino, getCasinoTheme, getCasinoScript, SCRIPT_FONTS_QUERY } from "./casinos.js";

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
    value: 5,
    face: "#F7F1E1",
    rim: "#C9A227",
    ink: "#1A1A1A",
    edge: "#E8DFC7",
    spot: "#C9A227",
  },
  {
    value: 10,
    face: "#1B5E3B",
    rim: "#E8DFC7",
    ink: "#F7F1E1",
    edge: "#0E3D26",
    spot: "#E8DFC7",
  },
  {
    value: 25,
    face: "#9B2C2C",
    rim: "#F7F1E1",
    ink: "#F7F1E1",
    edge: "#6E1C1C",
    spot: "#F7F1E1",
  },
  {
    value: 100,
    face: "#1A1A1A",
    rim: "#C9A227",
    ink: "#F7F1E1",
    edge: "#0A0A0A",
    spot: "#C9A227",
  },
];

const DECKS = 4;
const SHOE_SIZE = DECKS * 52;
const RESHUFFLE_AT = Math.floor(SHOE_SIZE * 0.25);
const STARTING_BANK = 1000;
const DEAL_STEP_MS = 380;
const DEAL_FLIGHT_MS = 360;
const DEALER_DRAW_MS = 520;
const CHIP_FLY_MS = 700;
const SHUFFLE_MS = 2000;
const CHIP_ORDER = [100, 25, 10, 5];

function chipStyle(value) {
  return CHIP_DENOMS.find((c) => c.value === value) || CHIP_DENOMS[0];
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

function makeShoe() {
  const cards = [];
  for (let d = 0; d < DECKS; d += 1) {
    for (const suit of SUIT_KEYS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit, id: nextCardId() });
      }
    }
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
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

/** Dealer draws until 17+ (stands on soft 17). */
function dealerPlayOut(cards, shoe) {
  let nextCards = cards.map((c) => ({ ...c, faceDown: false }));
  let nextShoe = shoe;
  while (evaluateHand(nextCards).total < 17) {
    const drawn = drawFromShoe(nextShoe);
    if (!drawn.card) break;
    nextCards = [...nextCards, drawn.card];
    nextShoe = drawn.shoe;
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
function settleHand(hand, dealerEval) {
  const bet = hand.bet;

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
    const profit = bet * 1.5;
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

function OutcomeBanner({ outcome, compact = false }) {
  if (!outcome) return null;
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
  const cfg = map[outcome];
  if (!cfg) return null;

  return (
    <div
      className="bj-outcome-banner"
      style={{
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: compact
          ? outcome === "blackjack"
            ? 18
            : 22
          : outcome === "blackjack"
            ? 24
            : 28,
        letterSpacing: outcome === "blackjack" ? 2 : 4,
        color: cfg.color,
        textShadow: `0 0 14px ${cfg.glow}, 0 2px 4px rgba(0,0,0,0.65)`,
        animation: "outcomeBurst 0.55s cubic-bezier(0.2, 1.2, 0.3, 1) both",
        lineHeight: 1,
        textAlign: "center",
      }}
    >
      {cfg.text}
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
      <div className="bj-card-back-inner">
        <div className="bj-card-back-motif" />
      </div>
    </div>
  ) : (
    <div className="bj-card-face bj-card-front" style={{ color: suitMeta.color }}>
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
function DealerShoe({ remaining, total = SHOE_SIZE, shuffling = false }) {
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

function FeltChip({ value, face, rim, ink, edge, spot, size = 52, offset = 0 }) {
  return (
    <div
      aria-hidden
      className="bj-felt-chip"
      style={{
        position: "relative",
        width: size,
        height: size,
        marginTop: offset ? -Math.round(size * 0.78) : 0,
        borderRadius: "50%",
        flexShrink: 0,
        background: `
          radial-gradient(circle at 32% 28%, rgba(255,255,255,0.35), transparent 42%),
          repeating-conic-gradient(
            from 0deg,
            ${spot || rim} 0deg 18deg,
            transparent 18deg 45deg
          ),
          radial-gradient(circle at 50% 55%, ${face} 0%, ${edge || face} 78%)
        `,
        backgroundBlendMode: "normal, soft-light, normal",
        color: ink,
        boxShadow: `
          0 4px 10px rgba(0,0,0,0.45),
          0 1px 0 rgba(255,255,255,0.2) inset,
          0 -2px 4px rgba(0,0,0,0.35) inset
        `,
        border: `2px solid ${rim}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: offset + 1,
      }}
    >
      <span
        style={{
          position: "relative",
          zIndex: 2,
          width: "58%",
          height: "58%",
          borderRadius: "50%",
          border: `2px solid ${rim}`,
          background: `radial-gradient(circle at 40% 35%, ${face}, ${edge || face})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Bebas Neue', sans-serif",
          fontSize: size >= 48 ? 15 : 13,
          letterSpacing: 0.5,
          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.25)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** Bet stack on the felt. fly: idle | to-dealer | to-player | from-dealer */
function BetChipStack({ amount, fly = "idle", size = 52, delay = 0 }) {
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
        width: size + 4,
        overflow: "visible",
        filter: "none",
        animation: anim
          ? `${anim} ${CHIP_FLY_MS}ms cubic-bezier(0.22, 0.75, 0.3, 1) both`
          : undefined,
        animationDelay: anim ? `${delay}ms` : undefined,
      }}
      title={`$${formatMoney(amount)}`}
    >
      {chips.map((c, i) => (
        <FeltChip
          key={c.id}
          value={c.value}
          face={c.face}
          rim={c.rim}
          ink={c.ink}
          edge={c.edge}
          spot={c.spot}
          size={size}
          offset={i}
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
  active = false,
  status = "active",
  outcome = null,
  payoutAmount = 0,
  chipFly = "idle",
  flash = null,
  compact = false,
  ghost = false,
  role = "player",
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

  const total = (
    <div
      className={`bj-hand-total${active ? " is-active" : ""}`}
      style={{ opacity: ghost && !cards.length ? 0.45 : 1 }}
    >
      <span className="bj-hand-label">{label}</span>
      <span className="bj-hand-score">{totalLabel}</span>
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
        paddingLeft: shown.length > 1 ? (compact ? 14 : 20) : 0,
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
        width: compact ? 84 : 100,
        minWidth: compact ? 84 : 100,
        minHeight: compact ? 84 : 100,
        visibility: "hidden",
        pointerEvents: "none",
        flexShrink: 0,
      }}
    />
  );

  const chipSpot =
    bet > 0 && !chipsCleared ? (
      <div
        className={`bj-chip-spot${active ? " is-active" : ""}${flyingAway ? " is-clearing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
          width: compact ? 84 : 100,
          minWidth: compact ? 84 : 100,
          minHeight: compact ? 84 : 100,
          padding: compact ? "12px 10px 8px" : "14px 12px 10px",
          boxSizing: "border-box",
          overflow: "visible",
          position: "relative",
          transition: "opacity 0.35s ease",
          opacity: flyingAway ? 0.35 : 1,
          flexShrink: 0,
        }}
      >
        <div className="bj-chip-spot-ring" aria-hidden />
        <div
          className="bj-chip-spot-stack"
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            gap: 10,
            minHeight: compact ? 48 : 56,
            position: "relative",
            zIndex: 1,
            overflow: "visible",
          }}
        >
          <BetChipStack
            key={`bet-${betFly}-${chipFly}`}
            amount={bet}
            fly={betFly}
            size={compact ? 40 : 48}
          />
          {showPayStack && (
            <BetChipStack
              key={`pay-${payFly}-${chipFly}`}
              amount={payoutAmount}
              fly={payFly}
              size={compact ? 40 : 48}
              delay={40}
            />
          )}
        </div>
        {!flyingAway && (
          <div className="bj-bet-amount" style={{ position: "relative", zIndex: 1 }}>
            ${formatMoney(bet)}
          </div>
        )}
      </div>
    ) : isDealer ? null : (
      chipPlaceholder
    );

  const payoutTag =
    flash || (outcome && chipFly === "done") ? (
      <OutcomeBanner outcome={flash || outcome} compact={compact} />
    ) : (
      <div className="bj-outcome-ph" aria-hidden />
    );

  return (
    <div
      className={`bj-hand bj-hand-${role}${active ? " is-active" : ""}${ghost ? " is-ghost" : ""}`}
    >
      {isDealer ? (
        <>
          {total}
          {cardRow}
        </>
      ) : (
        <>
          {/* Chip circle sits toward the dealer; cards rest below toward the player */}
          {chipSpot}
          {cardRow}
          {total}
          {payoutTag}
        </>
      )}
    </div>
  );
}

function Chip({ value, face, rim, ink, edge, spot, selected, onClick, disabled, size = 56 }) {
  return (
    <button
      type="button"
      className="bj-select-chip"
      onClick={onClick}
      disabled={disabled}
      aria-label={`$${value} chip`}
      aria-pressed={selected}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${rim}`,
        background: `
          radial-gradient(circle at 32% 28%, rgba(255,255,255,0.35), transparent 42%),
          repeating-conic-gradient(
            from 0deg,
            ${spot || rim} 0deg 18deg,
            transparent 18deg 45deg
          ),
          radial-gradient(circle at 50% 55%, ${face} 0%, ${edge || face} 78%)
        `,
        color: ink,
        boxShadow: selected
          ? `0 0 0 3px ${FELT.gold}, 0 6px 14px rgba(0,0,0,0.45)`
          : "0 5px 12px rgba(0,0,0,0.4)",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        outlineOffset: 3,
        transform: selected ? "scale(1.06)" : "none",
        transition: "box-shadow 0.15s, transform 0.15s",
        opacity: disabled ? 0.4 : 1,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "relative",
          zIndex: 1,
          width: "58%",
          height: "58%",
          margin: "0 auto",
          borderRadius: "50%",
          border: `2px solid ${rim}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Bebas Neue', sans-serif",
          fontSize: size >= 48 ? 15 : 12,
          letterSpacing: 0.5,
          background: face,
        }}
      >
        {value}
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
                        {c.city}, {c.state}
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

export default function BlackjackGame() {
  const [casino, setCasino] = useState(getDefaultCasino);
  const [draftCasino, setDraftCasino] = useState(getDefaultCasino);
  const [casinoQuery, setCasinoQuery] = useState("");
  const [pickingCasino, setPickingCasino] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [phase, setPhase] = useState("betting");
  const [selectedChip, setSelectedChip] = useState(25);
  const [handCount, setHandCount] = useState(1);
  const [bank, setBank] = useState(STARTING_BANK);
  const [dealerCards, setDealerCards] = useState([]);
  const [hands, setHands] = useState([]);
  const [activeHandIndex, setActiveHandIndex] = useState(0);
  const [shoeRemaining, setShoeRemaining] = useState(SHOE_SIZE);
  /** idle | pay | collect | done */
  const [chipFlyPhase, setChipFlyPhase] = useState("idle");
  const [shuffling, setShuffling] = useState(false);

  const shoeRef = useRef(makeShoe());
  const timersRef = useRef([]);
  const handsRef = useRef([]);
  const dealerRef = useRef([]);
  const bankRef = useRef(STARTING_BANK);
  const activeIndexRef = useRef(0);

  const clearTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  };

  const syncShoeCount = () => setShoeRemaining(shoeRef.current.length);

  useEffect(() => () => clearTimers(), []);

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

  const maxAffordableHands = Math.max(
    1,
    selectedChip > 0 ? Math.floor(bank / selectedChip) : 1
  );
  const totalStake = selectedChip * handCount;
  const canAffordDeal =
    bank >= totalStake && selectedChip > 0 && handCount >= 1 && !shuffling;

  const revealHole = phase === "dealer" || phase === "settle";
  const seatCount = phase === "betting" ? handCount : Math.max(hands.length, 1);
  const compact = seatCount >= 3 || isNarrow;

  const dealerTotal = useMemo(() => {
    if (dealerCards.length === 0) return "—";
    const { total } = evaluateHand(dealerCards, { revealHole });
    return String(total);
  }, [dealerCards, revealHole]);

  const showTable = phase !== "betting";

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
          const result = settleHand(handForSettle, dealerEval);
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
          if (nextBank <= 0) nextBank = STARTING_BANK;
          setBank(nextBank);
          bankRef.current = nextBank;
          setChipFlyPhase("done");
          // Remove bet stacks from the felt after they finish flying.
          setHands((prev) => {
            const cleared = prev.map((h) => ({
              ...h,
              bet: 0,
              payoutAmount: 0,
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
      const played = dealerPlayOut(dealer, shoeRef.current);
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
      const dealerPeekBJ = evaluateHand(
        dealtDealer.map((c) => ({ ...c, faceDown: false }))
      ).blackjack;

      let nextHands = dealtHands.map((h) => {
        const ev = evaluateHand(h.cards);
        // Natural blackjack — auto-resolved (paid at settle unless dealer BJ)
        if (ev.blackjack && !h.fromSplit) {
          return { ...h, status: "blackjack", flash: "blackjack" };
        }
        // Any 21 — no decisions left; auto-stand
        if (ev.total === 21) {
          return { ...h, status: "standing", flash: "twentyone" };
        }
        return { ...h, status: "active", flash: null };
      });

      handsRef.current = nextHands;
      setHands(nextHands);

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
    const stake = selectedChip * handCount;
    const nextBank = bankRef.current - stake;
    setBank(nextBank);
    bankRef.current = nextBank;

    const initialHands = Array.from({ length: handCount }, (_, i) => ({
      id: nextHandId(),
      cards: [],
      bet: selectedChip,
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
  }, [selectedChip, handCount, beginPlayerPhase]);

  const handleDeal = () => {
    if (!canAffordDeal || phase !== "betting" || shuffling) return;
    clearTimers();

    const needsShuffle = shoeRef.current.length <= RESHUFFLE_AT;
    if (needsShuffle) {
      setShuffling(true);
      // Drain the visual stack before the new shoe appears
      setShoeRemaining(0);
      const id = window.setTimeout(() => {
        shoeRef.current = makeShoe();
        syncShoeCount();
        setShuffling(false);
        runDeal();
      }, SHUFFLE_MS);
      timersRef.current.push(id);
      return;
    }

    runDeal();
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
    };
    const handB = {
      id: nextHandId(),
      cards: [
        { ...c2, fromSplitHand: true },
        { ...d2.card, fromSplitHand: true },
      ],
      bet: hand.bet,
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
      nextBank = STARTING_BANK;
      setBank(nextBank);
      bankRef.current = nextBank;
    }
    const maxHands = Math.max(1, Math.floor(nextBank / selectedChip) || 1);
    if (handCount > maxHands) setHandCount(maxHands);
    setHands([]);
    handsRef.current = [];
    setDealerCards([]);
    dealerRef.current = [];
    setActiveHandIndex(0);
    setChipFlyPhase("idle");
    setPhase("betting");
  };

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
    if (phase !== "betting" || shuffling) return;
    setDraftCasino(casino);
    setPickingCasino(true);
  };

  const applyCasino = (c) => {
    setCasino(c);
    setDraftCasino(c);
    setPickingCasino(false);
  };

  const theme = getCasinoTheme(casino);
  const script = getCasinoScript(casino);

  return (
    <div
      className="bj-page"
      data-theme={theme.id}
      style={{
        minHeight: "100dvh",
        background: `radial-gradient(ellipse at center, ${theme.page1} 0%, ${theme.page2} 70%, ${theme.page3} 100%)`,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 12,
        fontFamily: "'Inter', sans-serif",
        boxSizing: "border-box",
        "--casino-accent": theme.accent,
        "--felt-1": theme.felt1,
        "--felt-2": theme.felt2,
        "--felt-3": theme.felt3,
        transition: "background 0.55s ease",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&${SCRIPT_FONTS_QUERY}&display=swap');
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
        .bj-chip-spot-ring {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 78%;
          height: 78%;
          transform: translate(-50%, -54%);
          border-radius: 50%;
          background: radial-gradient(
            circle at 50% 45%,
            color-mix(in srgb, var(--casino-accent) 22%, transparent) 0%,
            rgba(0,0,0,0.28) 70%
          );
          box-shadow:
            inset 0 0 0 2px color-mix(in srgb, var(--casino-accent) 55%, transparent),
            inset 0 0 0 5px rgba(0,0,0,0.2),
            0 4px 12px rgba(0,0,0,0.25);
          pointer-events: none;
          z-index: 0;
          animation: chipSpotPulse 2.4s ease-in-out infinite;
        }
        .bj-chip-spot.is-active .bj-chip-spot-ring {
          box-shadow:
            inset 0 0 0 2px var(--casino-accent),
            inset 0 0 0 5px rgba(0,0,0,0.2),
            0 0 16px color-mix(in srgb, var(--casino-accent) 35%, transparent);
        }
        .bj-bet-stack.is-idle .bj-felt-chip {
          /* no transform idle motion — avoids clipping */
        }
        [data-theme="neon"] .bj-chip-spot-ring { animation: chipSpotNeon 1.6s ease-in-out infinite; }
        [data-theme="desert"] .bj-chip-spot-ring { animation: chipSpotPulse 2.8s ease-in-out infinite; }
        [data-theme="coastal"] .bj-chip-spot-ring { animation: chipSpotPulse 2.2s ease-in-out infinite; }
        [data-theme="mountain"] .bj-chip-spot-ring { animation: chipSpotPulse 3.4s ease-in-out infinite; }
        [data-theme="jazz"] .bj-chip-spot-ring { animation: chipSpotPulse 1.9s ease-in-out infinite; }
        [data-theme="goldrush"] .bj-chip-spot-ring { animation: chipSpotPulse 2s ease-in-out infinite; }
        [data-theme="midnight"] .bj-chip-spot-ring { animation: chipSpotPulse 3s ease-in-out infinite; }
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
        }
        .bj-card-face {
          width: 100%;
          height: 100%;
          border-radius: 8px;
          box-sizing: border-box;
          overflow: hidden;
        }
        .bj-card-back {
          background: linear-gradient(145deg, #0E5A3F 0%, #09402C 55%, #073024 100%);
          border: 2px solid ${FELT.gold};
          box-shadow: 0 6px 14px rgba(0,0,0,0.4);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .bj-card-back-inner {
          width: 50%;
          height: 58%;
          border: 1.5px solid ${FELT.gold};
          border-radius: 4;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0,0,0,0.2);
        }
        .bj-card-back-motif {
          width: 12px;
          height: 12px;
          transform: rotate(45deg);
          background: ${FELT.gold};
          opacity: 0.85;
        }
        .bj-card-front {
          background: #F7F2E4;
          border: 1.5px solid #D4C9A8;
          box-shadow: 0 6px 14px rgba(0,0,0,0.4);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          padding: 6px 8px;
        }
        .bj-card.is-compact .bj-card-front {
          padding: 4px 5px;
        }
        .bj-card-corner {
          line-height: 1;
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
        }
        .bj-card.is-compact .bj-card-center { font-size: 20px; }
        .bj-shoe {
          flex-shrink: 0;
          width: 92px;
          height: 118px;
          display: flex;
          align-items: flex-end;
          justify-content: flex-end;
          z-index: 2;
          filter: drop-shadow(0 10px 16px rgba(0,0,0,0.45));
        }
        .bj-shoe-shell {
          position: relative;
          width: 84px;
          height: 108px;
          border-radius: 10px 18px 12px 8px / 12px 22px 10px 8px;
          background:
            linear-gradient(155deg,
              rgba(210, 225, 230, 0.22) 0%,
              rgba(120, 145, 155, 0.28) 42%,
              rgba(40, 55, 65, 0.45) 100%);
          border: 1.5px solid rgba(230, 240, 245, 0.45);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.35),
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
          display: grid;
          grid-template-columns: 72px 1fr 96px;
          align-items: center;
          justify-items: center;
          z-index: 1;
          position: relative;
          min-height: 0;
          align-self: stretch;
        }
        .bj-dealer-row .bj-shoe {
          grid-column: 3;
          justify-self: end;
          align-self: start;
          margin-top: 4px;
        }
        .bj-dealer-hand {
          grid-column: 2;
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          height: 100%;
          min-height: 0;
        }
        .bj-pays-banner {
          z-index: 1;
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          margin: 0;
          pointer-events: none;
          text-align: center;
          min-height: 42px;
          flex-shrink: 0;
        }
        .bj-pays-main {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(18px, 4.5vw, 28px);
          letter-spacing: 0.18em;
          color: color-mix(in srgb, var(--casino-accent) 88%, #F0E6D2);
          text-shadow: 0 1px 0 rgba(0,0,0,0.35);
          white-space: nowrap;
        }
        .bj-pays-rules {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(11px, 2.8vw, 14px);
          letter-spacing: 0.14em;
          color: rgba(232,223,199,0.5);
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
          color: var(--casino-accent, #C9A227);
        }
        .bj-hand-total {
          display: flex;
          align-items: baseline;
          gap: 6px;
          position: relative;
          z-index: 3;
          padding: 2px 8px;
          border-radius: 8px;
          background: rgba(5, 24, 18, 0.55);
          backdrop-filter: blur(2px);
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
          width: min(920px, 100%);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }
        .bj-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(28px, 8vw, 44px);
          letter-spacing: 0.18em;
          color: #F0E6D2;
          text-shadow: 0 2px 4px rgba(0,0,0,0.4);
          text-align: center;
        }
        .bj-casino-tag {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: -4px;
        }
        .bj-casino-tag-text {
          font-size: clamp(12px, 3.2vw, 14px);
          color: rgba(232,223,199,0.72);
          text-align: center;
        }
        .bj-casino-tag-name {
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
        .bj-table {
          width: 100%;
          height: min(560px, 62dvh);
          min-height: min(560px, 62dvh);
          max-height: min(560px, 62dvh);
          background: transparent;
          border-radius: 32px 32px 140px 140px / 28px 28px 90px 90px;
          border: 12px solid #4A2F1A;
          box-shadow: 0 18px 40px rgba(0,0,0,0.5);
          padding: clamp(14px, 2.5vw, 24px) clamp(12px, 4vw, 36px) clamp(28px, 5vw, 44px);
          position: relative;
          display: grid;
          grid-template-rows: minmax(120px, 0.9fr) auto minmax(180px, 1.2fr);
          align-items: center;
          justify-items: center;
          gap: 8px;
          overflow: visible;
          flex-shrink: 0;
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
        .bj-table-mark {
          position: absolute;
          inset: 22% 10% 28%;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          z-index: 0;
          font-family: cursive;
          font-size: clamp(40px, 9vw, 88px);
          line-height: 0.95;
          letter-spacing: 0.02em;
          text-align: center;
          color: color-mix(in srgb, var(--casino-accent) 18%, rgba(232,223,199,0.06));
          text-shadow:
            0 1px 0 rgba(255,255,255,0.05),
            0 3px 10px rgba(0,0,0,0.2);
          user-select: none;
          overflow: hidden;
          opacity: 0.9;
          transition: color 0.45s ease, transform 0.45s ease;
        }
        .bj-table-mark span {
          max-width: 100%;
          display: block;
          word-break: break-word;
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
          gap: 10px;
          padding: 14px 12px 12px;
          border: 1.5px solid rgba(232,223,199,0.35);
          border-radius: 14px;
          background: rgba(5,32,24,0.72);
          overflow: visible;
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
            padding: 6px 6px calc(6px + env(safe-area-inset-bottom, 0px)) !important;
            align-items: stretch !important;
          }
          .bj-shell { gap: 6px; }
          .bj-title {
            font-size: clamp(22px, 7vw, 30px);
            letter-spacing: 0.14em;
            line-height: 1;
          }
          .bj-casino-tag { margin-top: 0; gap: 6px; }
          .bj-casino-tag-text { font-size: 11px; }
          .bj-casino-change { width: 24px; height: 24px; font-size: 12px; }
          .bj-table {
            border-radius: 16px 16px 40px 40px;
            border-width: 6px;
            height: min(420px, 52dvh);
            min-height: min(420px, 52dvh);
            max-height: min(420px, 52dvh);
            padding: 10px 8px 20px;
            gap: 4px;
            overflow: visible;
            grid-template-rows: minmax(96px, 0.85fr) auto minmax(150px, 1.25fr);
          }
          .bj-rail {
            border-radius: 12px 12px 32px 32px;
            inset: 4px;
          }
          .bj-dealer-row {
            grid-template-columns: 8px 1fr 56px;
            min-height: 0;
          }
          .bj-dealer-row .bj-shoe {
            margin-top: 0;
            transform: scale(0.82);
            transform-origin: top right;
          }
          .bj-pays-banner { margin: 0; gap: 1px; min-height: 32px; }
          .bj-pays-main {
            font-size: 14px;
            letter-spacing: 0.08em;
          }
          .bj-pays-rules {
            font-size: 10px;
            letter-spacing: 0.06em;
          }
          .bj-table-mark {
            font-size: clamp(26px, 9vw, 42px) !important;
            inset: 20% 12% 42% !important;
            opacity: 0.45;
          }
          .bj-seats { gap: 8px; }
          .bj-hand {
            min-width: 0 !important;
            max-width: 160px !important;
            flex: 1 1 auto !important;
            gap: 4px;
            padding: 2px;
          }
          .bj-hand-dealer .bj-cards,
          .bj-hand-player .bj-cards {
            min-height: 62px !important;
            height: 62px !important;
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
            min-width: 84px !important;
            min-height: 84px !important;
            width: 84px !important;
            padding: 12px 8px 8px !important;
            transform: none;
            overflow: visible !important;
          }
          .bj-bet-amount { font-size: 12px; }
          .bj-select-chip {
            width: 44px !important;
            height: 44px !important;
            overflow: visible !important;
            margin: 6px 3px !important;
          }
          .bj-controls {
            padding: 12px 10px 10px !important;
            overflow: visible !important;
          }
          .bj-controls-top {
            padding: 6px 4px 2px !important;
            overflow: visible !important;
          }
          .bj-card { width: 44px !important; height: 62px !important; }
          .bj-card-front { padding: 3px 4px !important; }
          .bj-card-rank { font-size: 13px !important; }
          .bj-card-suit { font-size: 9px !important; }
          .bj-card-center { font-size: 16px !important; }
          .bj-card-back-inner { width: 46%; height: 54%; }
          .bj-card-back-motif { width: 8px; height: 8px; }
          .bj-cards {
            min-height: 62px !important;
            padding-left: 10px !important;
          }
          .bj-shoe { width: 58px; height: 78px; }
          .bj-shoe-shell { width: 54px; height: 72px; }
          .bj-shoe-next { height: 28px; }
          .bj-controls {
            padding: 8px;
            border-radius: 12px;
            gap: 6px;
          }
          .bj-controls-top {
            gap: 8px !important;
          }
          .bj-select-chip {
            width: 42px !important;
            height: 42px !important;
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
          .bj-footer-note { display: none; }
        }
        @media (max-width: 640px) and (max-height: 780px) {
          .bj-title { display: none; }
          .bj-pays-rules { display: none; }
          .bj-table {
            height: min(360px, 48dvh);
            min-height: min(360px, 48dvh);
            max-height: min(360px, 48dvh);
            padding: 8px 6px 10px;
            gap: 4px;
          }
          .bj-card { width: 40px !important; height: 56px !important; }
          .bj-card-rank { font-size: 12px !important; }
          .bj-card-center { font-size: 14px !important; }
          .bj-hand-dealer .bj-cards,
          .bj-hand-player .bj-cards {
            min-height: 56px !important;
            height: 56px !important;
          }
        }
      `}</style>

      <div className="bj-shell">
        <div className="bj-title">BLACKJACK</div>
        <div className="bj-casino-tag">
          <div className="bj-casino-tag-text">
            <span className="bj-casino-tag-name">{casino.name}</span>
            {" · "}
            {casino.city}, {casino.abbr}
          </div>
          <button
            type="button"
            className="bj-casino-change"
            disabled={phase !== "betting" || shuffling}
            onClick={openCasinoPicker}
            aria-label="Switch casino"
            title="Switch casino"
          >
            ⇄
          </button>
        </div>

        <div className="bj-table">
          <div className="bj-table-felt" aria-hidden />
          <div className="bj-rail" aria-hidden />
          <div
            className="bj-table-mark"
            aria-hidden
            style={{
              fontFamily: script.family,
              letterSpacing: script.tracking,
              transform: `rotate(${script.rotate}deg) scale(${script.scale})`,
            }}
          >
            <span>{casino.name}</span>
          </div>

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
              total={SHOE_SIZE}
              shuffling={shuffling}
            />
          </div>

          <div className="bj-pays-banner" aria-hidden>
            <div className="bj-pays-main">BLACKJACK PAYS 3 TO 2</div>
            <div className="bj-pays-rules">DEALER MUST STAND ON ALL 17s</div>
          </div>

          <div className="bj-player-zone">
            <div className="bj-seats-wrap">
              <div
                className="bj-seats"
                style={{
                  width: seatCount > 4 ? "max-content" : "100%",
                  margin: seatCount > 4 ? "0 auto" : undefined,
                }}
              >
                {showTable
                  ? hands.map((h, i) => {
                      const ev = evaluateHand(h.cards);
                      const displayLabel =
                        hands.length === 1 ? "YOU" : `H${i + 1}`;
                      return (
                        <FeltHand
                          key={h.id}
                          role="player"
                          label={displayLabel}
                          cards={h.cards}
                          totalLabel={h.cards.length ? String(ev.total) : "—"}
                          bet={h.bet}
                          active={phase === "player" && i === activeHandIndex}
                          status={h.status}
                          outcome={phase === "settle" ? h.outcome : null}
                          flash={h.flash || null}
                          payoutAmount={h.payoutAmount || 0}
                          chipFly={
                            phase === "settle" ? flyForHand(h.status) : "idle"
                          }
                          compact={compact || hands.length > 2}
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
                        bet={selectedChip}
                        active={false}
                        status="active"
                        compact={handCount >= 3}
                        ghost
                      />
                    ))}
              </div>
            </div>
          </div>
        </div>

        <div className="bj-controls">
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
                gap: 10,
                flexWrap: "wrap",
                alignItems: "center",
                padding: "4px 2px",
              }}
            >
              {CHIP_DENOMS.map((c) => (
                <Chip
                  key={c.value}
                  {...c}
                  size={46}
                  selected={selectedChip === c.value}
                  disabled={phase !== "betting"}
                  onClick={() => {
                    if (phase !== "betting") return;
                    setSelectedChip(c.value);
                    const maxHands = Math.max(
                      1,
                      Math.floor(bank / c.value) || 1
                    );
                    if (handCount > maxHands) setHandCount(maxHands);
                  }}
                />
              ))}
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
                Total bet ${totalStake}
                {shoeRemaining <= RESHUFFLE_AT + 20 ? " · shoe low" : ""}
              </div>
            </div>
          ) : null}

        <div className="bj-actions">
          {phase === "betting" && (
            <ActionButton
              label={shuffling ? "SHUFFLING…" : "DEAL"}
              primary
              wide
              disabled={!canAffordDeal}
              onClick={handleDeal}
            />
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
            <ActionButton
              label="NEW ROUND"
              primary
              wide
              onClick={handleNewRound}
            />
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
            4-deck shoe · hands limited by bank
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
    </div>
  );
}
