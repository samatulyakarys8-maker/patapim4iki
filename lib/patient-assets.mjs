import { randomUUID } from 'node:crypto';
import { PDFParse } from 'pdf-parse';

function nowIso() {
  return new Date().toISOString();
}

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function clipText(input, max = 480) {
  const normalized = compactText(input);
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trim()}…`;
}

function normalizeFileName(name = '') {
  return String(name || '').trim() || `document-${Date.now()}`;
}

function detectCategory({ fileName, mimeType, requestedCategory }) {
  if (requestedCategory) return requestedCategory;
  const lowerName = normalizeFileName(fileName).toLowerCase();
  const lowerMime = String(mimeType || '').toLowerCase();
  if (lowerMime.includes('pdf') || lowerName.endsWith('.pdf')) return 'medical-document';
  if (/(template|шаблон|образец)/i.test(lowerName)) return 'doctor-template';
  if (/(history|история|выписка|справка|epicrisis|epicris)/i.test(lowerName)) return 'medical-history';
  return 'medical-document';
}

function extractDiagnosisCodes(text) {
  return [...new Set((String(text || '').match(/\b[A-ZА-Я]\d{2}(?:\.\d+)?\b/gi) || []).map((code) => code.toUpperCase()))];
}

function inferPresetTags(text) {
  const normalized = compactText(text).toLowerCase();
  const tags = new Set();
  if (/(речь|речев|звукопроизнош|артикуляц|инструкция)/i.test(normalized)) tags.add('speech-language');
  if (/(внимани|гиперактив|усидчив|поведен)/i.test(normalized)) tags.add('attention-behavior');
  if (/(аутизм|асд|социальн|контакт|сенсор)/i.test(normalized)) tags.add('autism-support');
  if (/(тревог|эмоци|страх|адаптац)/i.test(normalized)) tags.add('emotional-regulation');
  if (!tags.size) tags.add('general-psychology');
  return [...tags];
}

function extractSection(text, labels) {
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[:\\-]\\s*([\\s\\S]*?)(?=\\n[^\\n]{1,40}[:\\-]|\\n\\n|$)`, 'i');
  const match = String(text || '').match(pattern);
  return match?.[1] ? clipText(match[1], 900) : '';
}

function extractTemplateFields(text) {
  return Object.fromEntries(
    [
      ['complaints_text', ['жалобы', 'шағымдары']],
      ['anamnesis_text', ['анамнез', 'анамнез заболевания', 'анамнез жизни']],
      ['objective_status_text', ['объективный статус', 'объективно', 'status praesens']],
      ['appointments_text', ['назначения', 'тағайындаулар', 'план лечения']],
      ['recommendations', ['рекомендации', 'ұсынымдар']],
      ['tbmedicalfinal', ['заключение', 'қорытынды']]
    ]
      .map(([fieldKey, labels]) => [fieldKey, extractSection(text, labels)])
      .filter(([, value]) => compactText(value))
  );
}

function summarizeAssetText(text, category) {
  const excerpt = clipText(text, 260);
  if (excerpt) return excerpt;
  return category === 'doctor-template'
    ? 'Загружен шаблон врача. Его можно использовать как персональный образец медицинских формулировок.'
    : 'Загружен медицинский документ пациента. Он доступен для анализа и построения подсказок.';
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return compactText(result?.text || '');
  } finally {
    await parser.destroy().catch(() => null);
  }
}

async function extractAssetText({ mimeType, fileName, buffer }) {
  const lowerMime = String(mimeType || '').toLowerCase();
  const lowerName = normalizeFileName(fileName).toLowerCase();
  if (lowerMime.includes('pdf') || lowerName.endsWith('.pdf')) {
    return extractPdfText(buffer);
  }
  return compactText(buffer.toString('utf8'));
}

function ensurePatientAssetsStore(runtime) {
  runtime.patient_assets ||= {};
  return runtime.patient_assets;
}

export function getPatientAssets(runtime, patientId) {
  const store = ensurePatientAssetsStore(runtime);
  return [...(store[patientId] || [])].sort((left, right) => String(right.uploaded_at || '').localeCompare(String(left.uploaded_at || '')));
}

export async function registerPatientAsset(runtime, { patientId, fileName, mimeType, base64Data, category }) {
  const buffer = Buffer.from(String(base64Data || ''), 'base64');
  const extractedText = await extractAssetText({ mimeType, fileName, buffer });
  const resolvedCategory = detectCategory({ fileName, mimeType, requestedCategory: category });
  const templateFields = extractTemplateFields(extractedText);
  const record = {
    asset_id: `asset-${randomUUID()}`,
    patient_id: patientId,
    file_name: normalizeFileName(fileName),
    name: normalizeFileName(fileName),
    mime_type: mimeType || 'application/octet-stream',
    category: resolvedCategory,
    uploaded_at: nowIso(),
    summary: summarizeAssetText(extractedText, resolvedCategory),
    text_excerpt: summarizeAssetText(extractedText, resolvedCategory),
    extracted_text: clipText(extractedText, 4000),
    diagnosis_codes: extractDiagnosisCodes(extractedText),
    preset_tags: inferPresetTags(extractedText),
    template_fields: templateFields,
    source: 'uploaded'
  };

  const store = ensurePatientAssetsStore(runtime);
  store[patientId] ||= [];
  store[patientId].unshift(record);
  return record;
}

function mergePresetFields(baseFields, templateFields = {}) {
  return {
    ...baseFields,
    ...Object.fromEntries(Object.entries(templateFields).filter(([, value]) => compactText(value)))
  };
}

function buildGeneralPreset(patientName) {
  return {
    preset_id: 'preset-general-psychology',
    title: 'Базовый психологический прием',
    source: 'Психологический маршрут',
    summary: 'Базовая заготовка для первичного приема, если специальных диагнозных ориентиров пока нет.',
    specialty: 'psychology',
    fields: {
      complaints_text: `${patientName}: требуется уточнение жалоб, динамики поведения, внимания и адаптации в быту.`,
      anamnesis_text: 'Собран краткий анамнез текущего состояния, уточняются изменения относительно прошлых наблюдений и домашнего поведения.',
      objective_status_text: 'На приеме оцениваются контакт, внимание, понимание инструкции, эмоционально-волевая сфера и поведение в структуре задания.',
      appointments_text: 'Продолжить индивидуальную работу с медицинским психологом по текущим целям реабилитации.',
      recommendations: 'Наблюдение в динамике, домашняя поддержка и повторная оценка изменений на следующих визитах.',
      tbmedicalfinal: 'Психологический статус требует продолжения наблюдения и индивидуального маршрута сопровождения.'
    }
  };
}

function basePresetFromDiagnosis(code = '', patientName = '') {
  const upper = String(code || '').toUpperCase();
  if (upper.startsWith('F80')) {
    return {
      preset_id: 'preset-speech-language',
      title: 'Речевая коммуникация и понимание инструкции',
      source: `Диагноз ${upper}`,
      summary: 'Фокус на речевом развитии, понимании инструкции и удержании внимания.',
      specialty: 'psychology',
      fields: {
        complaints_text: `${patientName}: отмечаются трудности речевой коммуникации, снижение объема активной речи и затруднение выполнения вербальной инструкции.`,
        anamnesis_text: 'Нарушения речевого развития прослеживаются в динамике, требуется продолжение коррекционной поддержки с оценкой эффекта от предыдущих занятий.',
        objective_status_text: 'Контакт устанавливается с поддержкой, речевая активность ограничена, понимание простой инструкции частично сохранено, внимание истощаемо.',
        appointments_text: 'Продолжить индивидуальные занятия с медицинским психологом на понимание инструкции, речевую инициативу и удержание внимания.',
        recommendations: 'Домашняя поддержка речевой активности, короткие инструкции, ежедневное закрепление игровых заданий и контроль динамики.',
        tbmedicalfinal: 'Психологический статус соответствует нарушениям речевого развития, рекомендовано продолжение структурированной коррекционной программы.'
      }
    };
  }

  if (upper.startsWith('F84')) {
    return {
      preset_id: 'preset-autism-support',
      title: 'Социальный контакт и адаптационное сопровождение',
      source: `Диагноз ${upper}`,
      summary: 'Фокус на контакте, адаптации, сенсорной регуляции и предсказуемой структуре приема.',
      specialty: 'psychology',
      fields: {
        complaints_text: `${patientName}: сохраняются трудности социального взаимодействия, ограниченный контакт и потребность в структурированной среде.`,
        anamnesis_text: 'В анамнезе особенности коммуникации и адаптации, требующие регулярного сопровождения и мониторинга поведенческой динамики.',
        objective_status_text: 'Контакт избирательный, реакция на обращение нестойкая, требуется визуальная и поведенческая поддержка, отмечается сенсорная чувствительность.',
        appointments_text: 'Продолжить индивидуальные психологические занятия с акцентом на контакт, адаптацию, сенсорную регуляцию и поведенческий маршрут.',
        recommendations: 'Соблюдать структурированный режим, визуальные подсказки, единый стиль инструкций дома и в кабинете.',
        tbmedicalfinal: 'Состояние требует продолжения психологического сопровождения с акцентом на социальный контакт, адаптацию и регуляцию поведения.'
      }
    };
  }

  if (upper.startsWith('F90')) {
    return {
      preset_id: 'preset-attention-behavior',
      title: 'Внимание, саморегуляция и поведение',
      source: `Диагноз ${upper}`,
      summary: 'Фокус на концентрации внимания, завершении задания и поведенческом контроле.',
      specialty: 'psychology',
      fields: {
        complaints_text: `${patientName}: выражены трудности концентрации внимания, импульсивность и нестойкость поведения при выполнении задания.`,
        anamnesis_text: 'В анамнезе отмечаются трудности саморегуляции и сохранения работоспособности при последовательной деятельности.',
        objective_status_text: 'Внимание неустойчиво, требуется повтор инструкции и внешняя организация деятельности, при этом контакт возможен при структурировании задания.',
        appointments_text: 'Продолжить занятия по формированию саморегуляции, переключения внимания, завершения задания и поведенческого контроля.',
        recommendations: 'Дробные инструкции, короткие блоки работы, визуальный тайминг и положительное подкрепление завершенного действия.',
        tbmedicalfinal: 'Психологический статус соответствует трудностям внимания и саморегуляции, необходима дальнейшая коррекционная работа.'
      }
    };
  }

  return buildGeneralPreset(patientName);
}

export function buildPatientPresets({ patient, appointment, assets = [] }) {
  const diagnoses = [
    ...((appointment?.readonly_tabs?.diagnoses || []).map((item) => item.code)),
    ...assets.flatMap((asset) => asset.diagnosis_codes || [])
  ].filter(Boolean);

  const presets = new Map();
  const patientName = patient?.full_name || 'Пациент';
  const templateAsset = assets.find((asset) => Object.keys(asset.template_fields || {}).length > 0);

  for (const diagnosisCode of diagnoses.length ? diagnoses : ['']) {
    const preset = basePresetFromDiagnosis(diagnosisCode, patientName);
    const mergedPreset = {
      ...preset,
      fields: mergePresetFields(preset.fields, templateAsset?.template_fields),
      tags: [...new Set([
        ...(diagnosisCode ? [diagnosisCode] : []),
        ...(templateAsset ? ['шаблон врача'] : []),
        ...assets.flatMap((asset) => asset.preset_tags || [])
      ])]
    };
    presets.set(mergedPreset.preset_id, mergedPreset);
  }

  if (!presets.size) {
    const fallback = buildGeneralPreset(patientName);
    presets.set(fallback.preset_id, {
      ...fallback,
      tags: ['базовый пресет']
    });
  }

  return [...presets.values()];
}
