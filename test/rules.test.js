import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, gameWinner, minimumBidFor, sanitizeSettings, scoreHand } from '../server/rules.js';

const S = defaultSettings();
const num = (v) => ({ type: 'num', value: v });
const nil = () => ({ type: 'nil', value: 0 });
const blind = () => ({ type: 'blind', value: 0 });

test('made contract scores ten per trick plus a bag per overtrick', () => {
  const r = scoreHand({ bids: [num(4), num(3), num(3), num(3)], tricksWon: [4, 3, 4, 2], bags: [0, 0], settings: S });
  assert.equal(r.teams[0].contract, 7);
  assert.equal(r.teams[0].tricks, 8);
  assert.equal(r.scoreDelta[0], 71);     // 70 + 1 bag
  assert.equal(r.bags[0], 1);
  assert.equal(r.scoreDelta[1], -60);    // bid 6, took 5 -- set
});

test('a set team loses ten per bid trick and takes no bags', () => {
  const r = scoreHand({ bids: [num(5), num(2), num(3), num(2)], tricksWon: [3, 4, 2, 4], bags: [3, 0], settings: S });
  assert.equal(r.scoreDelta[0], -80);
  assert.equal(r.bags[0], 3, 'bag count is untouched for a set team');
});

test('ten bags costs a hundred and the remainder carries', () => {
  const r = scoreHand({ bids: [num(2), num(3), num(2), num(3)], tricksWon: [4, 3, 3, 3], bags: [8, 0], settings: S });
  // team 0 bid 4, took 7 -> 40 + 3 bags; 8 + 3 = 11 bags -> -100, 1 left over
  assert.equal(r.scoreDelta[0], 40 + 3 - 100);
  assert.equal(r.bags[0], 1);
});

test('a made nil pays the bonus and the partner still needs their own bid', () => {
  const r = scoreHand({ bids: [nil(), num(3), num(5), num(4)], tricksWon: [0, 4, 5, 4], bags: [0, 0], settings: S });
  assert.equal(r.teams[0].contract, 5);
  assert.equal(r.teams[0].nilPoints, 100);
  assert.equal(r.scoreDelta[0], 50 + 100);
});

test('a broken nil costs the bonus and its tricks do not rescue the contract', () => {
  const r = scoreHand({ bids: [nil(), num(3), num(5), num(4)], tricksWon: [2, 4, 3, 4], bags: [0, 0], settings: S });
  assert.equal(r.teams[0].countedTricks, 3, 'nil bidder tricks do not count toward the 5 bid');
  assert.equal(r.scoreDelta[0], -50 - 100, 'set for 5 and the nil fails');
  assert.equal(r.bags[0], 0, 'a set team banks no bags at all');
});

test('a made contract turns a broken nil\u2019s tricks into bags', () => {
  const r = scoreHand({ bids: [nil(), num(3), num(3), num(4)], tricksWon: [2, 4, 3, 4], bags: [0, 0], settings: S });
  assert.equal(r.teams[0].countedTricks, 3, 'the 3 bid is met by the partner alone');
  assert.equal(r.scoreDelta[0], 30 + 2 - 100, 'contract made, 2 bags, nil broken');
  assert.equal(r.bags[0], 2);
});

test('broken-nil-helps-the-team is an option', () => {
  const settings = { ...S, failedNilTricksCountForTeam: true };
  const r = scoreHand({ bids: [nil(), num(3), num(5), num(4)], tricksWon: [2, 4, 3, 4], bags: [0, 0], settings });
  assert.equal(r.teams[0].countedTricks, 5);
  assert.equal(r.scoreDelta[0], 50 - 100);
});

test('blind nil uses its own value', () => {
  const r = scoreHand({ bids: [blind(), num(4), num(4), num(4)], tricksWon: [0, 5, 4, 4], bags: [0, 0], settings: S });
  assert.equal(r.teams[0].nilPoints, 200);
});

test('a double nil team banks only the bonuses, and stolen tricks are bags', () => {
  const r = scoreHand({ bids: [nil(), num(6), nil(), num(7)], tricksWon: [0, 6, 1, 6], bags: [0, 0], settings: S });
  assert.equal(r.teams[0].contract, 0);
  assert.equal(r.scoreDelta[0], 100 - 100 + 1);
  assert.equal(r.bags[0], 1);
});

test('10-for-200 doubles a big contract both ways', () => {
  const settings = { ...S, tenForTwoHundred: true };
  const made = scoreHand({ bids: [num(6), num(1), num(4), num(2)], tricksWon: [6, 1, 4, 2], bags: [0, 0], settings });
  assert.equal(made.scoreDelta[0], 200);
  const set = scoreHand({ bids: [num(6), num(1), num(4), num(2)], tricksWon: [5, 2, 4, 2], bags: [0, 0], settings });
  assert.equal(set.scoreDelta[0], -200);
});

test('bags can be switched off entirely', () => {
  const settings = { ...S, bagsEnabled: false };
  const r = scoreHand({ bids: [num(2), num(3), num(2), num(3)], tricksWon: [5, 3, 2, 3], bags: [0, 0], settings });
  assert.equal(r.scoreDelta[0], 40);
  assert.equal(r.bags[0], 0);
});

test('minimum team bid forces the second partner up', () => {
  const settings = { ...S, minTeamBid: 4 };
  const bids = [num(1), null, null, null];
  assert.equal(minimumBidFor(2, bids, settings), 3);
  assert.equal(minimumBidFor(1, bids, settings), 0, 'the other team is unaffected');
  assert.equal(minimumBidFor(0, [null, null, null, null], settings), 0, 'first to bid is free');
  assert.equal(minimumBidFor(2, [nil(), null, null, null], settings), 0, 'a nil partner carries no share');
});

test('winner needs the target score, and the mercy rule ends a blowout', () => {
  assert.equal(gameWinner([510, 300], S), 0);
  assert.equal(gameWinner([300, 300], S), null);
  assert.equal(gameWinner([520, 530], S), 1, 'both over target: higher score wins');
  assert.equal(gameWinner([520, 520], S), null, 'a tie plays another hand');
  assert.equal(gameWinner([100, -250], S), 0, 'mercy rule');
});

test('settings are sanitised against the schema', () => {
  const out = sanitizeSettings({ targetScore: 300, allowNil: 'yes', bagLimit: 7, bogus: 1 });
  assert.equal(out.targetScore, 300);
  assert.equal(out.allowNil, true);
  assert.equal(out.bagLimit, 10, 'an off-schema value falls back to the default');
  assert.equal('bogus' in out, false);
});
