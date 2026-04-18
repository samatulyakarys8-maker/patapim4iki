export const BREAK_MODE_COMMANDS = ['play game', 'break mode'];
export const BREAK_MODE_LAYOUT = 'overlay';
export const BREAK_WIDGET_DEFAULTS = {
  minHeight: 420,
  gravity: 0.28,
  flapVelocity: -4.5,
  pipeSpeed: 1.9,
  pipeGap: 96,
  pipeWidth: 36,
  spawnEveryFrames: 126
};

export function normalizeBreakModeCommand(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isBreakModeCommand(value = '') {
  return BREAK_MODE_COMMANDS.includes(normalizeBreakModeCommand(value));
}
