// Wiring between a catalog entry and the code that actually runs it.
// Adding a game means writing its engine and adding one entry here.
import { SpadesGame } from './game.js';
import { SETTINGS_SCHEMA, defaultSettings, sanitizeSettings } from './rules.js';

export const ENGINES = {
  spades: {
    create: (settings) => new SpadesGame(settings),
    schema: SETTINGS_SCHEMA,
    defaults: defaultSettings,
    sanitize: sanitizeSettings,
  },
};

export const engineFor = (gameId) => ENGINES[gameId] ?? null;
