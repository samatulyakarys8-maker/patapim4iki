export const BREAK_MODE_COMMANDS = ['play game', 'break mode'];
export const BREAK_MODE_LAYOUT = 'overlay';
export const BREAK_WIDGET_DEFAULTS = {
  minHeight: 420,
  gravity: 0.2,
  flapVelocity: -4.0,
  pipeSpeed: 1.8,
  pipeGap: 120,
  pipeWidth: 32,
  spawnEveryFrames: 140
};

export function normalizeBreakModeCommand(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isBreakModeCommand(value = '') {
  return BREAK_MODE_COMMANDS.includes(normalizeBreakModeCommand(value));
}
