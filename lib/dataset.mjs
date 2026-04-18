import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { buildVoiceLexicon } from './voice-lexicon.mjs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_SNAPSHOT_PATH = path.resolve(__dirname, '../data/generated/dataset_snapshot.json');
const WORKSPACE_HISTORY_DIR = path.resolve(process.cwd(), '.tmp_history_zip');

const DOWNLOADS_DIR = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Downloads')
  : '/Users/abdra/Downloads';
const CONSULT_DIR_FALLBACK = path.join(DOWNLOADS_DIR, 'Консультация и диагностика');
const HISTORY_ZIP_FALLBACK = path.join(DOWNLOADS_DIR, 'История болезней.zip');

const CONSULT_DIR_LOCAL_FALLBACK = path.join(DOWNLOADS_DIR, 'Консультация и диагностика');
const HISTORY_ZIP_CANDIDATES = [
  path.join(DOWNLOADS_DIR, 'История болезней.zip'),
  path.join(DOWNLOADS_DIR, 'История болезней.zip'),
  path.resolve(process.cwd(), '..', 'История болезней.zip'),
  path.resolve(process.cwd(), '..', 'История болезней.zip')
];

const OFFICIAL_ROOTS = {
  consult: '/mnt/data/unzipped/consult',
  patient: '/mnt/data/unzipped/patient',
  history: '/mnt/data/unzipped/history'
};

const KNOWN_INSPECTION_FIELDS = [
  { dom_id: 'dtpServiceExecuteDate', label: 'Дата выполнения', value_type: 'date' },
  { dom_id: 'dtpServiceExecuteTime', label: 'Дата и время выполнения', value_type: 'time' },
  { dom_id: 'ntbDurationMinute', label: 'Длительность в минутах', value_type: 'number' },
  { dom_id: 'cmbMedicalEquipment', label: 'Медицинское оборудование', value_type: 'string' },
  { dom_id: 'cmbExecuteMedicalPost', label: 'Медицинский пост', value_type: 'string' },
  { dom_id: 'cmbMedicalForm', label: 'Форма', value_type: 'string' },
  { dom_id: 'cmbPerformerService', label: 'Услуга классификатора', value_type: 'string' },
  { dom_id: 'cmbPerformerServiceMo', label: 'Услуга из прейскуранта', value_type: 'string' },
  { dom_id: 'tbMedicalFinal', label: 'Заключение', value_type: 'text' }
];

function slugify(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim()
    .replace(/[-\s]+/g, '-')
    .toLowerCase();
}

function stripTags(input) {
  return String(input || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#171;/g, '«')
    .replace(/&#187;/g, '»')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeText(input) {
  return stripTags(String(input || '').replace(/\\n/g, ' ').replace(/\\"/g, '"'));
}

function looksLikeMojibake(input) {
  const value = String(input || '');
  return !value || /[�╨╥ÐÑ]/.test(value);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function fileExists(target) {
  return Boolean(target && fs.existsSync(target));
}

function listFilesSafe(dir) {
  if (!fileExists(dir)) return [];
  return fs.readdirSync(dir).map((entry) => path.join(dir, entry));
}

function listDirectoryEntriesSafe(dir) {
  if (!fileExists(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

function normalizeWhitespace(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function stripFileExtension(name) {
  return String(name || '').replace(/\.[^.]+$/i, '').trim();
}

function normalizeEntityKey(input) {
  return normalizeWhitespace(stripFileExtension(input))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .toLowerCase();
}

const WINDOWS_1251_DECODER = new TextDecoder('windows-1251');
const UTF8_DECODER = new TextDecoder('utf-8');
const WINDOWS_1251_REVERSE_MAP = new Map(
  Array.from({ length: 256 }, (_, byte) => [WINDOWS_1251_DECODER.decode(Uint8Array.of(byte)), byte])
);
const KNOWN_DIAGNOSIS_SUFFIXES = [
  'Церебральный паралич',
  'Бронхит',
  'Аутизм',
  'Астма',
  'ДВГ',
  'ВПС'
];

function looksLikeUtf8Mojibake(input) {
  return /(?:Р.|С.|Т.|М.){2,}/u.test(String(input || ''));
}

function repairMojibakeText(input) {
  const original = String(input || '').trim();
  if (!original || !looksLikeUtf8Mojibake(original)) return original;

  const bytes = Uint8Array.from(
    Array.from(original, (char) => WINDOWS_1251_REVERSE_MAP.has(char) ? WINDOWS_1251_REVERSE_MAP.get(char) : 63)
  );
  const repaired = UTF8_DECODER.decode(bytes).trim().normalize('NFC');
  return repaired || original;
}

function findHistoryArchivePath() {
  const explicitCandidates = [WORKSPACE_HISTORY_DIR, ...HISTORY_ZIP_CANDIDATES];
  const directMatch = explicitCandidates.find((candidate) => fileExists(candidate));
  if (directMatch) return directMatch;

  const searchRoots = [DOWNLOADS_DIR, path.resolve(process.cwd(), '..')];
  for (const root of searchRoots) {
    for (const entry of listDirectoryEntriesSafe(root)) {
      if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
      if (/истори/i.test(entry.name) && /болез/i.test(entry.name)) {
        return path.join(root, entry.name);
      }
    }
  }

  return HISTORY_ZIP_FALLBACK;
}

function decodeZipName(name) {
  const decoded = Buffer.from(name, 'binary').toString('utf8');
  return looksLikeMojibake(decoded) ? name : decoded;
}

function safeExec(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    return '';
  }
}

function loadCachedArtifacts() {
  if (!fileExists(GENERATED_SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(GENERATED_SNAPSHOT_PATH, 'utf8'));
  } catch (error) {
    return null;
  }
}

function mergeHistoryArtifactsIntoCached(cachedArtifacts, paths) {
  if (!cachedArtifacts) return null;

  const liveHistoryArtifacts = parseHistoryArtifacts(paths.historyPath);
  if (!liveHistoryArtifacts.length) {
    return {
      ...cachedArtifacts,
      dataset_paths: {
        ...(cachedArtifacts.dataset_paths || {}),
        ...paths
      }
    };
  }

  return {
    ...cachedArtifacts,
    dataset_paths: {
      ...(cachedArtifacts.dataset_paths || {}),
      ...paths
    },
    manifest: [
      ...(cachedArtifacts.manifest || []).filter((item) => !String(item.artifact_id || '').startsWith('history-')),
      ...liveHistoryArtifacts
    ]
  };
}

export function resolveDatasetPaths() {
  const consultDir = fileExists(OFFICIAL_ROOTS.consult)
    ? OFFICIAL_ROOTS.consult
    : (fileExists(CONSULT_DIR_LOCAL_FALLBACK) ? CONSULT_DIR_LOCAL_FALLBACK : CONSULT_DIR_FALLBACK);
  const patientDir = fileExists(OFFICIAL_ROOTS.patient) ? OFFICIAL_ROOTS.patient : consultDir;
  const historyPath = fileExists(OFFICIAL_ROOTS.history)
    ? OFFICIAL_ROOTS.history
    : findHistoryArchivePath();

  const htmlFiles = listFilesSafe(consultDir).filter((entry) => entry.endsWith('.html'));
  const consultationHtml = htmlFiles.find((entry) => {
    const content = fs.readFileSync(entry, 'utf8');
    return content.includes('Консультация и диагностика') && content.includes('Прикрепленные пациенты');
  }) || htmlFiles[0];
  const patientHtml = htmlFiles.find((entry) => {
    const content = fs.readFileSync(entry, 'utf8');
    return content.includes('frmInspectionResult') || content.includes('tbMedicalFinal') || content.includes('btnSaveInspectionResult');
  }) || htmlFiles[htmlFiles.length - 1];

  return {
    officialRoots: OFFICIAL_ROOTS,
    consultDir,
    patientDir,
    historyPath,
    consultationHtml,
    patientHtml,
    usingFallbacks: {
      consult: consultDir !== OFFICIAL_ROOTS.consult,
      patient: patientDir !== OFFICIAL_ROOTS.patient,
      history: historyPath !== OFFICIAL_ROOTS.history
    }
  };
}

function parseTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return sanitizeText(match?.[1] || 'Untitled');
}

function parseIds(html) {
  const matches = [...html.matchAll(/id="([^"]+)"/g)];
  return [...new Set(matches.map((match) => match[1]))];
}

function parseButtons(html) {
  return [...html.matchAll(/<button[^>]*?(?:id="([^"]+)")?[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((match, index) => ({
      id: match[1] || `button-${index + 1}`,
      label: sanitizeText(match[2])
    }))
    .filter((button) => button.label);
}

function parseTabLinks(html) {
  return [...html.matchAll(/<li id="([^"]+)"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      id: match[1],
      label: sanitizeText(match[2])
    }))
    .filter((tab) => tab.label);
}

function parseLabelMap(html) {
  return new Map(
    [...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)]
      .map((match) => [match[1], sanitizeText(match[2])])
      .filter((entry) => entry[0] && entry[1])
  );
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractElementMarkup(html, fieldId) {
  const pattern = new RegExp(`<([a-z0-9:-]+)[^>]*\\bid="${escapeRegExp(fieldId)}"[^>]*>`, 'i');
  const match = html.match(pattern);
  if (!match) return null;
  return {
    tag: String(match[1] || '').toLowerCase(),
    markup: match[0]
  };
}

function parseAttributes(markup) {
  const attributes = {};
  for (const match of markup.matchAll(/([:@a-zA-Z0-9_-]+)(?:="([^"]*)")?/g)) {
    const key = match[1];
    if (!key || key === '<input' || key === '<textarea' || key === '<select' || key === '<span' || key === '<div') continue;
    attributes[key] = match[2] ?? true;
  }
  return attributes;
}

function parseLabeledFields(html) {
  const labelMap = parseLabelMap(html);
  const knownFieldMap = new Map(KNOWN_INSPECTION_FIELDS.map((field) => [field.dom_id, field]));
  const candidateIds = [...new Set([...labelMap.keys(), ...KNOWN_INSPECTION_FIELDS.map((field) => field.dom_id)])];

  const results = [];
  for (const fieldId of candidateIds) {
    const element = extractElementMarkup(html, fieldId);
    if (!element) continue;
    const attributes = parseAttributes(element.markup);
    const known = knownFieldMap.get(fieldId);
    const label = labelMap.get(fieldId) || known?.label || fieldId;
    const widgetType = inferFieldType(fieldId, attributes['data-role'], element.tag, attributes.type);

    results.push({
      screen_id: 'inspection',
      field_key: slugify(fieldId),
      label,
      dom_id: fieldId,
      name: attributes.name || fieldId,
      widget_type: widgetType,
      value_type: known?.value_type || inferValueType(fieldId),
      required: Object.prototype.hasOwnProperty.call(attributes, 'required'),
      source: 'patient_html'
    });
  }

  return dedupeBy(results, (item) => item.dom_id);
}

function inferFieldType(fieldId, dataRole = '', tag = '', inputType = '') {
  const normalizedRole = String(dataRole || '').toLowerCase();
  const normalizedTag = String(tag || '').toLowerCase();
  const normalizedInputType = String(inputType || '').toLowerCase();

  if (normalizedRole.includes('maskeddatepicker')) return 'date';
  if (normalizedRole.includes('maskedtimepicker')) return 'time';
  if (normalizedRole.includes('combobox')) return 'combobox';
  if (normalizedRole.includes('numerictextbox')) return 'numeric';
  if (normalizedTag === 'textarea') return 'textarea';
  if (normalizedTag === 'select') return 'select';
  if (normalizedInputType === 'checkbox') return 'checkbox';
  if (/dtp/i.test(fieldId)) return 'datetime';
  if (/cmb/i.test(fieldId)) return 'combobox';
  if (/ntb/i.test(fieldId)) return 'numeric';
  if (/tb/i.test(fieldId)) return 'textarea';
  return 'input';
}

function inferValueType(fieldId) {
  if (/date/i.test(fieldId)) return 'date';
  if (/time/i.test(fieldId)) return 'time';
  if (/duration/i.test(fieldId)) return 'number';
  if (/medicalfinal/i.test(fieldId)) return 'text';
  return 'string';
}

function dedupeBy(items, keyGetter) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyGetter(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePatientModel(patientHtml) {
  const html = fs.readFileSync(patientHtml, 'utf8');
  const match = html.match(/var model = (\{[\s\S]*?\});/);
  if (!match) {
    throw new Error('Unable to locate patient model in HTML dump');
  }
  const sandbox = {};
  vm.runInNewContext(`model = ${match[1]}`, sandbox);
  return sandbox.model;
}

function extractSectionBlocks(recordHtml) {
  const blocks = [];
  const matches = [...recordHtml.matchAll(/<b>([\s\S]*?)<\/b>([\s\S]*?)(?=<b>|$)/gi)];
  for (const match of matches) {
    const title = sanitizeText(match[1]).replace(/:$/, '');
    const body = match[2] || '';
    if (!title) continue;
    blocks.push({ title, body });
  }
  return blocks;
}

function parseMedicalRecordSections(patientModel) {
  const record = patientModel.PatientMedicalRecords?.[0]?.MedicalRecord?.Record || '';
  const sections = [];
  const sectionKeyCounter = new Map();
  for (const [index, block] of extractSectionBlocks(record).entries()) {
    const rawSectionKey = slugify(block.title) || `section-${index + 1}`;
    const nextSectionIndex = (sectionKeyCounter.get(rawSectionKey) || 0) + 1;
    sectionKeyCounter.set(rawSectionKey, nextSectionIndex);
    const sectionKey = nextSectionIndex === 1 ? rawSectionKey : `${rawSectionKey}-${nextSectionIndex}`;
    const optionKeyCounter = new Map();
    const options = [...block.body.matchAll(/<input[^>]*tag="([^"]+)"[^>]*(checked="true")?[^>]*>/gi)].map((match, optionIndex) => {
      const optionLabel = sanitizeText(match[1]);
      const rawOptionKey = slugify(optionLabel) || `${sectionKey}-option-${optionIndex + 1}`;
      const nextOptionIndex = (optionKeyCounter.get(rawOptionKey) || 0) + 1;
      optionKeyCounter.set(rawOptionKey, nextOptionIndex);
      return {
        option_key: nextOptionIndex === 1 ? rawOptionKey : `${rawOptionKey}-${nextOptionIndex}`,
        label: optionLabel,
        selected: Boolean(match[2])
      };
    });
    const freeText = sanitizeText(block.body.replace(/<input[^>]+>/gi, ' '));
    if (!options.length && !freeText) continue;
    sections.push({
      section_key: sectionKey,
      title: block.title,
      kind: options.length ? 'checkbox-group' : 'text',
      options,
      text: options.length ? '' : freeText
    });
  }

  const summaryMatches = {
    workPlan: record.match(/Жұмыс жоспары:[\s\S]*?<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    plannedSessions: record.match(/Количество планируемых занятий\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    completedSessions: record.match(/количество проведенных занятий\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    dynamics: record.match(/Динамика развития\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    recommendations: record.match(/Рекомендации\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i)
  };

  return {
    sections,
    supplemental: {
      specialist_name: patientModel.ExecutePost?.PersonShortName || patientModel.ExecutePost?.PersonFullName || 'Специалист',
      completion_date: patientModel.ExecuteDateTimeStr || patientModel.AppointDateTimeStr,
      work_plan: sanitizeText(summaryMatches.workPlan?.[1] || 'Развитие познавательных процессов и речевых навыков'),
      planned_sessions: sanitizeText(summaryMatches.plannedSessions?.[1] || '10'),
      completed_sessions: sanitizeText(summaryMatches.completedSessions?.[1] || '10'),
      dynamics: sanitizeText(summaryMatches.dynamics?.[1] || 'Отмечается положительная динамика по речевым и игровым навыкам'),
      recommendations: sanitizeText(summaryMatches.recommendations?.[1] || 'Продолжить индивидуальные занятия и домашние упражнения')
    }
  };
}

function parseHistoryArtifacts(historyPath) {
  if (!fileExists(historyPath)) {
    return [];
  }

  if (fs.statSync(historyPath).isDirectory()) {
    return listFilesSafe(historyPath).map((entry, index) => ({
      artifact_id: `history-${index + 1}`,
      source_archive: historyPath,
      artifact_type: path.extname(entry).slice(1) || 'file',
      original_path: entry,
      normalized_name: path.basename(entry),
      patient_scope: 'history',
      screen_scope: 'history',
      notes: 'Official mounted history artifact'
    }));
  }

  const output = process.platform === 'win32'
    ? safeExec(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(historyPath)}).Entries | ForEach-Object { $_.FullName }`)
    : safeExec(`unzip -Z1 ${JSON.stringify(historyPath)}`);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry, index) => ({
      artifact_id: `history-${index + 1}`,
      source_archive: historyPath,
      artifact_type: path.extname(entry).slice(1) || 'file',
      original_path: entry,
      normalized_name: decodeZipName(entry),
      patient_scope: 'history',
      screen_scope: 'history',
      notes: 'History item discovered from zip archive listing'
    }));
}

function buildWorkflowMap() {
  return [
    {
      workflow_id: 'schedule-to-completed',
      title: 'Schedule to completed inspection',
      steps: [
        'Open schedule dashboard',
        'Change day within 9-day range',
        'Choose schedule/provider',
        'Open attached patient selector',
        'Select patient and create appointment',
        'Open acceptance/execution window',
        'Navigate to inspection form',
        'Preview AI draft patches',
        'Apply granular field updates',
        'Save inspection and close',
        'See status updated to Выполнено in schedule'
      ]
    },
    {
      workflow_id: 'live-listening-safe-mode',
      title: 'Transcript to draft patch preview',
      steps: [
        'Ingest transcript chunk',
        'Optionally tag speaker role',
        'Extract candidate facts',
        'Generate draft field patches',
        'Show preview in extension side panel',
        'Apply approved patches through DOM engine',
        'Write audit entry'
      ]
    },
    {
      workflow_id: 'voice-navigation-dom-agent',
      title: 'Voice navigation through Damumed-like DOM',
      steps: [
        'Listen to doctor command',
        'Resolve navigation intent from source-of-truth targets',
        'Find visible tab/link/button in DOM context',
        'Build safe DOM operations without raw JavaScript',
        'Apply navigation through content script',
        'Show DOM proof and proactive next-step hint'
      ]
    }
  ];
}

function buildNavigationTargets() {
  return [
    {
      target_key: 'primary_visit',
      labels: ['Первичный прием', 'Первичный осмотр', 'Назначение'],
      screen_id: 'inspection',
      tab_key: 'inspection',
      document_type: 'form',
      preferred_selector: '[data-action="switch-tab"][data-tab="inspection"]',
      fallback_label_match: 'назначение|первичный прием|первичный осмотр'
    },
    {
      target_key: 'discharge_summary',
      labels: ['Выписной эпикриз', 'Эпикриз', 'Выписка'],
      screen_id: 'inspection',
      tab_key: 'dischargeSummary',
      document_type: 'readonly-document',
      preferred_selector: '[data-action="switch-tab"][data-tab="dischargeSummary"]',
      fallback_label_match: 'выписной эпикриз|эпикриз|выписка'
    },
    {
      target_key: 'medical_records',
      labels: ['Медицинские записи'],
      screen_id: 'inspection',
      tab_key: 'medicalRecords',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="medicalRecords"]',
      fallback_label_match: 'медицинские записи|мед записи'
    },
    {
      target_key: 'diagnoses',
      labels: ['Диагнозы'],
      screen_id: 'inspection',
      tab_key: 'diagnoses',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="diagnoses"]',
      fallback_label_match: 'диагнозы|диагноз'
    },
    {
      target_key: 'diaries',
      labels: ['Дневниковые записи'],
      screen_id: 'inspection',
      tab_key: 'diaries',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="diaries"]',
      fallback_label_match: 'дневниковые записи|дневник'
    },
    {
      target_key: 'files',
      labels: ['Файлы'],
      screen_id: 'inspection',
      tab_key: 'files',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="files"]',
      fallback_label_match: 'файлы|файл'
    },
    {
      target_key: 'schedule',
      labels: ['Расписание', 'График', 'Консультация и диагностика'],
      screen_id: 'schedule',
      tab_key: '',
      document_type: 'screen',
      preferred_selector: '',
      fallback_label_match: 'расписание|график|назад'
    }
  ];
}

function buildProcessSteps() {
  return [
    {
      step_key: 'schedule_open',
      required_screen: 'schedule',
      completion_condition: 'schedule screen is visible',
      next_suggestions: ['open_patient', 'change_schedule_day']
    },
    {
      step_key: 'inspection_open',
      required_screen: 'inspection',
      completion_condition: 'appointment form is visible',
      next_suggestions: ['start_listening', 'open_primary_visit']
    },
    {
      step_key: 'inspection_fill',
      required_screen: 'inspection',
      completion_condition: 'required medical fields completed',
      next_suggestions: ['apply_draft', 'save_and_close', 'generate_procedure_schedule']
    },
    {
      step_key: 'completed',
      required_screen: 'schedule',
      completion_condition: 'appointment status is completed',
      next_suggestions: ['generate_procedure_schedule', 'open_next_patient']
    }
  ];
}

function buildEntityMap(patientModel) {
  return {
    entities: [
      'Patient',
      'Provider',
      'ScheduleDay',
      'ScheduleSlot',
      'Appointment',
      'Assignment',
      'MedicalRecord',
      'MedicalRecordTemplate',
      'Diagnosis',
      'DiaryEntry',
      'FileAttachment',
      'Hint',
      'AuditEntry',
      'TranscriptChunk',
      'FactCandidate',
      'AgentIntent'
    ],
    primary_specialty: 'psychology-rehabilitation',
    example_provider: patientModel.ExecutePost?.PersonFullName || 'Provider from dataset'
  };
}

function buildPromptContracts(formFields, sections) {
  return {
    prompt_input_requirements: [
      'screen_id',
      'visible_fields',
      'selected_patient',
      'selected_appointment',
      'allowed_field_keys',
      'source_provenance'
    ],
    prompt_output_requirements: [
      'field-level JSON only',
      'no DOM code',
      'no raw HTML',
      'must include suggested vs confirmed vs applied status',
      'must include provenance and confidence per patch'
    ],
    supported_field_keys: [
      ...formFields.map((field) => field.field_key),
      ...sections.sections.map((section) => section.section_key),
      'work-plan',
      'planned-sessions',
      'completed-sessions',
      'dynamics',
      'recommendations'
    ]
  };
}

function buildLocatorRegistry(formFields, consultationIds) {
  const locators = [
    {
      screen_id: 'schedule',
      field_key: 'schedule-root',
      preferred_selector: '#schedule',
      fallback_selectors: ['[data-screen="schedule"]'],
      legacy_selectors: ['#schedule', '[data-screen="schedule"]'],
      semantic_role: 'container',
      candidate_names: ['расписание', 'график', 'schedule'],
      label_candidates: ['Расписание', 'График'],
      text_anchors: ['Прикрепить пациента', 'Назначено', 'Выполнено'],
      container_hints: ['schedule', 'slot-card'],
      verification_rules: ['schedule_screen_visible', 'slot_cards_visible'],
      control_type: 'container',
      read_strategy: 'exists',
      write_strategy: 'none'
    },
    {
      screen_id: 'schedule',
      field_key: 'calendar-date',
      preferred_selector: '#dpCalendarDate',
      fallback_selectors: ['input[data-field-key="calendar-date"]'],
      legacy_selectors: ['#dpCalendarDate', 'input[data-field-key="calendar-date"]'],
      semantic_role: 'date',
      candidate_names: ['дата', 'calendar date'],
      label_candidates: ['Дата'],
      text_anchors: ['Дата'],
      container_hints: ['controls'],
      verification_rules: ['value_present'],
      control_type: 'date',
      read_strategy: 'value',
      write_strategy: 'value'
    },
    {
      screen_id: 'schedule',
      field_key: 'grid-schedule',
      preferred_selector: '#cmbGridSchedules',
      fallback_selectors: ['select[data-field-key="grid-schedule"]'],
      legacy_selectors: ['#cmbGridSchedules', 'select[data-field-key="grid-schedule"]'],
      semantic_role: 'select',
      candidate_names: ['график', 'provider schedule'],
      label_candidates: ['График'],
      text_anchors: ['График'],
      container_hints: ['controls'],
      verification_rules: ['value_present'],
      control_type: 'select',
      read_strategy: 'value',
      write_strategy: 'value'
    },
    {
      screen_id: 'schedule',
      field_key: 'patient-search-grid',
      preferred_selector: '#grdSearchAttachPerson',
      fallback_selectors: ['[data-grid="patients"]'],
      legacy_selectors: ['#grdSearchAttachPerson', '[data-grid="patients"]'],
      semantic_role: 'grid',
      candidate_names: ['пациенты', 'patient list'],
      label_candidates: ['Пациенты психолога'],
      text_anchors: ['Поиск по ФИО или ИИН'],
      container_hints: ['wndSearchAttachPerson'],
      verification_rules: ['grid_visible'],
      control_type: 'grid',
      read_strategy: 'text',
      write_strategy: 'none'
    },
    {
      screen_id: 'schedule',
      field_key: 'attach-patient',
      preferred_selector: '#btnAttachPersonAccept',
      fallback_selectors: ['button[data-action="attach-patient"]'],
      legacy_selectors: ['#btnAttachPersonAccept', 'button[data-action="attach-patient"]'],
      semantic_role: 'button',
      candidate_names: ['записать на прием', 'прикрепить пациента', 'attach patient'],
      label_candidates: ['Записать на приём'],
      text_anchors: ['Записать на приём'],
      container_hints: ['wndSearchAttachPerson'],
      verification_rules: ['button_enabled'],
      control_type: 'button',
      read_strategy: 'enabled',
      write_strategy: 'click'
    },
    {
      screen_id: 'inspection',
      field_key: 'inspection-form',
      preferred_selector: '#frmInspectionResult',
      fallback_selectors: ['form[data-screen="inspection"]'],
      legacy_selectors: ['#frmInspectionResult', 'form[data-screen="inspection"]'],
      semantic_role: 'form',
      candidate_names: ['назначение', 'прием', 'inspection form'],
      label_candidates: ['Назначение'],
      text_anchors: ['Заключение', 'Дата выполнения', 'Рекомендации'],
      container_hints: ['inspection', 'inspection-grid'],
      verification_rules: ['patient_summary_visible', 'form_fields_visible'],
      control_type: 'form',
      read_strategy: 'serialize',
      write_strategy: 'patch'
    },
    {
      screen_id: 'inspection',
      field_key: 'save-inspection',
      preferred_selector: '#btnSaveInspectionResult',
      fallback_selectors: ['button[data-action="save-inspection"]'],
      legacy_selectors: ['#btnSaveInspectionResult', 'button[data-action="save-inspection"]'],
      semantic_role: 'button',
      candidate_names: ['сохранить', 'save'],
      label_candidates: ['Сохранить'],
      text_anchors: ['Сохранить'],
      container_hints: ['frmInspectionResult'],
      verification_rules: ['button_enabled'],
      control_type: 'button',
      read_strategy: 'enabled',
      write_strategy: 'click'
    },
    {
      screen_id: 'inspection',
      field_key: 'save-close-inspection',
      preferred_selector: '#btnSaveAndCloseInspectionResult',
      fallback_selectors: ['button[data-action="save-close-inspection"]'],
      legacy_selectors: ['#btnSaveAndCloseInspectionResult', 'button[data-action="save-close-inspection"]'],
      semantic_role: 'button',
      candidate_names: ['сохранить и закрыть', 'save and close'],
      label_candidates: ['Сохранить и закрыть'],
      text_anchors: ['Сохранить и закрыть'],
      container_hints: ['frmInspectionResult'],
      verification_rules: ['button_enabled'],
      control_type: 'button',
      read_strategy: 'enabled',
      write_strategy: 'click'
    }
  ];

  for (const field of formFields) {
    locators.push({
      screen_id: 'inspection',
      field_key: field.field_key,
      preferred_selector: `#${field.dom_id}`,
      fallback_selectors: [`[name="${field.name}"]`, `[data-field-key="${field.field_key}"]`],
      legacy_selectors: [`#${field.dom_id}`, `[name="${field.name}"]`, `[data-field-key="${field.field_key}"]`],
      semantic_role: field.widget_type === 'checkbox-group' ? 'group' : field.widget_type,
      candidate_names: [field.field_key, field.name, field.dom_id].filter(Boolean),
      label_candidates: [field.label].filter(Boolean),
      text_anchors: [field.label].filter(Boolean),
      container_hints: ['frmInspectionResult', 'inspection-grid'],
      verification_rules: [field.widget_type === 'checkbox-group' ? 'checkbox_group_visible' : 'control_visible'],
      control_type: field.widget_type,
      read_strategy: field.widget_type === 'checkbox-group' ? 'checked' : 'value',
      write_strategy: field.widget_type === 'checkbox-group' ? 'checkbox-group' : 'value'
    });
  }

  if (consultationIds.includes('btnPrevDay')) {
    locators.push({
      screen_id: 'schedule',
      field_key: 'prev-day',
      preferred_selector: '#btnPrevDay',
      fallback_selectors: ['button[data-action="prev-day"]'],
      legacy_selectors: ['#btnPrevDay', 'button[data-action="prev-day"]'],
      semantic_role: 'button',
      candidate_names: ['предыдущий день', 'prev day'],
      label_candidates: ['Предыдущий день'],
      text_anchors: ['Предыдущий день'],
      container_hints: ['controls'],
      verification_rules: ['button_enabled'],
      control_type: 'button',
      read_strategy: 'enabled',
      write_strategy: 'click'
    });
  }
  if (consultationIds.includes('btnNextDay')) {
    locators.push({
      screen_id: 'schedule',
      field_key: 'next-day',
      preferred_selector: '#btnNextDay',
      fallback_selectors: ['button[data-action="next-day"]'],
      legacy_selectors: ['#btnNextDay', 'button[data-action="next-day"]'],
      semantic_role: 'button',
      candidate_names: ['следующий день', 'next day'],
      label_candidates: ['Следующий день'],
      text_anchors: ['Следующий день'],
      container_hints: ['controls'],
      verification_rules: ['button_enabled'],
      control_type: 'button',
      read_strategy: 'enabled',
      write_strategy: 'click'
    });
  }

  return dedupeBy(locators, (locator) => `${locator.screen_id}:${locator.field_key}`);
}

export function buildArtifacts() {
  const paths = resolveDatasetPaths();
  if (!paths.consultationHtml || !paths.patientHtml) {
    const cachedArtifacts = mergeHistoryArtifactsIntoCached(loadCachedArtifacts(), paths);
    if (cachedArtifacts) {
      return cachedArtifacts;
    }
  }
  const consultationHtmlText = fs.readFileSync(paths.consultationHtml, 'utf8');
  const patientHtmlText = fs.readFileSync(paths.patientHtml, 'utf8');
  const patientModel = parsePatientModel(paths.patientHtml);
  const medicalRecordTemplate = parseMedicalRecordSections(patientModel);
  const formFields = parseLabeledFields(patientHtmlText);
  const consultationIds = parseIds(consultationHtmlText);
  const consultationButtons = parseButtons(consultationHtmlText);
  const patientButtons = parseButtons(patientHtmlText);
  const tabs = parseTabLinks(patientHtmlText);
  const historyArtifacts = parseHistoryArtifacts(paths.historyPath);

  const manifest = [
    {
      artifact_id: 'consultation-html',
      source_archive: paths.consultDir,
      artifact_type: 'html',
      original_path: paths.consultationHtml,
      normalized_name: path.basename(paths.consultationHtml),
      patient_scope: 'schedule',
      screen_scope: 'consultation',
      notes: 'Primary consultation and diagnostics screen'
    },
    {
      artifact_id: 'patient-inspection-html',
      source_archive: paths.patientDir,
      artifact_type: 'html',
      original_path: paths.patientHtml,
      normalized_name: path.basename(paths.patientHtml),
      patient_scope: 'patient',
      screen_scope: 'inspection',
      notes: 'Primary patient inspection / assignment screen'
    },
    ...historyArtifacts
  ];

  const screenInventory = [
    {
      screen_id: 'schedule',
      title: parseTitle(consultationHtmlText),
      source_path: paths.consultationHtml,
      purpose: 'Consultation workspace with schedule, patient search, queue, and appointment actions',
      visible_actions: consultationButtons,
      stable_ids: consultationIds.filter((id) => ['schedule', 'dpCalendarDate', 'cmbGridSchedules', 'grdSearchAttachPerson', 'btnAttachPersonAccept', 'wndEditGridScheduleRecord', 'wndEditGridScheduleRecordExecute', 'wndGridScheduleRecordCancel', 'wndGridScheduleRecordInfo', 'btnPrevDay', 'btnNextDay', 'btnRefresh', 'wndSearchAttachPerson'].includes(id))
    },
    {
      screen_id: 'inspection',
      title: parseTitle(patientHtmlText),
      source_path: paths.patientHtml,
      purpose: 'Patient assignment and inspection form with save actions and medical record editor',
      visible_actions: patientButtons.filter((button) => /Сохранить|Save|Закрыть/i.test(button.label)),
      tabs,
      stable_ids: parseIds(patientHtmlText).filter((id) => ['frmInspectionResult', 'btnSaveInspectionResult', 'btnSaveAndCloseInspectionResult', 'tbMedicalFinal', 'dtpServiceExecuteDate', 'dtpServiceExecuteTime', 'ntbDurationMinute', 'cmbMedicalEquipment', 'cmbExecuteMedicalPost', 'cmbMedicalForm', 'cmbPerformerService', 'cmbPerformerServiceMo'].includes(id))
    }
  ];

  const locatorRegistry = buildLocatorRegistry(formFields, consultationIds);
  const workflowMap = buildWorkflowMap();
  const navigationTargets = buildNavigationTargets();
  const processSteps = buildProcessSteps();
  const entityMap = buildEntityMap(patientModel);
  const promptContracts = buildPromptContracts(formFields, medicalRecordTemplate);

  return {
    generated_at: new Date().toISOString(),
    dataset_paths: paths,
    manifest,
    screen_inventory: screenInventory,
    field_map: formFields,
    workflow_map: workflowMap,
    navigation_targets: navigationTargets,
    process_steps: processSteps,
    locator_registry: locatorRegistry,
    entity_map: entityMap,
    medical_record_template: medicalRecordTemplate,
    prompt_contracts: promptContracts,
    patient_model_snapshot: {
      patient_name: patientModel.PatientMedicalRecords?.[0]?.MedicalRecord?.Record?.match(/PatientFullName" class="x-text-mark">([^<]+)/)?.[1] || 'Пациент',
      appointment_datetime: patientModel.AppointDateTimeStr,
      medical_final: patientModel.PatientMedicalRecords?.[0]?.MedicalRecord?.MedicalFinal || patientModel.MedicalFinal || '',
      provider_name: patientModel.ExecutePost?.PersonFullName || '',
      provider_short_name: patientModel.ExecutePost?.PersonShortName || '',
      service_name: patientModel.PatientMedicalRecords?.[0]?.MedicalRecordType?.Name || 'Консультация'
    }
  };
}

export async function writeArtifacts(outputDir) {
  const artifacts = buildArtifacts();
  await fsp.mkdir(outputDir, { recursive: true });
  const files = {
    'source_of_truth_manifest.json': artifacts.manifest,
    'screen_inventory.json': artifacts.screen_inventory,
    'field_map.json': artifacts.field_map,
    'workflow_map.json': artifacts.workflow_map,
    'navigation_targets.json': artifacts.navigation_targets,
    'process_steps.json': artifacts.process_steps,
    'locator_registry.json': artifacts.locator_registry,
    'entity_map.json': artifacts.entity_map,
    'medical_record_template.json': artifacts.medical_record_template,
    'prompt_contracts.json': artifacts.prompt_contracts,
    'dataset_snapshot.json': artifacts,
    'voice_lexicon.json': buildVoiceLexicon({ artifacts })
  };

  await Promise.all(
    Object.entries(files).map(([fileName, content]) =>
      fsp.writeFile(path.join(outputDir, fileName), JSON.stringify(content, null, 2), 'utf8')
    )
  );

  return artifacts;
}

function buildPatientFromHistoryName(index, name, template) {
  const safeName = name.replace(/\.pdf$/i, '').trim();
  const fallbackNames = [
    'Қарақойшин Амре ВПС',
    'Темірбай Нұржан',
    'Құттыбекұлы Нұрәли',
    'Өмедист Әңкәр',
    'Абай Амина'
  ];
  const fullName = safeName && !looksLikeMojibake(safeName) ? safeName : fallbackNames[index % fallbackNames.length];
  const templateClone = JSON.parse(JSON.stringify(template));
  const selectedOffset = index % 3;
  for (const section of templateClone.sections) {
    if (section.kind !== 'checkbox-group') continue;
    section.options = section.options.map((option, optionIndex) => ({
      ...option,
      selected: option.selected ? optionIndex % (selectedOffset + 2) === 0 : optionIndex === selectedOffset
    }));
  }
  return {
    patient_id: `patient-${index + 2}`,
    full_name: fullName,
    birth_date: `201${8 + (index % 5)}-0${(index % 8) + 1}-1${index % 9}`,
    iin_or_local_id: `18081${index}60414${index}`,
    sex: index % 2 === 0 ? 'female' : 'male',
    specialty_track: 'psychology-rehabilitation',
    history_refs: [`history-${index + 1}`],
    medical_template: templateClone,
    summary: template.supplemental,
    baseline_conclusion: index % 2 === 0
      ? 'Наблюдается положительная динамика в игровых и речевых навыках.'
      : 'Требуется продолжение коррекционной работы по вниманию и пониманию инструкции.'
  };
}

function buildArchivePatient(index, historyItem, template) {
  const sourceLabel = repairMojibakeText(
    stripFileExtension(path.basename(historyItem.normalized_name || historyItem.original_path || ''))
  );
  const chunks = sourceLabel.split(/\s{2,}/).map((item) => normalizeWhitespace(item)).filter(Boolean);
  const rawLabel = normalizeWhitespace(sourceLabel);
  let fullName = chunks[0] || rawLabel || `Пациент из архива ${index + 1}`;
  let diagnosisLabel = chunks.slice(1).join(', ');
  if (!diagnosisLabel) {
    const matchedSuffix = KNOWN_DIAGNOSIS_SUFFIXES.find((suffix) => fullName.endsWith(` ${suffix}`));
    if (matchedSuffix) {
      fullName = fullName.slice(0, -(` ${matchedSuffix}`).length).trim();
      diagnosisLabel = matchedSuffix;
    }
  }
  const basePatient = buildPatientFromHistoryName(index, fullName, template);

  return {
    ...basePatient,
    patient_id: `patient-history-${index + 1}`,
    birth_date: '',
    iin_or_local_id: `ARCH-${String(index + 1).padStart(3, '0')}`,
    sex: '',
    summary: {
      ...basePatient.summary,
      source_label: rawLabel,
      diagnosis_label: diagnosisLabel
    },
    baseline_conclusion: diagnosisLabel
      ? `История импортирована из архива: ${diagnosisLabel}.`
      : 'История импортирована из архива пациента.',
    history_refs: [historyItem.artifact_id],
    source_origin: 'history-archive'
  };
}

function addBusinessDays(startDate, count) {
  const days = [];
  const cursor = new Date(startDate);
  while (days.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      days.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function seedRuntimeState(artifacts) {
  const template = artifacts.medical_record_template;
  const snapshot = artifacts.patient_model_snapshot;
  const primaryPatient = {
    patient_id: 'patient-1',
    full_name: snapshot.patient_name,
    birth_date: '2018-08-13',
    iin_or_local_id: '180813604146',
    sex: 'female',
    specialty_track: 'psychology-rehabilitation',
    history_refs: ['history-1'],
    medical_template: JSON.parse(JSON.stringify(template)),
    summary: template.supplemental,
    baseline_conclusion: snapshot.medical_final || 'Психологиялық даму деңгейі: Нарушение интеллекта. Нарушение речи.'
  };

  const rawHistoryPatients = artifacts.manifest
    .filter((item) => item.artifact_id.startsWith('history-'))
    .map((item, index) => buildArchivePatient(index, item, template));
  const provider = {
    provider_id: 'provider-1',
    full_name: snapshot.provider_name || 'БАТЫРГАЛИЕВА ЖАННА АЛЕКСАНДРОВНА',
    short_name: snapshot.provider_short_name || 'БАТЫРГАЛИЕВА Ж. А.',
    specialty: 'Медицинская психология',
    schedule_name: 'Психолог - основной график'
  };

  const providers = [
    {
      ...provider,
      scheduler_busy_slots: [
        { date: '2026-04-17', start: '09:00', end: '10:00' },
        { date: '2026-04-20', start: '09:00', end: '10:00' },
        { date: '2026-04-21', start: '09:00', end: '09:30' },
        { date: '2026-04-22', start: '10:00', end: '11:00' },
        { date: '2026-04-23', start: '09:00', end: '09:30' },
        { date: '2026-04-24', start: '09:00', end: '10:30' },
        { date: '2026-04-27', start: '11:00', end: '12:00' },
        { date: '2026-04-28', start: '09:30', end: '10:30' },
        { date: '2026-04-29', start: '09:00', end: '09:30' }
      ]
    },
    {
      provider_id: 'provider-2',
      full_name: 'СЕРИКБАЕВА АЙЖАН МАРАТОВНА',
      short_name: 'СЕРИКБАЕВА А. М.',
      specialty: 'Медицинская психология',
      schedule_name: 'Психолог - второй график',
      scheduler_busy_slots: [
        { date: '2026-04-17', start: '09:00', end: '09:30' },
        { date: '2026-04-20', start: '10:00', end: '11:00' },
        { date: '2026-04-21', start: '09:00', end: '10:00' },
        { date: '2026-04-22', start: '09:00', end: '09:30' },
        { date: '2026-04-23', start: '10:00', end: '11:30' },
        { date: '2026-04-24', start: '09:00', end: '09:30' },
        { date: '2026-04-27', start: '09:00', end: '10:00' },
        { date: '2026-04-28', start: '10:30', end: '11:00' },
        { date: '2026-04-29', start: '09:00', end: '10:00' }
      ]
    },
    {
      provider_id: 'provider-3',
      full_name: 'КАСЫМОВА ДИНАРА АСКАРОВНА',
      short_name: 'КАСЫМОВА Д. А.',
      specialty: 'Медицинская психология',
      schedule_name: 'Психолог - смена 2',
      scheduler_busy_slots: [
        { date: '2026-04-17', start: '10:00', end: '11:00' },
        { date: '2026-04-20', start: '09:00', end: '09:30' },
        { date: '2026-04-21', start: '10:30', end: '11:00' },
        { date: '2026-04-22', start: '09:00', end: '10:00' },
        { date: '2026-04-23', start: '09:30', end: '10:00' },
        { date: '2026-04-24', start: '10:00', end: '11:00' },
        { date: '2026-04-27', start: '09:00', end: '09:30' },
        { date: '2026-04-28', start: '09:00', end: '10:00' },
        { date: '2026-04-29', start: '10:00', end: '11:00' }
      ]
    }
  ];
  const primaryProvider = providers[0];
  const providerKeys = new Set(providers.map((item) => normalizeEntityKey(item.full_name)).filter(Boolean));
  const linkedPrimaryPatient = {
    ...primaryPatient,
    assigned_provider_id: primaryProvider.provider_id
  };
  const seenPatientKeys = new Set([normalizeEntityKey(linkedPrimaryPatient.full_name)]);
  const historyPatients = rawHistoryPatients
    .filter((patient) => {
      const patientKey = normalizeEntityKey(patient.full_name);
      if (!patientKey || providerKeys.has(patientKey) || seenPatientKeys.has(patientKey)) {
        return false;
      }
      seenPatientKeys.add(patientKey);
      return true;
    })
    .map((patient, index) => ({
      ...patient,
      assigned_provider_id: providers[index % providers.length]?.provider_id || primaryProvider.provider_id
    }));
  const patients = [linkedPrimaryPatient, ...historyPatients];
  for (const providerItem of providers) {
    providerItem.attached_patient_ids = patients
      .filter((patient) => patient.assigned_provider_id === providerItem.provider_id)
      .map((patient) => patient.patient_id);
  }

  const businessDays = addBusinessDays(new Date('2026-04-17T09:00:00'), 9);
  const boardHours = [9, 10, 11, 12];
  const seededAppointments = new Map([
    ['0-provider-1-09:00', { patient: linkedPrimaryPatient, status: 'completed' }],
    ['1-provider-1-09:00', { patient: linkedPrimaryPatient, status: 'scheduled' }]
  ]);
  const scheduleDays = businessDays.map((day, dayIndex) => {
    const date = day.toISOString().slice(0, 10);
    const slots = providers.flatMap((providerItem, providerIndex) => boardHours.map((hour, hourIndex) => {
      const startTime = `${String(hour).padStart(2, '0')}:00`;
      const seededAppointment = seededAppointments.get(`${dayIndex}-${providerItem.provider_id}-${startTime}`) || null;
      const patient = seededAppointment?.patient || null;
      const slotId = `slot-${date}-${providerItem.provider_id}-${hourIndex + 1}`;
      const appointmentId = `appointment-${dayIndex + 1}-${providerIndex + 1}-${hourIndex + 1}`;
      const status = seededAppointment?.status || 'available';
      return {
        slot_id: slotId,
        date,
        start_time: startTime,
        end_time: `${String(hour).padStart(2, '0')}:30`,
        provider_id: providerItem.provider_id,
        status,
        patient_id: patient?.patient_id || null,
        appointment_id: appointmentId,
        triage: 'minor',
        service_code: 'A02.005.000',
        service_name: 'Консультация: Психолог'
      };
    }));
    return { date, slots };
  });

  const appointments = {};
  for (const day of scheduleDays) {
    for (const slot of day.slots) {
      const patient = patients.find((item) => item.patient_id === slot.patient_id) || linkedPrimaryPatient;
      const appointmentProvider = providers.find((item) => item.provider_id === slot.provider_id) || primaryProvider;
      appointments[slot.appointment_id] = {
        appointment_id: slot.appointment_id,
        patient_id: slot.patient_id,
        provider_id: slot.provider_id,
        schedule_slot_id: slot.slot_id,
        status: slot.status,
        service_code: slot.service_code,
        service_name: slot.service_name,
        created_at: `${slot.date}T${slot.start_time}:00`,
        executed_at: slot.status === 'completed' ? `${slot.date}T${slot.start_time}:00` : null,
        inspection_draft: buildInspectionDraft(patient, slot, appointmentProvider, template),
        draft_state: buildDraftState(slot.appointment_id),
        readonly_tabs: buildReadonlyTabs(patient)
      };
    }
  }

  const runtime = {
    providers,
    patients,
    scheduleDays,
    appointments,
    auditEntries: [],
    transcriptSessions: {},
    speechSessions: {},
    procedureScheduleDrafts: {},
    saveConfirmations: {},
    hints: [],
    currentDate: scheduleDays[0].date,
    source_of_truth_ready: true
  };
  runtime.voiceLexicon = buildVoiceLexicon({ artifacts, patients });
  return runtime;
}

function cloneSectionsEmpty(sections) {
  return JSON.parse(JSON.stringify(sections)).map((section) => ({
    ...section,
    text: section.kind === 'text' ? '' : '',
    options: (section.options || []).map((option) => ({ ...option, selected: false }))
  }));
}

function buildInspectionDraft(patient, slot, provider, template) {
  return {
    appointment_id: slot.appointment_id,
    execute_date: slot.date,
    execute_time: slot.start_time,
    duration_min: 30,
    medical_post_id: 'med-post-psychology',
    service_classifier_id: slot.service_code,
    service_price_item_id: `${slot.service_code}-price`,
    medical_form_id: 'medical-form-psychology',
    conclusion_text: '',
    medical_record_sections: cloneSectionsEmpty(patient.medical_template.sections),
    supplemental: {
      specialist_name: provider.short_name,
      completion_date: slot.date,
      work_plan: '',
      planned_sessions: '',
      completed_sessions: '',
      dynamics: '',
      recommendations: ''
    }
  };
}

function buildDraftState(appointmentId) {
  return {
    appointment_id: appointmentId,
    draft_status: 'idle',
    transcript_chunks: [],
    fact_candidates: [],
    draft_patches: [],
    applied_patch_ids: [],
    updated_at: null,
    last_preview: null
  };
}

export function buildReadonlyTabs(patient) {
  return {
    assignments: [
      { id: 'assignment-1', title: 'Психологическая консультация', status: 'Выполнено' },
      { id: 'assignment-2', title: 'Наблюдение динамики развития', status: 'Активно' }
    ],
    medicalRecords: [
      { id: 'record-1', title: 'Лист психолога', updated_at: '2026-04-01 10:30' },
      { id: 'record-2', title: 'Первичный осмотр', updated_at: '2026-04-01 09:40' }
    ],
    dischargeSummary: [
      {
        id: 'summary-1',
        title: 'Выписной эпикриз',
        updated_at: '2026-04-10 15:20',
        text: `${patient.full_name}: курс психологической реабилитации завершен, рекомендовано продолжить занятия по индивидуальному плану.`
      }
    ],
    healthIndicators: [
      { label: 'Коммуникативный контакт', value: 'Нуждается в поддержке' },
      { label: 'Когнитивная активность', value: 'Средняя' }
    ],
    diaries: [
      { id: 'diary-1', note: `${patient.full_name}: динамика отмечена по игровым навыкам.` }
    ],
    diagnoses: [
      { id: 'diagnosis-1', code: 'F80.9', label: 'Нарушение речи, неуточненное' }
    ],
    files: [
      { id: 'file-1', name: `${patient.full_name} - psychology-note.pdf`, source: 'history' }
    ]
  };
}
