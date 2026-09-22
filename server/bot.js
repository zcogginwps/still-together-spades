// A deliberately modest opponent: it follows the rules, respects nil bids and
// its partner, and plays a sensible card. It is here so you can test a table
// without waiting on four humans.
import { RANK_VALUE, suitOf, valueOf } from './deck.js';
import { minimumBidFor, TEAM_OF_SEAT } from './rules.js';

const SIDE_SUITS = ['H', 'D', 'C'];
const bySuit = (hand, suit) => hand.filter((c) => suitOf(c) === suit).sort((a, b) => valueOf(b) - valueOf(a));
const lowest = (cards) => cards.reduce((a, b) => (valueOf(a) <= valueOf(b) ? a : b));
const highest = (cards) => cards.reduce((a, b) => (valueOf(a) >= valueOf(b) ? a : b));

/** Rough expected-trick count for a hand. */
export function estimateTricks(hand) {
  const spades = bySuit(hand, 'S');
  let t = 0;

  if (spades.includes('AS')) t += 1;
  if (spades.includes('KS')) t += spades.length >= 2 ? 0.95 : 0.5;
  if (spades.includes('QS')) t += spades.length >= 3 ? 0.8 : 0.35;
  t += Math.max(0, spades.length - 3) * 0.8;

  for (const suit of SIDE_SUITS) {
    const cards = bySuit(hand, suit);
    if (cards.some((c) => c[0] === 'A')) t += 0.9;
    if (cards.some((c) => c[0] === 'K')) t += cards.length >= 2 ? 0.6 : 0.25;
    if (cards.some((c) => c[0] === 'Q')) t += cards.length >= 3 ? 0.3 : 0.1;
    if (cards.length === 0 && spades.length >= 3) t += 1;
    else if (cards.length === 1 && spades.length >= 4) t += 0.5;
  }
  return t;
}

function wantsNil(hand, settings) {
  if (!settings.allowNil) return false;
  const spades = bySuit(hand, 'S');
  if (spades.length > 3) return false;
  if (spades.some((c) => 'AK'.includes(c[0]))) return false;
  if (spades.length === 3 && valueOf(spades[0]) > RANK_VALUE.J) return false;
  if (spades.length > 0 && valueOf(spades[0]) > RANK_VALUE.Q) return false;
  for (const suit of SIDE_SUITS) {
    const cards = bySuit(hand, suit);
    if (cards.some((c) => c[0] === 'A')) return false;
    if (cards.some((c) => c[0] === 'K') && cards.length <= 2) return false;
    if (cards.length && valueOf(cards[0]) >= RANK_VALUE.Q && cards.length <= 1) return false;
  }
  return true;
}

export function chooseBid(game, seat) {
  const { settings } = game;
  const hand = game.state.hands[seat];
  const min = minimumBidFor(seat, game.state.bids, settings);
  const estimate = estimateTricks(hand);

  if (min === 0 && estimate < 1.1 && wantsNil(hand, settings)) return { type: 'nil' };

  let bid = Math.round(estimate);
  bid = Math.max(1, Math.min(13, bid));
  return { type: 'num', value: Math.max(bid, min) };
}

export function chooseBlind(game, seat) {
  // The bot never gambles a blind nil; a human partner would not thank it.
  return false;
}

export function chooseCard(game, seat) {
  const s = game.state;
  const legal = game.legalCards(seat);
  if (legal.length <= 1) return legal[0];

  const myBid = s.bids[seat];
  const partner = (seat + 2) % 4;
  const partnerBid = s.bids[partner];
  const iAmNil = myBid && myBid.type !== 'num';
  const partnerIsNil = partnerBid && partnerBid.type !== 'num';

  const team = TEAM_OF_SEAT[seat];
  const teamSeats = team === 0 ? [0, 2] : [1, 3];
  const teamBid = teamSeats.reduce((sum, st) => sum + (s.bids[st] && s.bids[st].type === 'num' ? s.bids[st].value : 0), 0);
  const teamTricks = teamSeats.reduce((sum, st) => sum + s.tricksWon[st], 0);
  const needsTricks = teamTricks < teamBid;

  const leading = s.trick.length === 0;
  const currentBest = leading ? null : s.trick[bestIndex(s.trick)];
  const partnerWinning = currentBest && currentBest.seat === partner;

  if (iAmNil) return nilPlay(legal, s, leading, currentBest);
  if (partnerIsNil) return coverPartnerNil(legal, s, leading, currentBest, partner);

  if (leading) {
    // Cash a side-suit ace first; otherwise lead something small and safe.
    const aces = legal.filter((c) => c[0] === 'A' && suitOf(c) !== 'S');
    if (needsTricks && aces.length) return aces[0];
    const offSuit = legal.filter((c) => suitOf(c) !== 'S');
    if (offSuit.length) return lowest(offSuit);
    return needsTricks ? highest(legal) : lowest(legal);
  }

  const beating = legal.filter((c) => beats(c, currentBest.card, suitOf(s.trick[0].card)));
  if (partnerWinning && !partnerIsNil) {
    // Partner has it; do not spend a winner on our own trick.
    const safe = legal.filter((c) => !beats(c, currentBest.card, suitOf(s.trick[0].card)));
    return lowest(safe.length ? safe : legal);
  }
  if (needsTricks && beating.length) return lowest(beating);
  if (!needsTricks && beating.length && beating.length === legal.length) return lowest(legal);
  return discard(legal, s);
}

function bestIndex(trick) {
  const led = suitOf(trick[0].card);
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, trick[best].card, led)) best = i;
  }
  return best;
}

function beats(card, other, led) {
  const cs = suitOf(card);
  const os = suitOf(other);
  if (cs === 'S' && os !== 'S') return true;
  if (cs !== 'S' && os === 'S') return false;
  if (cs !== os) return false;              // a discard never beats anything
  if (cs !== 'S' && cs !== led) return false;
  return valueOf(card) > valueOf(other);
}

function nilPlay(legal, s, leading, currentBest) {
  if (leading) return lowest(legal);
  const led = suitOf(s.trick[0].card);
  const safe = legal.filter((c) => !beats(c, currentBest.card, led));
  // Shed the highest card that still cannot win the trick.
  if (safe.length) return highest(safe);
  return lowest(legal);
}

function coverPartnerNil(legal, s, leading, currentBest, partner) {
  if (leading) {
    const offSuit = legal.filter((c) => suitOf(c) !== 'S');
    return highest(offSuit.length ? offSuit : legal);
  }
  const led = suitOf(s.trick[0].card);
  const partnerPlayed = s.trick.find((p) => p.seat === partner);
  const beating = legal.filter((c) => beats(c, currentBest.card, led));
  // If partner has already thrown a card, take the trick so it cannot fall on them.
  if (partnerPlayed && beating.length) return lowest(beating);
  if (!partnerPlayed && beating.length) return highest(beating);
  return lowest(legal);
}

function discard(legal, s) {
  const offSuit = legal.filter((c) => suitOf(c) !== 'S');
  return lowest(offSuit.length ? offSuit : legal);
}

export const BOT_NAMES = ['Robo Ruth', 'Bot Bobby', 'Chip', 'Ada', 'Deuce', 'Pixel'];
