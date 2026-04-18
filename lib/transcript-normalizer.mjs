import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LEXICON_PATH = path.join(__dirname, '..', 'data', 'generated', 'voice_lexicon.json');

const FILLER_PATTERNS = [
  /(^|\s)ну(?=\s|$)/giu,
  /(^|\s)ээ+(?=\s|$)/giu,
  /(^|\s)эм+(?=\s|$)/giu,
  /(^|\s)мм+(?=\s|$)/giu,
  /(^|\s)как бы(?=\s|$)/giu,
  /(^|\s)в общем(?=\s|$)/giu,
  /(^|\s)короче(?=\s|$)/giu,
  /(^|\s)значит(?=\s|$)/giu
];

const LATIN_TO_CYRILLIC_WORDS = {
  otkroi: 'открой',
  otkroy: 'открой',
  naydi: 'найди',
  naidi: 'найди',
  pereydi: 'перейди',
  pacient: 'пациент',
  patient: 'пациент',
  priem: 'прием',
  nurzhan: 'нуржан',
  temirbay: 'темирбай',
  tomiris: 'томирис',
  amina: 'амина',
  aikunim: 'айкуним',
  rahmetolla: 'рахметолла',
  rahmetula: 'рахметула',
  ankhar: 'анкар',
  ankar: 'анкар'
};

const LATIN_CHAR_GROUPS = [
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['zh', 'ж'],
  ['ya', 'я'],
  ['yu', 'ю'],
  ['yo', 'е']
];

const LATIN_CHAR_MAP = {
  a: 'а',
  b: 'б',
  c: 'к',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'х',
  i: 'и',
  j: 'ж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'к',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'кс',
  y: 'й',
  z: 'з'
};

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function transliterateLatinWord(word) {
  const lower = compactText(word).toLowerCase();
  if (!lower) return '';
  if (LATIN_TO_CYRILLIC_WORDS[lower]) return LATIN_TO_CYRILLIC_WORDS[lower];
  let text = lower;
  for (const [latin, cyrillic] of LATIN_CHAR_GROUPS) {
    text = text.replaceAll(latin, cyrillic);
  }
  return text
    .split('')
    .map((char) => LATIN_CHAR_MAP[char] || char)
    .join('')
    .replace(/открои/g, 'открой')
    .replace(/наиди/g, 'найди')
    .replace(/переиди/g, 'перейди');
}

export function normalizeVoiceToken(token) {
  const compact = compactText(token)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim();
  if (!compact) return '';
  const transliterated = /^[a-z-]+$/i.test(compact) ? transliterateLatinWord(compact) : compact;
  return transliterated
    .replace(/[іi]/g, 'и')
    .replace(/ң/g, 'н')
    .replace(/ғ/g, 'г')
    .replace(/қ/g, 'к')
    .replace(/ұ/g, 'у')
    .replace(/ү/g, 'у')
    .replace(/ө/g, 'о')
    .replace(/ә/g, 'а')
    .replace(/һ/g, 'х')
    .trim();
}

export function tokenizeVoiceText(rawText, options = {}) {
  const normalized = normalizeTranscript(rawText, options).normalized_transcript;
  return normalized
    .split(/\s+/)
    .map((token) => normalizeVoiceToken(token))
    .filter(Boolean);
}

function loadLexicon(lexicon = null) {
  if (lexicon && typeof lexicon === 'object') return lexicon;
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_LEXICON_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function applyFillers(text) {
  const removed = [];
  let next = text;
  for (const pattern of FILLER_PATTERNS) {
    next = next.replace(pattern, (match, prefix = '') => {
      removed.push(compactText(match).toLowerCase());
      if (prefix) return prefix;
      return ' ';
    });
  }
  return { text: next, removed };
}

function applyRepeatedTokenCleanup(text) {
  const words = compactText(text).split(' ').filter(Boolean);
  const cleaned = [];
  for (const word of words) {
    if (cleaned[cleaned.length - 1] === word) continue;
    cleaned.push(word);
  }
  return cleaned.join(' ');
}

function applyAsrConfusions(text, lexicon) {
  const replacements = [];
  let next = text;
  const confusions = lexicon.asrConfusions || {};
  for (const [canonical, variants] of Object.entries(confusions)) {
    for (const variant of variants || []) {
      const from = compactText(variant).toLowerCase().replace(/ё/g, 'е');
      const to = compactText(canonical).toLowerCase().replace(/ё/g, 'е');
      if (!from || from === to) continue;
      const pattern = new RegExp(`(^|\\\\s)${escapeRegExp(from)}(?=\\\\s|$)`, 'giu');
      next = next.replace(pattern, (match, prefix) => {
        replacements.push({ from, to, reason: 'voice_lexicon_asr_confusion' });
        return `${prefix}${to}`;
      });
    }
  }
  return { text: next, replacements };
}

function applyLatinWords(text) {
  const replacements = [];
  const next = text.replace(/\b[a-z]{3,}\b/giu, (match) => {
    const mapped = transliterateLatinWord(match);
    if (!mapped) return match;
    replacements.push({ from: match, to: mapped, reason: 'latin_name_hint' });
    return mapped;
  });
  return { text: next, replacements };
}

function detectLanguageHint(text) {
  const hasKazakh = /[әғқңөұүһі]/iu.test(text);
  const hasCyrillic = /[а-яё]/iu.test(text);
  const hasLatin = /[a-z]/iu.test(text);
  if ((hasKazakh && hasCyrillic) || (hasLatin && hasCyrillic)) return 'mixed';
  if (hasKazakh) return 'kk';
  if (hasCyrillic) return 'ru';
  return 'unknown';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeTranscript(rawText, options = {}) {
  const lexicon = loadLexicon(options.lexicon);
  const raw = compactText(rawText);
  let text = raw.normalize('NFC').toLowerCase().replace(/ё/g, 'е');
  text = text.replace(/[“”«»]/g, '"').replace(/[.,!?;:]+/g, ' ');

  const fillerResult = applyFillers(text);
  text = fillerResult.text;

  const latinResult = applyLatinWords(text);
  text = latinResult.text;

  const asrResult = applyAsrConfusions(text, lexicon);
  text = asrResult.text;

  text = applyRepeatedTokenCleanup(text);
  text = compactText(text);

  return {
    raw_transcript: raw,
    normalized_transcript: text,
    removed_fillers: [...new Set(fillerResult.removed)],
    replacements: [...latinResult.replacements, ...asrResult.replacements],
    language_hint: detectLanguageHint(text || raw),
    confidence_adjustment: fillerResult.removed.length ? -0.03 : 0
  };
}
