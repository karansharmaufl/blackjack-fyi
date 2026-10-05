/**
 * One house per U.S. state — fictional names inspired by real venues.
 * `theme` drives table felt motion + chip animation variants.
 * `script` gives each casino a unique calligraphy watermark style.
 */

export const CASINO_THEMES = {
  velvet: {
    id: "velvet",
    felt1: "#127A52",
    felt2: "#0B4530",
    felt3: "#083826",
    accent: "#C9A227",
    page1: "#0B4530",
    page2: "#073024",
    page3: "#052018",
  },
  neon: {
    id: "neon",
    felt1: "#0E6E6A",
    felt2: "#0A3D48",
    felt3: "#062830",
    accent: "#3DE0C5",
    page1: "#0A3D48",
    page2: "#062830",
    page3: "#041820",
  },
  desert: {
    id: "desert",
    felt1: "#9A6B2F",
    felt2: "#6B4423",
    felt3: "#4A2E16",
    accent: "#E4B04A",
    page1: "#6B4423",
    page2: "#4A2E16",
    page3: "#2E1B0C",
  },
  coastal: {
    id: "coastal",
    felt1: "#1A7A8C",
    felt2: "#0E4F5C",
    felt3: "#0A3640",
    accent: "#7EC8D4",
    page1: "#0E4F5C",
    page2: "#0A3640",
    page3: "#062028",
  },
  mountain: {
    id: "mountain",
    felt1: "#3D6B5A",
    felt2: "#244438",
    felt3: "#163028",
    accent: "#B8C9A8",
    page1: "#244438",
    page2: "#163028",
    page3: "#0C1C18",
  },
  jazz: {
    id: "jazz",
    felt1: "#5A2E4A",
    felt2: "#3A1A30",
    felt3: "#24101E",
    accent: "#D4A017",
    page1: "#3A1A30",
    page2: "#24101E",
    page3: "#140910",
  },
  goldrush: {
    id: "goldrush",
    felt1: "#2F6B3A",
    felt2: "#1A4024",
    felt3: "#102818",
    accent: "#F0C14B",
    page1: "#1A4024",
    page2: "#102818",
    page3: "#08140C",
  },
  midnight: {
    id: "midnight",
    felt1: "#1E3A5F",
    felt2: "#12263F",
    felt3: "#0A1626",
    accent: "#9BB4D0",
    page1: "#12263F",
    page2: "#0A1626",
    page3: "#050B14",
  },
};

/** Distinct calligraphy / script faces used across the 50 floors. */
export const SCRIPT_FONTS = [
  "Great Vibes",
  "Allura",
  "Alex Brush",
  "Pinyon Script",
  "Tangerine",
  "Sacramento",
  "Mrs Saint Delafield",
  "Italianno",
  "Rouge Script",
  "Parisienne",
  "Dancing Script",
  "Satisfy",
  "Pacifico",
  "Yellowtail",
  "Cookie",
  "Kaushan Script",
  "Marck Script",
  "Courgette",
  "Lobster",
  "Petit Formal Script",
  "WindSong",
  "Imperial Script",
  "Birthstone",
  "Ballet",
  "Euphoria Script",
];

/** Google Fonts query fragment for all calligraphy faces. */
export const SCRIPT_FONTS_QUERY = SCRIPT_FONTS.map(
  (name) => `family=${encodeURIComponent(name).replace(/%20/g, "+")}`
).join("&");

const CASINO_BASE = [
  { state: "Alabama", abbr: "AL", city: "Atmore", name: "Crimson Chip Casino", theme: "goldrush" },
  { state: "Alaska", abbr: "AK", city: "Anchorage", name: "Aceberg Lodge", theme: "midnight" },
  { state: "Arizona", abbr: "AZ", city: "Scottsdale", name: "Pairadise Mesa", theme: "desert" },
  { state: "Arkansas", abbr: "AR", city: "Hot Springs", name: "Natural Hot Springs", theme: "goldrush" },
  { state: "California", abbr: "CA", city: "San Diego", name: "Dealifornia Club", theme: "coastal" },
  { state: "Colorado", abbr: "CO", city: "Black Hawk", name: "High Card Hawk", theme: "mountain" },
  { state: "Connecticut", abbr: "CT", city: "Uncasville", name: "Casinecticut Star", theme: "neon" },
  { state: "Delaware", abbr: "DE", city: "Wilmington", name: "First State Flush", theme: "coastal" },
  { state: "Florida", abbr: "FL", city: "Hollywood", name: "Floridouble", theme: "neon" },
  { state: "Georgia", abbr: "GA", city: "Atlanta", name: "Peach Pair Palace", theme: "velvet" },
  { state: "Hawaii", abbr: "HI", city: "Honolulu", name: "Aloha Ante", theme: "coastal" },
  { state: "Idaho", abbr: "ID", city: "Fort Hall", name: "Spud of Spades", theme: "mountain" },
  { state: "Illinois", abbr: "IL", city: "Des Plaines", name: "Windy City Wager", theme: "velvet" },
  { state: "Indiana", abbr: "IN", city: "Hammond", name: "Hoosier Soft 17", theme: "midnight" },
  { state: "Iowa", abbr: "IA", city: "Council Bluffs", name: "Full House Farm", theme: "goldrush" },
  { state: "Kansas", abbr: "KS", city: "Kansas City", name: "Ace of Plains", theme: "neon" },
  { state: "Kentucky", abbr: "KY", city: "Louisville", name: "Derby Double Down", theme: "goldrush" },
  { state: "Louisiana", abbr: "LA", city: "New Orleans", name: "Big Easy Ante", theme: "jazz" },
  { state: "Maine", abbr: "ME", city: "Bangor", name: "Mainely Blackjack", theme: "mountain" },
  { state: "Maryland", abbr: "MD", city: "Baltimore", name: "Soft Crab Seventeen", theme: "coastal" },
  { state: "Massachusetts", abbr: "MA", city: "Springfield", name: "Bean Town Bust", theme: "velvet" },
  { state: "Michigan", abbr: "MI", city: "Detroit", name: "Motor City Ante", theme: "neon" },
  { state: "Minnesota", abbr: "MN", city: "Prior Lake", name: "Twin Aces Lodge", theme: "coastal" },
  { state: "Mississippi", abbr: "MS", city: "Biloxi", name: "Mississipair", theme: "jazz" },
  { state: "Missouri", abbr: "MO", city: "St. Louis", name: "Show-Me Soft 17", theme: "midnight" },
  { state: "Montana", abbr: "MT", city: "Missoula", name: "Big Sky Bust", theme: "mountain" },
  { state: "Nebraska", abbr: "NE", city: "Lincoln", name: "Cornhusker Casino", theme: "desert" },
  { state: "Nevada", abbr: "NV", city: "Las Vegas", name: "Pairadise Vegas", theme: "velvet" },
  { state: "New Hampshire", abbr: "NH", city: "Portsmouth", name: "Live Free or Triple", theme: "coastal" },
  { state: "New Jersey", abbr: "NJ", city: "Atlantic City", name: "Boardwalk Blackjack", theme: "neon" },
  { state: "New Mexico", abbr: "NM", city: "Albuquerque", name: "Enchanted Ante", theme: "desert" },
  { state: "New York", abbr: "NY", city: "Verona", name: "Big Apple Ante", theme: "velvet" },
  { state: "North Carolina", abbr: "NC", city: "Cherokee", name: "Tar Heel Soft 17", theme: "mountain" },
  { state: "North Dakota", abbr: "ND", city: "Fargo", name: "Fargo Flush", theme: "midnight" },
  { state: "Ohio", abbr: "OH", city: "Cleveland", name: "O-High-O Club", theme: "neon" },
  { state: "Oklahoma", abbr: "OK", city: "Norman", name: "Sooner Soft 17", theme: "desert" },
  { state: "Oregon", abbr: "OR", city: "Grand Ronde", name: "Ore-Gone Broke", theme: "mountain" },
  { state: "Pennsylvania", abbr: "PA", city: "Bensalem", name: "Keystone Soft Pair", theme: "velvet" },
  { state: "Rhode Island", abbr: "RI", city: "Lincoln", name: "Ocean State Ante", theme: "coastal" },
  { state: "South Carolina", abbr: "SC", city: "Myrtle Beach", name: "Palmetto Pair", theme: "coastal" },
  { state: "South Dakota", abbr: "SD", city: "Deadwood", name: "Deadwood Double Down", theme: "goldrush" },
  { state: "Tennessee", abbr: "TN", city: "Nashville", name: "Music City Soft Pair", theme: "jazz" },
  { state: "Texas", abbr: "TX", city: "Eagle Pass", name: "Lone Star Ace", theme: "desert" },
  { state: "Utah", abbr: "UT", city: "Salt Lake City", name: "Salt Lake Stake", theme: "mountain" },
  { state: "Vermont", abbr: "VT", city: "Burlington", name: "Maple Soft Seventeen", theme: "mountain" },
  { state: "Virginia", abbr: "VA", city: "Portsmouth", name: "Dominion Deal", theme: "coastal" },
  { state: "Washington", abbr: "WA", city: "Tulalip", name: "Evergreen Ante", theme: "coastal" },
  { state: "West Virginia", abbr: "WV", city: "Charles Town", name: "Mountain Soft Pair", theme: "goldrush" },
  { state: "Wisconsin", abbr: "WI", city: "Milwaukee", name: "Cheese Pair Casino", theme: "velvet" },
  { state: "Wyoming", abbr: "WY", city: "Riverton", name: "Cowboy Soft 17", theme: "desert" },
];

function buildScriptStyle(index) {
  const font = SCRIPT_FONTS[index % SCRIPT_FONTS.length];
  // Unique tilt / tracking / scale so even shared fonts read differently
  const rotate = -16 + ((index * 11) % 29); // roughly -16° … +12°
  const tracking = (((index * 3) % 9) - 4) * 0.015; // -0.06em … +0.06em
  const scale = 0.88 + ((index * 5) % 7) * 0.035; // ~0.88 … 1.09
  return {
    font,
    family: `'${font}', cursive`,
    rotate,
    tracking: `${tracking.toFixed(3)}em`,
    scale: Number(scale.toFixed(3)),
  };
}

export const CASINOS = CASINO_BASE.map((c, i) => ({
  ...c,
  script: buildScriptStyle(i),
}));

export const DEFAULT_CASINO_ABBR = "NV";

export function getDefaultCasino() {
  return (
    CASINOS.find((c) => c.abbr === DEFAULT_CASINO_ABBR) || CASINOS[0]
  );
}

export function getCasinoTheme(casino) {
  const id = casino?.theme || "velvet";
  return CASINO_THEMES[id] || CASINO_THEMES.velvet;
}

export function getCasinoScript(casino) {
  return (
    casino?.script || {
      font: "Great Vibes",
      family: "'Great Vibes', cursive",
      rotate: -10,
      tracking: "0.02em",
      scale: 1,
    }
  );
}
