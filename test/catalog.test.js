import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, gameById, playableGame, DEFAULT_GAME } from '../public/catalog.js';
import { engineFor, ENGINES } from '../server/engines.js';

test('the catalog lists the eight games the picker shows', () => {
  const ids = GAMES.map((g) => g.id);
  assert.deepEqual(ids, ['spades', 'hearts', 'chess', 'checkers', 'pictionary', 'dominoes', 'clubs', 'connect4']);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
});

test('every entry has what the tile needs to render', () => {
  for (const game of GAMES) {
    assert.ok(game.name, `${game.id} has a name`);
    assert.ok(game.mark, `${game.id} has a glyph`);
    assert.ok(game.tagline, `${game.id} has a tagline`);
    assert.ok(game.players, `${game.id} says how many play`);
    assert.ok(['playable', 'soon'].includes(game.status), `${game.id} has a known status`);
  }
});

test('spades is the only game wired up so far', () => {
  const playable = GAMES.filter((g) => g.status === 'playable').map((g) => g.id);
  assert.deepEqual(playable, ['spades']);
  assert.equal(DEFAULT_GAME, 'spades');
});

test('every playable game has an engine, and no engine is orphaned', () => {
  for (const game of GAMES) {
    const engine = engineFor(game.id);
    if (game.status === 'playable') {
      assert.ok(engine, `${game.id} is playable so it needs an engine`);
      assert.equal(typeof engine.create, 'function');
      assert.ok(Array.isArray(engine.schema), `${game.id} exposes a settings schema`);
      assert.equal(typeof engine.defaults, 'function');
      assert.equal(typeof engine.sanitize, 'function');
    } else {
      assert.equal(engine, null, `${game.id} is marked soon so it must not claim an engine`);
    }
  }
  for (const id of Object.keys(ENGINES)) {
    assert.ok(gameById(id), `engine "${id}" has a catalog entry`);
  }
});

test('lookups reject unknown and unfinished games', () => {
  assert.equal(gameById('spades').name, 'Spades');
  assert.equal(gameById('nonsense'), null);
  assert.ok(playableGame('spades'));
  assert.equal(playableGame('chess'), null, 'chess is listed but not playable');
  assert.equal(playableGame('nonsense'), null);
});

test('a playable engine produces a working game', () => {
  const engine = engineFor('spades');
  const game = engine.create(engine.defaults());
  game.startGame();
  assert.ok(['blind', 'bidding'].includes(game.state.phase));
  assert.equal(game.state.hands.flat().length, 52);
});
