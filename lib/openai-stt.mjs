const DEFAULT_MODEL = 'whisper-1';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MIME_TYPE = 'audio/webm';
const SUPPORTED_MIME_TYPES = new Set([
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/oga',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm'
]);

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

export function normalizeOpenAiAudioMimeType(mimeType = DEFAULT_MIME_TYPE) {
  const baseType = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (SUPPORTED_MIME_TYPES.has(baseType)) return baseType;
  return DEFAULT_MIME_TYPE;
}

function extensionForMime(mimeType) {
  const normalizedMimeType = normalizeOpenAiAudioMimeType(mimeType);
  if (/webm/i.test(normalizedMimeType)) return 'webm';
  if (/oga/i.test(normalizedMimeType)) return 'oga';
  if (/ogg/i.test(normalizedMimeType)) return 'ogg';
  if (/wav/i.test(normalizedMimeType)) return 'wav';
  if (/mpeg|mpga|mp3/i.test(normalizedMimeType)) return 'mp3';
  if (/mp4/i.test(normalizedMimeType)) return 'mp4';
  if (/m4a/i.test(normalizedMimeType)) return 'm4a';
  if (/flac/i.test(normalizedMimeType)) return 'flac';
  return 'webm';
}

export function getOpenAiSttConfig(env = process.env) {
  return {
    provider: 'openai',
    apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
    model: env.OPENAI_TRANSCRIBE_MODEL || env.OPENAI_STT_MODEL || DEFAULT_MODEL,
    endpoint: env.OPENAI_TRANSCRIBE_BASE_URL || DEFAULT_ENDPOINT,
    preferred: /^true|1|yes$/i.test(String(env.OPENAI_STT_PREFERRED || 'false')),
    language: env.OPENAI_TRANSCRIBE_LANGUAGE || 'ru',
    prompt: env.OPENAI_TRANSCRIBE_PROMPT || [
      'Медицинский прием на русском и казахском.',
      'Термины: Дамумед, реабилитация, психолог, жалобы, анамнез, динамика, рекомендации.'
    ].join(' ')
  };
}

export async function transcribeOpenAiAudio({
  audioBase64,
  mimeType = DEFAULT_MIME_TYPE,
  model,
  endpoint,
  apiKey,
  language = 'ru',
  prompt = ''
}) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured on the local backend.');
  }
  if (!audioBase64) {
    throw new Error('audioBase64 is required for OpenAI transcription.');
  }

  const bytes = Buffer.from(audioBase64, 'base64');
  const normalizedMimeType = normalizeOpenAiAudioMimeType(mimeType);
  const extension = extensionForMime(normalizedMimeType);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: normalizedMimeType }), `speech.${extension}`);
  form.append('model', model || DEFAULT_MODEL);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (compactText(prompt)) form.append('prompt', compactText(prompt));

  const response = await fetch(endpoint || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const body = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(parsed?.error?.message || body || response.statusText);
  }

  return {
    text: compactText(parsed?.text),
    raw: parsed
  };
}
