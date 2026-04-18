import { DEFAULT_TAB_ALIASES, DEFAULT_VOICE_LEXICON } from './voice-lexicon.mjs';
import {
  normalizeTranscript as normalizeCanonicalTranscript,
  normalizeVoiceToken,
  tokenizeVoiceText
} from './transcript-normalizer.mjs';

const TAB_SYNONYMS = DEFAULT_TAB_ALIASES;

const COMMAND_WORDS = new Set([
  'открой',
  'открыть',
  'найди',
  'найти',
  'пациента',
  'пациент',
  'карточку',
  'карта',
  'карту',
  'перейди',
  'перейти',
  'иди',
  'к',
  'в',
  'на',
  'запись',
  'прием',
  'приём',
  'первичный',
  'осмотр',
  'пожалуйста',
  'ребенка',
  'ребенок',
  'ребенка',
  'зайди',
  'зайти',
  'покажи',
  'показать'
]);

const FILLER_WORDS = new Set([
  'ну',
  'так',
  'давай',
  'пожалуйста',
  'можешь',
  'можно',
  'мне',
  'тут',
  'там',
  'сейчас'
]);

export function normalizeVoiceText(text) {
  return normalizeCanonicalTranscript(text).normalized_transcript;
}

function normalizedTokens(text) {
  return tokenizeVoiceText(text);
}

export function normalizeTranscript(text, lexicon = DEFAULT_VOICE_LEXICON) {
  const canonical = normalizeCanonicalTranscript(text, { lexicon });
  return {
    rawTranscript: String(text || ''),
    normalizedText: canonical.normalized_transcript,
    tokens: tokenizeVoiceText(canonical.normalized_transcript, { lexicon }),
    rewritesApplied: canonical.replacements,
    canonical
  };
}

function baseResult(transcript, overrides = {}) {
  const normalizedTranscript = normalizeVoiceText(transcript);
  return {
    intent: 'unknown',
    patientQuery: null,
    matchedPatient: null,
    confidence: 0,
    actionTarget: null,
    needsLlmFallback: true,
    fallbackReason: 'intent_not_found',
    debug: {
      transcript: String(transcript || ''),
      normalizedTranscript,
      parsedCommand: 'unknown',
      extractedPatientQuery: null,
      matchedSynonym: null
    },
    ...overrides
  };
}

function matchTab(normalizedTranscript) {
  return Object.entries(TAB_SYNONYMS)
    .flatMap(([target, synonyms]) => synonyms.map((synonym) => ({ target, synonym })))
    .filter((item) => normalizedTranscript.includes(normalizeVoiceText(item.synonym)))
    .sort((a, b) => normalizeVoiceText(b.synonym).length - normalizeVoiceText(a.synonym).length)[0] || null;
}

export function extractPatientQuery(transcript) {
  const tokens = tokenizeVoiceText(transcript)
    .filter(Boolean)
    .filter((token) => !COMMAND_WORDS.has(token))
    .filter((token) => !FILLER_WORDS.has(token));
  return tokens.join(' ').trim() || null;
}

export function parseVoiceCommand(transcript, options = {}) {
  const normalization = normalizeTranscript(transcript, options.lexicon || DEFAULT_VOICE_LEXICON);
  const normalizedTranscript = normalization.normalizedText;
  if (!normalizedTranscript) return baseResult(transcript);

  if (/сохрани.*закро|сохранить.*закры|закро.*прием|заверш.*прием/.test(normalizedTranscript)) {
    return baseResult(transcript, {
      intent: 'save_record',
      confidence: 0.94,
      actionTarget: 'save-and-close',
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'save_record',
        extractedPatientQuery: null,
        matchedSynonym: 'save-and-close',
        normalization
      }
    });
  }

  if (/сохрани|сохранить/.test(normalizedTranscript)) {
    return baseResult(transcript, {
      intent: 'save_record',
      confidence: 0.93,
      actionTarget: /закрой|закрыть/.test(normalizedTranscript) ? 'save-and-close' : 'save',
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'save_record',
        extractedPatientQuery: null,
        matchedSynonym: 'сохрани',
        normalization
      }
    });
  }

  if (/сформир.*расписани|созд.*расписани|расписание процедур|график занятий|сформир.*график|сдел.*расписани|сдел.*график/.test(normalizedTranscript)) {
    return baseResult(transcript, {
      intent: 'generate_schedule',
      confidence: 0.9,
      actionTarget: 'procedure-schedule',
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'generate_schedule',
        extractedPatientQuery: null,
        matchedSynonym: 'расписание',
        normalization
      }
    });
  }

  if (/отмет.*процедур.*выполн|выполнен/.test(normalizedTranscript)) {
    return baseResult(transcript, {
      intent: 'complete_service',
      confidence: 0.9,
      actionTarget: 'completed',
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'complete_service',
        extractedPatientQuery: null,
        matchedSynonym: 'выполненной',
        normalization
      }
    });
  }

  if (/вернис.*расписани|назад.*расписани|открой.*расписани/.test(normalizedTranscript)) {
    return baseResult(transcript, {
      intent: 'return_to_schedule',
      confidence: 0.88,
      actionTarget: 'schedule',
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'return_to_schedule',
        extractedPatientQuery: null,
        matchedSynonym: 'расписание',
        normalization
      }
    });
  }

  const tabMatch = matchTab(normalizedTranscript);
  if (tabMatch) {
    return baseResult(transcript, {
      intent: 'open_tab',
      confidence: 0.92,
      actionTarget: tabMatch.target,
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'open_tab',
        extractedPatientQuery: null,
        matchedSynonym: tabMatch.synonym,
        normalization
      }
    });
  }

  if (/первичн|осмотр|при[её]м/.test(normalizedTranscript)) {
    const patientQuery = extractPatientQuery(transcript);
    return baseResult(transcript, {
      intent: 'open_primary_visit',
      patientQuery,
      confidence: patientQuery ? 0.84 : 0.8,
      actionTarget: 'patient',
      needsLlmFallback: false,
      fallbackReason: null,
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'open_primary_visit',
        extractedPatientQuery: patientQuery,
        matchedSynonym: 'primary-visit',
        normalization
      }
    });
  }

  if (/открой|найди|перейди|карточк|пациент|прием|приём|зайди|покажи/.test(normalizedTranscript)) {
    const patientQuery = extractPatientQuery(transcript);
    return baseResult(transcript, {
      intent: 'open_patient',
      patientQuery,
      confidence: patientQuery ? 0.78 : 0.42,
      actionTarget: 'patient',
      needsLlmFallback: !patientQuery,
      fallbackReason: patientQuery ? null : 'patient_query_not_found',
      debug: {
        transcript,
        normalizedTranscript,
        parsedCommand: 'open_patient',
        extractedPatientQuery: patientQuery,
        matchedSynonym: 'patient-command',
        normalization
      }
    });
  }

  return baseResult(transcript);
}

function editDistance(a, b) {
  const left = normalizeVoiceToken(a);
  const right = normalizeVoiceToken(b);
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)));
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }
  return matrix[left.length][right.length];
}

function tokenScore(queryToken, nameToken) {
  if (!queryToken || !nameToken) return 0;
  if (queryToken === nameToken) return 1;
  if (Math.min(queryToken.length, nameToken.length) >= 4 && (nameToken.includes(queryToken) || queryToken.includes(nameToken))) return 0.86;
  if (queryToken.length >= 4 && nameToken.length >= 4) {
    const distance = editDistance(queryToken, nameToken);
    const maxLength = Math.max(queryToken.length, nameToken.length);
    const similarity = 1 - distance / maxLength;
    if (similarity >= 0.72) return similarity;
  }
  return 0;
}

function patientAliases(patient, lexicon) {
  const fullName = patient.full_name || '';
  const nameTokens = normalizedTokens(fullName);
  const aliases = [
    fullName,
    ...fullName.split(/\s+/).filter(Boolean),
    nameTokens.join('')
  ];
  for (let index = 0; index < nameTokens.length - 1; index += 1) {
    const left = nameTokens[index];
    const right = nameTokens[index + 1];
    aliases.push(`${left}${right}`);
    if (left.endsWith('й')) {
      aliases.push(`${left.slice(0, -1)}я${right}`);
    }
    if (left.endsWith('и')) {
      aliases.push(`${left.slice(0, -1)}я${right}`);
    }
  }
  for (const [canonical, values] of Object.entries(lexicon.patientAliases || {})) {
    const haystack = normalizeVoiceText(`${canonical} ${(values || []).join(' ')}`);
    if (normalizedTokens(fullName).some((token) => haystack.includes(token))) {
      aliases.push(canonical, ...(values || []));
    }
  }
  return [...new Set(aliases.filter(Boolean))];
}

function visiblePatientIds(options = {}) {
  const visibleCards = options.screenContext?.visible_slot_cards || [];
  return new Set(
    visibleCards
      .map((card) => card.patient_id || null)
      .filter(Boolean)
  );
}

function activeSchedulePatientIds(runtime) {
  const day = runtime?.scheduleDays?.find((item) => item.date === runtime.currentDate) || runtime?.scheduleDays?.[0];
  return new Set(
    (day?.slots || [])
      .filter((slot) => slot.patient_id)
      .map((slot) => slot.patient_id)
  );
}

function providerBonus(patient, runtime) {
  const providers = runtime?.providers || [];
  if (!providers.length || !patient?.patient_id) return 0;
  const attachedProvider = providers.find((provider) => (provider.attached_patient_ids || []).includes(patient.patient_id));
  return attachedProvider ? 0.02 : 0;
}

function candidateNameQueries(patientQuery) {
  const normalized = normalizeVoiceText(patientQuery);
  const tokens = normalized.split(' ').filter((token) => token && !COMMAND_WORDS.has(token) && !FILLER_WORDS.has(token));
  const candidates = new Set([normalized, tokens.join(' ')]);
  for (let size = 1; size <= Math.min(3, tokens.length); size += 1) {
    candidates.add(tokens.slice(-size).join(' '));
  }
  return [...candidates].filter(Boolean);
}

export function resolvePatientQuery(patientQuery, patients = [], options = {}) {
  const lexicon = options.lexicon || DEFAULT_VOICE_LEXICON;
  const queryVariants = candidateNameQueries(patientQuery);
  const queryTokens = normalizedTokens(queryVariants[0] || patientQuery);
  if (!queryTokens.length) {
    return { matchedPatient: null, candidates: [], confidence: 0, status: 'not_found' };
  }
  const visiblePatients = visiblePatientIds(options);
  const schedulePatients = activeSchedulePatientIds(options.runtime);
  const selectedPatientId = options.screenContext?.selected_patient_id || null;
  const selectedPatientName = normalizeVoiceText(options.screenContext?.selected_patient_name || '');

  const candidates = patients
    .map((patient) => {
      const nameTokens = normalizedTokens(patient.full_name);
      const aliasTokens = patientAliases(patient, lexicon).flatMap(normalizedTokens);
      const allNameTokens = [...new Set([...nameTokens, ...aliasTokens])];
      const bestVariant = queryVariants
        .map((variant) => {
          const variantTokens = normalizedTokens(variant);
          const tokenScores = variantTokens.map((queryToken) => Math.max(...allNameTokens.map((nameToken) => tokenScore(queryToken, nameToken)), 0));
          const average = tokenScores.length
            ? tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length
            : 0;
          const coverageBonus = tokenScores.length
            ? tokenScores.filter((score) => score >= 0.72).length / tokenScores.length * 0.12
            : 0;
          const exactBonus = variantTokens.some((token) => nameTokens.includes(token)) ? 0.06 : 0;
          const exactPhraseBonus = normalizeVoiceText(patient.full_name).includes(normalizeVoiceText(variant)) ? 0.08 : 0;
          return {
            variant,
            variantTokens,
            tokenScores,
            score: Math.min(1, average + coverageBonus + exactBonus + exactPhraseBonus)
          };
        })
        .sort((a, b) => b.score - a.score)[0] || { variant: patientQuery, variantTokens: queryTokens, tokenScores: [], score: 0 };
      const tokenScores = bestVariant.tokenScores;
      const average = tokenScores.reduce((sum, score) => sum + score, 0) / queryTokens.length;
      const visibleBonus = visiblePatients.has(patient.patient_id) ? 0.08 : 0;
      const scheduleBonus = schedulePatients.has(patient.patient_id) ? 0.05 : 0;
      const selectedBonus = selectedPatientId === patient.patient_id || (selectedPatientName && normalizeVoiceText(patient.full_name) === selectedPatientName) ? 0.12 : 0;
      const score = Math.min(1, (bestVariant.score || average) + visibleBonus + scheduleBonus + selectedBonus + providerBonus(patient, options.runtime));
      const reasons = [
        ...bestVariant.variantTokens.map((token, index) => `${token}:${(tokenScores[index] || 0).toFixed(2)}`),
        visibleBonus ? `visible:+${visibleBonus.toFixed(2)}` : null,
        scheduleBonus ? `schedule:+${scheduleBonus.toFixed(2)}` : null,
        selectedBonus ? `selected:+${selectedBonus.toFixed(2)}` : null
      ].filter(Boolean);
      return { patient, score: Number(score.toFixed(3)), reasons, queryVariant: bestVariant.variant };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = candidates[0] || null;
  if (!top || top.score < 0.68) {
    return { matchedPatient: null, candidates, confidence: top?.score || 0, status: 'not_found' };
  }
  const second = candidates[1] || null;
  if (second && top.score - second.score < 0.12) {
    return { matchedPatient: null, candidates, confidence: top.score, status: 'ambiguous' };
  }
  if (top.score < 0.84) {
    return { matchedPatient: null, candidates, confidence: top.score, status: 'clarify' };
  }
  return { matchedPatient: top.patient, candidates, confidence: top.score, status: 'matched' };
}
