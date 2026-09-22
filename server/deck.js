// Card model. A card is a two-character string: rank + suit, e.g. "AS", "TD", "2C".
export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

// Display order for a hand: alternating colours so adjacent suits never blur together.
const HAND_SUIT_ORDER = ['S', 'H', 'C', 'D'];

export const rankOf = (card) => card[0];
export const suitOf = (card) => card[1];
export const valueOf = (card) => RANK_VALUE[card[0]];

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

export function shuffle(cards, random = Math.random) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const s = HAND_SUIT_ORDER.indexOf(suitOf(a)) - HAND_SUIT_ORDER.indexOf(suitOf(b));
    if (s !== 0) return s;
    return valueOf(b) - valueOf(a);
  });
}

// Returns the index within `plays` that won the trick.
// plays: [{ seat, card }] in the order they were played, plays[0] led.
export function trickWinnerIndex(plays) {
  const led = suitOf(plays[0].card);
  let best = 0;
  for (let i = 1; i < plays.length; i++) {
    const cur = plays[i].card;
    const bestCard = plays[best].card;
    const curIsSpade = suitOf(cur) === 'S';
    const bestIsSpade = suitOf(bestCard) === 'S';
    if (curIsSpade && !bestIsSpade) best = i;
    else if (curIsSpade === bestIsSpade && suitOf(cur) === suitOf(bestCard) && valueOf(cur) > valueOf(bestCard)) {
      // same suit as the current best: higher card wins
      if (curIsSpade || suitOf(cur) === led) best = i;
    }
  }
  return best;
}
