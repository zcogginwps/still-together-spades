import { makeDeck, shuffle, sortHand, suitOf, trickWinnerIndex } from './deck.js';
import { defaultSettings, gameWinner, minimumBidFor, scoreHand, seatsOfTeam, TEAM_OF_SEAT } from './rules.js';

export const PHASES = ['lobby', 'blind', 'bidding', 'playing', 'trickEnd', 'handEnd', 'gameEnd'];

const next = (seat) => (seat + 1) % 4;

export class SpadesGame {
  constructor(settings = defaultSettings(), random = Math.random) {
    this.settings = settings;
    this.random = random;
    this.state = {
      phase: 'lobby',
      handNumber: 0,
      dealer: 0,
      turn: 0,
      hands: [[], [], [], []],
      bids: [null, null, null, null],
      blindChoices: [null, null, null, null],
      tricksWon: [0, 0, 0, 0],
      trick: [],
      trickWinner: null,
      spadesBroken: false,
      scores: [0, 0],
      bags: [0, 0],
      lastTrick: null,
      lastHandResult: null,
      winner: null,
      history: [],
      continueReady: [false, false, false, false],
    };
  }

  get s() { return this.state; }

  // ---------------------------------------------------------------- lifecycle

  startGame() {
    const s = this.state;
    s.scores = [0, 0];
    s.bags = [0, 0];
    s.history = [];
    s.handNumber = 0;
    s.winner = null;
    s.lastHandResult = null;
    s.dealer = Math.floor(this.random() * 4);
    this.startHand();
  }

  startHand() {
    const s = this.state;
    s.handNumber += 1;
    s.bids = [null, null, null, null];
    s.blindChoices = [null, null, null, null];
    s.tricksWon = [0, 0, 0, 0];
    s.trick = [];
    s.trickWinner = null;
    s.lastTrick = null;
    s.lastHandResult = null;
    s.spadesBroken = false;
    s.continueReady = [false, false, false, false];

    const deck = shuffle(makeDeck(), this.random);
    for (let seat = 0; seat < 4; seat++) {
      s.hands[seat] = sortHand(deck.slice(seat * 13, seat * 13 + 13));
    }

    s.turn = next(s.dealer);

    const eligible = [0, 1, 2, 3].filter((seat) => this.canBidBlind(seat));
    if (eligible.length > 0) {
      // Nobody may look at their cards until the blind-nil question has gone around.
      for (let seat = 0; seat < 4; seat++) if (!this.canBidBlind(seat)) s.blindChoices[seat] = false;
      s.phase = 'blind';
      this.advanceBlindTurn(true);
    } else {
      s.phase = 'bidding';
    }
  }

  canBidBlind(seat) {
    const s = this.state;
    if (!this.settings.allowBlindNil || !this.settings.allowNil) return false;
    const team = TEAM_OF_SEAT[seat];
    const deficit = s.scores[1 - team] - s.scores[team];
    return deficit >= this.settings.blindNilDeficit;
  }

  /** Move the blind-nil question to the next seat that still has to answer. */
  advanceBlindTurn(fromDealerLeft = false) {
    const s = this.state;
    let seat = fromDealerLeft ? next(s.dealer) : next(s.turn);
    for (let i = 0; i < 4; i++) {
      if (s.blindChoices[seat] === null) { s.turn = seat; return; }
      seat = next(seat);
    }
    // Everyone has answered: lock in the blind bids and open normal bidding.
    for (let i = 0; i < 4; i++) {
      if (s.blindChoices[i] === true) s.bids[i] = { type: 'blind', value: 0 };
    }
    s.phase = 'bidding';
    s.turn = next(s.dealer);
    this.skipSettledBidders();
  }

  skipSettledBidders() {
    const s = this.state;
    for (let i = 0; i < 4; i++) {
      if (s.bids[s.turn] === null) return;
      s.turn = next(s.turn);
    }
    this.beginPlay();
  }

  beginPlay() {
    const s = this.state;
    s.phase = 'playing';
    s.turn = next(s.dealer);
  }

  // ------------------------------------------------------------------ actions

  chooseBlind(seat, wantsBlind) {
    const s = this.state;
    if (s.phase !== 'blind') throw new GameError('Not taking blind bids right now.');
    if (s.turn !== seat) throw new GameError('It is not your turn.');
    if (wantsBlind && !this.canBidBlind(seat)) throw new GameError('You are not eligible to bid blind.');
    s.blindChoices[seat] = Boolean(wantsBlind);
    this.advanceBlindTurn();
  }

  placeBid(seat, bid) {
    const s = this.state;
    if (s.phase !== 'bidding') throw new GameError('Not taking bids right now.');
    if (s.turn !== seat) throw new GameError('It is not your turn to bid.');
    if (s.bids[seat] !== null) throw new GameError('You already bid.');

    if (bid.type === 'nil') {
      if (!this.settings.allowNil) throw new GameError('Nil is turned off in this game.');
      s.bids[seat] = { type: 'nil', value: 0 };
    } else {
      const value = Number(bid.value);
      if (!Number.isInteger(value) || value < 1 || value > 13) throw new GameError('Bid must be between 1 and 13.');
      const min = minimumBidFor(seat, s.bids, this.settings);
      if (value < min) throw new GameError(`Your team must bid at least ${this.settings.minTeamBid}, so your minimum is ${min}.`);
      s.bids[seat] = { type: 'num', value };
    }

    s.turn = next(s.turn);
    this.skipSettledBidders();
  }

  legalCards(seat) {
    const s = this.state;
    if (s.phase !== 'playing' || s.turn !== seat) return [];
    const hand = s.hands[seat];
    if (s.trick.length === 0) {
      if (!this.settings.spadesBrokenRequired || s.spadesBroken) return hand.slice();
      const offSuit = hand.filter((c) => suitOf(c) !== 'S');
      return offSuit.length ? offSuit : hand.slice();
    }
    const led = suitOf(s.trick[0].card);
    const following = hand.filter((c) => suitOf(c) === led);
    return following.length ? following : hand.slice();
  }

  playCard(seat, card) {
    const s = this.state;
    if (s.phase !== 'playing') throw new GameError('Cards are not in play right now.');
    if (s.turn !== seat) throw new GameError('It is not your turn.');
    if (!s.hands[seat].includes(card)) throw new GameError('You do not hold that card.');
    if (!this.legalCards(seat).includes(card)) {
      const led = s.trick.length ? suitOf(s.trick[0].card) : null;
      throw new GameError(led ? 'You have to follow suit.' : 'Spades have not been broken yet.');
    }

    s.hands[seat] = s.hands[seat].filter((c) => c !== card);
    s.trick.push({ seat, card });
    if (suitOf(card) === 'S') s.spadesBroken = true;

    if (s.trick.length === 4) {
      const winnerIdx = trickWinnerIndex(s.trick);
      const winnerSeat = s.trick[winnerIdx].seat;
      s.tricksWon[winnerSeat] += 1;
      s.trickWinner = winnerSeat;
      s.lastTrick = { plays: s.trick.slice(), winner: winnerSeat };
      s.phase = 'trickEnd';
    } else {
      s.turn = next(s.turn);
    }
  }

  /** Called by the room once the finished trick has been on screen long enough. */
  resolveTrick() {
    const s = this.state;
    if (s.phase !== 'trickEnd') return;
    const winnerSeat = s.trickWinner;
    s.trick = [];
    s.trickWinner = null;
    if (s.hands.every((h) => h.length === 0)) {
      this.finishHand();
    } else {
      s.phase = 'playing';
      s.turn = winnerSeat;
    }
  }

  finishHand() {
    const s = this.state;
    const result = scoreHand({
      bids: s.bids, tricksWon: s.tricksWon, bags: s.bags, settings: this.settings,
    });
    s.scores = [s.scores[0] + result.scoreDelta[0], s.scores[1] + result.scoreDelta[1]];
    s.bags = result.bags;
    s.lastHandResult = {
      handNumber: s.handNumber,
      bids: s.bids.map((b) => ({ ...b })),
      tricksWon: s.tricksWon.slice(),
      teams: result.teams,
      scoresAfter: s.scores.slice(),
      bagsAfter: s.bags.slice(),
    };
    s.history.push(s.lastHandResult);
    s.continueReady = [false, false, false, false];

    const winner = gameWinner(s.scores, this.settings);
    if (winner !== null) {
      s.winner = winner;
      s.phase = 'gameEnd';
    } else {
      s.phase = 'handEnd';
    }
  }

  nextHand() {
    const s = this.state;
    if (s.phase !== 'handEnd') return;
    s.dealer = next(s.dealer);
    this.startHand();
  }

  // --------------------------------------------------------------------- view

  /** A snapshot safe to send to one seat. `seat` is null for spectators. */
  viewFor(seat) {
    const s = this.state;
    const hideHands = s.phase === 'blind';
    return {
      phase: s.phase,
      handNumber: s.handNumber,
      dealer: s.dealer,
      turn: s.turn,
      hand: seat === null || hideHands ? [] : s.hands[seat],
      handHidden: hideHands,
      handCounts: s.hands.map((h) => h.length),
      legal: seat === null ? [] : this.legalCards(seat),
      bids: s.bids,
      blindChoices: s.blindChoices,
      minBid: seat === null ? 0 : minimumBidFor(seat, s.bids, this.settings),
      canBidBlind: seat === null ? false : this.canBidBlind(seat),
      tricksWon: s.tricksWon,
      teamBids: [0, 1].map((t) => seatsOfTeam(t).reduce(
        (sum, st) => sum + (s.bids[st] && s.bids[st].type === 'num' ? s.bids[st].value : 0), 0)),
      teamTricks: [0, 1].map((t) => seatsOfTeam(t).reduce((sum, st) => sum + s.tricksWon[st], 0)),
      trick: s.trick,
      trickWinner: s.trickWinner,
      lastTrick: s.lastTrick,
      spadesBroken: s.spadesBroken,
      scores: s.scores,
      bags: s.bags,
      lastHandResult: s.lastHandResult,
      winner: s.winner,
      continueReady: s.continueReady,
      historyCount: s.history.length,
      // Compact per-hand totals: enough for the scoreboard, small enough to
      // resend on every broadcast, and correct for someone who just reconnected.
      history: s.history.map((h) => ({
        handNumber: h.handNumber,
        totals: [h.teams[0].total, h.teams[1].total],
        scoresAfter: h.scoresAfter,
      })),
    };
  }
}

export class GameError extends Error {}
