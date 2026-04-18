import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

export const DEFAULT_TAB_ALIASES = {
  'medical-records': [
    'мед записи',
    'медицинские записи',
    'медицинская запись',
    'мед запись',
    'медкарта',
    'история',
    'история болезни',
    'записи пациента',
    'записи'
  ],
  assignments: ['назначения', 'назначение', 'процедуры', 'процедура'],
  diaries: ['дневники', 'дневник', 'дневниковые записи', 'дневниковая запись'],
  diagnoses: ['диагнозы', 'диагноз'],
  files: ['файлы', 'файл', 'документы', 'документ'],
  'audit-log': ['журнал событий', 'журнал'],
  'discharge-summary': ['эпикриз', 'выписной эпикриз', 'выписка', 'выписку', 'выписке']
};

export const DEFAULT_ACTION_ALIASES = {
  save: ['сохрани', 'сохранить', 'сохрани запись'],
  'save-and-close': ['сохрани и закрой', 'сохранить и закрыть', 'закрой прием', 'заверши прием'],
  'generate-schedule': ['сформируй расписание', 'сделай расписание', 'сформируй график', 'создай график занятий'],
  completed: ['отметь выполнено', 'отметь процедуру выполненной', 'процедура выполнена']
};

export const DEFAULT_ASR_CONFUSIONS = {
  темирбай: ['тимирбай', 'темірбай', 'темербай'],
  нуржан: ['нұржан', 'нур ж ан', 'нуржанн'],
  айкуним: ['айкүнім', 'айкуным', 'айкунум'],
  рахметолла: ['рахметула', 'рахметолла', 'рахметала'],
  куттыбекулы: ['құттыбекұлы', 'кутымбекулы', 'куттыбекулы'],
  нурали: ['нұрәли', 'нурали', 'нур али'],
  анкар: ['әңкәр', 'анкар', 'анкара']
};

export const DEFAULT_VOICE_LEXICON = {
  patientNames: [],
  patientAliases: DEFAULT_ASR_CONFUSIONS,
  doctorNames: [],
  tabAliases: DEFAULT_TAB_ALIASES,
  actionAliases: DEFAULT_ACTION_ALIASES,
  documentAliases: DEFAULT_TAB_ALIASES,
  procedureTerms: [
    'психологическая коррекция',
    'реабилитация',
    'лфк',
    'первичный осмотр',
    'первичный прием',
    'повторная оценка',
    'консультация'
  ],
  diagnosisTerms: ['нарушение речи', 'нарушение интеллекта', 'динамика развития'],
  fieldTerms: ['заключение', 'рекомендации', 'динамика', 'план работы'],
  asrConfusions: DEFAULT_ASR_CONFUSIONS
};

function uniq(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function looksLikeMojibake(value) {
  return /�|\?{2,}|╨|╩|†|≠|®|Ѓ|С́/.test(String(value || ''));
}

function addNameAliases(name) {
  const tokens = String(name || '').split(/\s+/).filter(Boolean);
  const aliases = [name, ...tokens];
  if (tokens.length >= 2) aliases.push(`${tokens[1]} ${tokens[0]}`);
  return aliases;
}

export function buildVoiceLexicon({ artifacts = {}, patients = [] } = {}) {
  const patientNames = uniq([
    ...patients.map((patient) => patient.full_name),
    artifacts.patient_model_snapshot?.patient_name,
    ...(artifacts.manifest || [])
      .filter((item) => item.artifact_id?.startsWith('history-'))
      .map((item) => String(item.normalized_name || '').replace(/\.pdf$/i, ''))
  ]).filter((name) => !looksLikeMojibake(name));

  const doctorNames = uniq([
    artifacts.patient_model_snapshot?.provider_name,
    artifacts.patient_model_snapshot?.provider_short_name,
    ...(patients || []).map((patient) => patient.provider_name)
  ]);

  const fieldTerms = uniq([
    ...DEFAULT_VOICE_LEXICON.fieldTerms,
    ...(artifacts.field_map || []).map((field) => field.label),
    ...(artifacts.medical_record_template?.sections || []).map((section) => section.title || section.label)
  ]);

  const patientAliases = { ...DEFAULT_ASR_CONFUSIONS };
  for (const name of patientNames) {
    patientAliases[name] = addNameAliases(name);
  }

  return {
    ...DEFAULT_VOICE_LEXICON,
    patientNames,
    patientAliases,
    doctorNames,
    fieldTerms,
    keyterms: buildDeepgramKeyterms({
      patientNames,
      doctorNames,
      fieldTerms,
      tabAliases: DEFAULT_TAB_ALIASES,
      actionAliases: DEFAULT_ACTION_ALIASES
    })
  };
}

export function buildDeepgramKeyterms(lexicon) {
  return uniq([
    'Damumed',
    'Дамумед',
    'Aqbobek',
    'Акбобек',
    ...(lexicon.patientNames || []),
    ...(lexicon.doctorNames || []),
    ...Object.values(lexicon.tabAliases || {}).flat(),
    ...Object.values(lexicon.actionAliases || {}).flat(),
    ...(lexicon.procedureTerms || DEFAULT_VOICE_LEXICON.procedureTerms),
    ...(lexicon.diagnosisTerms || DEFAULT_VOICE_LEXICON.diagnosisTerms),
    ...(lexicon.fieldTerms || [])
  ]).slice(0, 120);
}

export function loadVoiceLexiconFromDisk() {
  const filePath = path.join(ROOT_DIR, 'data/generated/voice_lexicon.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {
      ...DEFAULT_VOICE_LEXICON,
      keyterms: buildDeepgramKeyterms(DEFAULT_VOICE_LEXICON)
    };
  }
}
