import test from 'node:test';
import assert from 'node:assert/strict';
import { SpadesGame, GameError } from '../server/game.js';
import { defaultSettings } from '../server/rules.js';
import { suitOf } from '../server/deck.js';
import { chooseBid, chooseBlind, chooseCard } from '../server/bot.js';

// Deterministic PRNG so a failing seed can be replayed.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drive a complete game with four bots, asserting every invariant along the way. */
function playFullGame(settings, seed) {
  const game = new SpadesGame(settings, mulberry32(seed));
  game.startGame();
  let guard = 0;

  while (game.state.phase !== 'gameEnd') {
    assert.ok(guard++ < 20000, `game did not terminate (seed ${seed})`);
    const s = game.state;

    switch (s.phase) {
      case 'blind':
        game.chooseBlind(s.turn, chooseBlind(game, s.turn));
        break;

      case 'bidding': {
        const before = s.turn;
        game.placeBid(s.turn, chooseBid(game, s.turn));
        assert.notEqual(s.bids[before], null, 'bid was recorded');
        break;
      }

      case 'playing': {
        const seat = s.turn;
        const legal = game.legalCards(seat);
        assert.ok(legal.length > 0, `seat ${seat} always has a legal card (seed ${seed})`);

        // Following suit is mandatory when possible.
        if (s.trick.length > 0) {
          const led = suitOf(s.trick[0].card);
          const holdsLed = s.hands[seat].some((c) => suitOf(c) === led);
          if (holdsLed) assert.ok(legal.every((c) => suitOf(c) === led), 'must follow suit');
        } else if (settings.spadesBrokenRequired && !s.spadesBroken) {
          const holdsNonSpade = s.hands[seat].some((c) => suitOf(c) !== 'S');
          if (holdsNonSpade) assert.ok(legal.every((c) => suitOf(c) !== 'S'), 'cannot lead spades unbroken');
        }

        const card = chooseCard(game, seat);
        assert.ok(legal.includes(card), `bot picked a legal card (seed ${seed})`);
        game.playCard(seat, card);
        break;
      }

      case 'trickEnd': {
        const total = s.tricksWon.reduce((a, b) => a + b, 0);
        assert.equal(s.trick.length, 4);
        assert.ok(total >= 1 && total <= 13, 'trick counts stay in range');
        assert.ok(s.trickWinner !== null, 'a finished trick has a winner');
        game.resolveTrick();
        break;
      }

      case 'handEnd': {
        assert.equal(s.tricksWon.reduce((a, b) => a + b, 0), 13, 'all 13 tricks accounted for');
        assert.ok(s.hands.every((h) => h.length === 0), 'hands are empty at scoring');
        game.nextHand();
        break;
      }

      default:
        assert.fail(`unexpected phase ${s.phase}`);
    }

    // Invariants that must hold at every single step.
    const inHands = s.hands.reduce((n, h) => n + h.length, 0);
    const tricksBanked = s.tricksWon.reduce((a, b) => a + b, 0);
    if (s.phase !== 'handEnd' && s.phase !== 'gameEnd') {
      // During trickEnd the finished trick is still on the table AND already
      // credited to its winner, so it would otherwise be counted twice.
      const onTable = s.phase === 'trickEnd' ? 0 : s.trick.length;
      assert.equal(inHands + onTable + tricksBanked * 4, 52, `no cards created or lost (seed ${seed})`);
    }
    const all = s.hands.flat();
    assert.equal(new Set(all).size, all.length, 'no duplicate cards in hands');
  }

  assert.ok(game.state.winner === 0 || game.state.winner === 1);
  return game;
}

test('a thousand bot games finish cleanly under the default rules', () => {
  const settings = defaultSettings();
  for (let seed = 1; seed <= 1000; seed++) playFullGame(settings, seed);
});

test('games finish under a spread of house rules', () => {
  const variants = [
    { label: 'no nil', patch: { allowNil: false } },
    { label: 'blind nil on', patch: { allowBlindNil: true, blindNilDeficit: 0 } },
    { label: 'min team bid 4', patch: { minTeamBid: 4 } },
    { label: 'no bags', patch: { bagsEnabled: false } },
    { label: '5 bag limit', patch: { bagLimit: 5, bagPenalty: 50 } },
    { label: 'spades always leadable', patch: { spadesBrokenRequired: false } },
    { label: '10 for 200', patch: { tenForTwoHundred: true } },
    { label: 'broken nil helps', patch: { failedNilTricksCountForTeam: true } },
    { label: 'short game', patch: { targetScore: 200, minScore: null } },
    { label: 'everything on', patch: { allowBlindNil: true, blindNilDeficit: 0, minTeamBid: 4, tenForTwoHundred: true, bagLimit: 5 } },
  ];
  for (const { label, patch } of variants) {
    const settings = { ...defaultSettings(), ...patch };
    for (let seed = 1; seed <= 120; seed++) {
      try { playFullGame(settings, seed); }
      catch (err) { throw new Error(`variant "${label}" seed ${seed}: ${err.message}`); }
    }
  }
});

test('the engine rejects out-of-turn and illegal moves', () => {
  const game = new SpadesGame(defaultSettings(), mulberry32(7));
  game.startGame();
  const turn = game.state.turn;
  const other = (turn + 1) % 4;

  assert.throws(() => game.placeBid(other, { type: 'num', value: 3 }), GameError, 'out of turn bid');
  assert.throws(() => game.placeBid(turn, { type: 'num', value: 0 }), GameError, 'zero is not a number bid');
  assert.throws(() => game.placeBid(turn, { type: 'num', value: 14 }), GameError, 'bid above 13');
  assert.throws(() => game.playCard(turn, game.state.hands[turn][0]), GameError, 'cannot play while bidding');

  for (let i = 0; i < 4; i++) game.placeBid(game.state.turn, { type: 'num', value: 3 });
  assert.equal(game.state.phase, 'playing');

  const seat = game.state.turn;
  assert.throws(() => game.playCard(seat, 'AS'.replace('AS', 'XX')), GameError, 'unknown card');
  assert.throws(() => game.playCard((seat + 1) % 4, game.state.hands[(seat + 1) % 4][0]), GameError, 'out of turn play');
});

test('nil is refused when the host turned it off', () => {
  const game = new SpadesGame({ ...defaultSettings(), allowNil: false }, mulberry32(3));
  game.startGame();
  assert.throws(() => game.placeBid(game.state.turn, { type: 'nil' }), GameError);
});

test('a hand is not visible to its owner during the blind-nil question', () => {
  const settings = { ...defaultSettings(), allowBlindNil: true, blindNilDeficit: 0 };
  const game = new SpadesGame(settings, mulberry32(11));
  game.startGame();
  assert.equal(game.state.phase, 'blind');
  const view = game.viewFor(game.state.turn);
  assert.equal(view.hand.length, 0, 'cards stay face down until the question passes');
  assert.equal(view.handHidden, true);

  for (let i = 0; i < 4; i++) if (game.state.phase === 'blind') game.chooseBlind(game.state.turn, false);
  assert.equal(game.state.phase, 'bidding');
  assert.equal(game.viewFor(0).hand.length, 13, 'cards turn face up once bidding starts');
});

test('a locked-in blind nil skips that seat during bidding', () => {
  const settings = { ...defaultSettings(), allowBlindNil: true, blindNilDeficit: 0 };
  const game = new SpadesGame(settings, mulberry32(23));
  game.startGame();
  const blindSeat = game.state.turn;
  game.chooseBlind(blindSeat, true);
  while (game.state.phase === 'blind') game.chooseBlind(game.state.turn, false);
  assert.deepEqual(game.state.bids[blindSeat], { type: 'blind', value: 0 });
  assert.notEqual(game.state.turn, blindSeat, 'the blind bidder is not asked again');
});

test('a player never sees another hand', () => {
  const game = new SpadesGame(defaultSettings(), mulberry32(5));
  game.startGame();
  const view = game.viewFor(1);
  assert.equal(view.hand.length, 13);
  assert.deepEqual(view.handCounts, [13, 13, 13, 13]);
  assert.equal(JSON.stringify(view).includes('"hands"'), false, 'the full deal is never serialised');
});
