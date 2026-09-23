// The game catalog. Plain ES module with no Node or browser APIs, so the
// server and the client import the same file and cannot drift apart.

export const GAMES = [
  {
    id: 'spades', mark: '\u2660', name: 'Spades', status: 'playable',
    players: '4 players', seats: 4,
    tagline: 'Partners, bids and bags.',
    blurb: 'Call your tricks, cover your partner, and try not to sandbag your way into a hundred-point hole.',
  },
  {
    id: 'hearts', mark: '\u2665', name: 'Hearts', status: 'soon',
    players: '4 players', seats: 4,
    tagline: 'Dodge the points, or take them all.',
  },
  {
    id: 'chess', mark: '\u265E', name: 'Chess', status: 'soon',
    players: '2 players', seats: 2,
    tagline: 'The long one.',
  },
  {
    id: 'checkers', mark: '\u25CF', name: 'Checkers', status: 'soon',
    players: '2 players', seats: 2,
    tagline: 'Quick, and quicker to argue about.',
  },
  {
    id: 'pictionary', mark: '\u270E', name: 'Pictionary', status: 'soon',
    players: '3 to 8', seats: 8,
    tagline: 'Draw with your thumb, explain later.',
  },
  {
    id: 'dominoes', mark: '\u2685', name: 'Dominoes', status: 'soon',
    players: '2 to 4', seats: 4,
    tagline: 'Count to a multiple of five.',
  },
  {
    id: 'clubs', mark: '\u2663', name: 'Clubs', status: 'soon',
    players: '4 players', seats: 4,
    tagline: 'Tell us how you play it.',
  },
  {
    id: 'connect4', mark: '\u25C9', name: 'Connect 4', status: 'soon',
    players: '2 players', seats: 2,
    tagline: 'Four in a row, diagonals included.',
  },
];

export const gameById = (id) => GAMES.find((g) => g.id === id) ?? null;
export const playableGame = (id) => {
  const game = gameById(id);
  return game && game.status === 'playable' ? game : null;
};
export const DEFAULT_GAME = 'spades';
