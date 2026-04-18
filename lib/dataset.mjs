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
const CONSULT_DIR_FALLBACK = path.join(DOWNLOADS_DIR, 'РљРѕРЅСЃСѓР»СЊС‚Р°С†РёСЏ Рё РґРёР°РіРЅРѕСЃС‚РёРєР°');
const HISTORY_ZIP_FALLBACK = path.join(DOWNLOADS_DIR, 'РСЃС‚РѕСЂРёСЏ Р±РѕР»РµР·РЅРµРёМ†.zip');

const CONSULT_DIR_LOCAL_FALLBACK = path.join(DOWNLOADS_DIR, 'РљРѕРЅСЃСѓР»СЊС‚Р°С†РёСЏ Рё РґРёР°РіРЅРѕСЃС‚РёРєР°');
const HISTORY_ZIP_CANDIDATES = [
  path.join(DOWNLOADS_DIR, 'РСЃС‚РѕСЂРёСЏ Р±РѕР»РµР·РЅРµРёМ†.zip'),
  path.join(DOWNLOADS_DIR, 'РСЃС‚РѕСЂРёСЏ Р±РѕР»РµР·РЅРµР№.zip'),
  path.resolve(process.cwd(), '..', 'РСЃС‚РѕСЂРёСЏ Р±РѕР»РµР·РЅРµРёМ†.zip'),
  path.resolve(process.cwd(), '..', 'РСЃС‚РѕСЂРёСЏ Р±РѕР»РµР·РЅРµР№.zip')
];

const OFFICIAL_ROOTS = {
  consult: '/mnt/data/unzipped/consult',
  patient: '/mnt/data/unzipped/patient',
  history: '/mnt/data/unzipped/history'
};

const KNOWN_INSPECTION_FIELDS = [
  { dom_id: 'dtpServiceExecuteDate', label: 'Р”Р°С‚Р° РІС‹РїРѕР»РЅРµРЅРёСЏ', value_type: 'date' },
  { dom_id: 'dtpServiceExecuteTime', label: 'Р”Р°С‚Р° Рё РІСЂРµРјСЏ РІС‹РїРѕР»РЅРµРЅРёСЏ', value_type: 'time' },
  { dom_id: 'ntbDurationMinute', label: 'Р”Р»РёС‚РµР»СЊРЅРѕСЃС‚СЊ РІ РјРёРЅСѓС‚Р°С…', value_type: 'number' },
  { dom_id: 'cmbMedicalEquipment', label: 'РњРµРґРёС†РёРЅСЃРєРѕРµ РѕР±РѕСЂСѓРґРѕРІР°РЅРёРµ', value_type: 'string' },
  { dom_id: 'cmbExecuteMedicalPost', label: 'РњРµРґРёС†РёРЅСЃРєРёР№ РїРѕСЃС‚', value_type: 'string' },
  { dom_id: 'cmbMedicalForm', label: 'Р¤РѕСЂРјР°', value_type: 'string' },
  { dom_id: 'cmbPerformerService', label: 'РЈСЃР»СѓРіР° РєР»Р°СЃСЃРёС„РёРєР°С‚РѕСЂР°', value_type: 'string' },
  { dom_id: 'cmbPerformerServiceMo', label: 'РЈСЃР»СѓРіР° РёР· РїСЂРµР№СЃРєСѓСЂР°РЅС‚Р°', value_type: 'string' },
  { dom_id: 'tbMedicalFinal', label: 'Р—Р°РєР»СЋС‡РµРЅРёРµ', value_type: 'text' }
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
    .replace(/&#171;/g, 'В«')
    .replace(/&#187;/g, 'В»')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeText(input) {
  return stripTags(String(input || '').replace(/\\n/g, ' ').replace(/\\"/g, '"'));
}

function looksLikeMojibake(input) {
  const value = String(input || '');
  return !value || /[пїЅв•Ёв•ҐГђГ‘]/.test(value);
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

const KNOWN_ARCHIVE_NAME_RULES = [
  { pattern: /Т.?Р°СЂР°.*РђРјСЂРµ.*Р’РџРЎ/u, value: 'Қарақойшин Амре ВПС' },
  { pattern: /РўРµРјС.*Рќ.*СЂР¶Р°РЅ/u, value: 'Темірбай Нұржан' },
  { pattern: /Т.?Т±С‚С‚С‹.*Рќ.*У™Р»Рё/u, value: 'Құттыбекұлы Нұрәли' },
  { pattern: /УЁРјРµРґРёСЃС‚.*У.?ТЈРєУ™СЂ/u, value: 'Өмедист Әңкәр' },
  { pattern: /РђР±Р°Р№.*РђРјРёРЅР°/u, value: 'Рахметолла Айкунім' }
];

function normalizeKnownArchiveName(input) {
  const normalized = normalizeWhitespace(String(input || ''));
  if (!normalized) return normalized;
  for (const rule of KNOWN_ARCHIVE_NAME_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.value;
    }
  }
  return normalized;
}

function looksLikeUtf8Mojibake(input) {
  const value = String(input || '');
  if (!value) return false;
  return /(?:Р.|С.|Т.|Ð.|Ñ.){2,}/u.test(value) || /[ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ]/u.test(value);
}

function textQualityScore(input) {
  const value = String(input || '');
  const readable = (value.match(/[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/g) || []).length;
  const suspicious = (value.match(/[ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ]/g) || []).length;
  const replacement = (value.match(/\?/g) || []).length;
  return readable - suspicious - replacement;
}

function repairMojibakeText(input) {
  const original = String(input || '').trim();
  if (!original) return original;

  const bytes = Uint8Array.from(
    Array.from(original, (char) => WINDOWS_1251_REVERSE_MAP.has(char) ? WINDOWS_1251_REVERSE_MAP.get(char) : 63)
  );
  const repaired = UTF8_DECODER.decode(bytes).trim().normalize('NFC');
  if (!repaired) return original;
  if (!looksLikeUtf8Mojibake(original) && textQualityScore(repaired) < textQualityScore(original)) {
    return original;
  }
  return textQualityScore(repaired) >= textQualityScore(original) ? repaired : original;
}

function findHistoryArchivePath() {
  const explicitCandidates = [WORKSPACE_HISTORY_DIR, ...HISTORY_ZIP_CANDIDATES];
  const directMatch = explicitCandidates.find((candidate) => fileExists(candidate));
  if (directMatch) return directMatch;

  const searchRoots = [DOWNLOADS_DIR, path.resolve(process.cwd(), '..')];
  for (const root of searchRoots) {
    for (const entry of listDirectoryEntriesSafe(root)) {
      if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
      if (/РёСЃС‚РѕСЂРё/i.test(entry.name) && /Р±РѕР»РµР·/i.test(entry.name)) {
        return path.join(root, entry.name);
      }
    }
  }

  return HISTORY_ZIP_FALLBACK;
}

function decodeZipName(name) {
  const decoded = Buffer.from(name, 'binary').toString('utf8');
  const candidate = looksLikeMojibake(decoded) ? repairMojibakeText(name) : decoded;
  return normalizeKnownArchiveName(candidate);
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
    return content.includes('РљРѕРЅСЃСѓР»СЊС‚Р°С†РёСЏ Рё РґРёР°РіРЅРѕСЃС‚РёРєР°') && content.includes('РџСЂРёРєСЂРµРїР»РµРЅРЅС‹Рµ РїР°С†РёРµРЅС‚С‹');
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
    workPlan: record.match(/Р–Т±РјС‹СЃ Р¶РѕСЃРїР°СЂС‹:[\s\S]*?<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    plannedSessions: record.match(/РљРѕР»РёС‡РµСЃС‚РІРѕ РїР»Р°РЅРёСЂСѓРµРјС‹С… Р·Р°РЅСЏС‚РёР№\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    completedSessions: record.match(/РєРѕР»РёС‡РµСЃС‚РІРѕ РїСЂРѕРІРµРґРµРЅРЅС‹С… Р·Р°РЅСЏС‚РёР№\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    dynamics: record.match(/Р”РёРЅР°РјРёРєР° СЂР°Р·РІРёС‚РёСЏ\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i),
    recommendations: record.match(/Р РµРєРѕРјРµРЅРґР°С†РёРё\):<\/b>\s*&nbsp;<br>([\s\S]*?)<\/td>/i)
  };

  return {
    sections,
    supplemental: {
      specialist_name: patientModel.ExecutePost?.PersonShortName || patientModel.ExecutePost?.PersonFullName || 'РЎРїРµС†РёР°Р»РёСЃС‚',
      completion_date: patientModel.ExecuteDateTimeStr || patientModel.AppointDateTimeStr,
      work_plan: sanitizeText(summaryMatches.workPlan?.[1] || 'Р Р°Р·РІРёС‚РёРµ РїРѕР·РЅР°РІР°С‚РµР»СЊРЅС‹С… РїСЂРѕС†РµСЃСЃРѕРІ Рё СЂРµС‡РµРІС‹С… РЅР°РІС‹РєРѕРІ'),
      planned_sessions: sanitizeText(summaryMatches.plannedSessions?.[1] || '10'),
      completed_sessions: sanitizeText(summaryMatches.completedSessions?.[1] || '10'),
      dynamics: sanitizeText(summaryMatches.dynamics?.[1] || 'РћС‚РјРµС‡Р°РµС‚СЃСЏ РїРѕР»РѕР¶РёС‚РµР»СЊРЅР°СЏ РґРёРЅР°РјРёРєР° РїРѕ СЂРµС‡РµРІС‹Рј Рё РёРіСЂРѕРІС‹Рј РЅР°РІС‹РєР°Рј'),
      recommendations: sanitizeText(summaryMatches.recommendations?.[1] || 'РџСЂРѕРґРѕР»Р¶РёС‚СЊ РёРЅРґРёРІРёРґСѓР°Р»СЊРЅС‹Рµ Р·Р°РЅСЏС‚РёСЏ Рё РґРѕРјР°С€РЅРёРµ СѓРїСЂР°Р¶РЅРµРЅРёСЏ')
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
        'See status updated to Р’С‹РїРѕР»РЅРµРЅРѕ in schedule'
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
      labels: ['РџРµСЂРІРёС‡РЅС‹Р№ РїСЂРёРµРј', 'РџРµСЂРІРёС‡РЅС‹Р№ РѕСЃРјРѕС‚СЂ', 'РќР°Р·РЅР°С‡РµРЅРёРµ'],
      screen_id: 'inspection',
      tab_key: 'inspection',
      document_type: 'form',
      preferred_selector: '[data-action="switch-tab"][data-tab="inspection"]',
      fallback_label_match: 'РЅР°Р·РЅР°С‡РµРЅРёРµ|РїРµСЂРІРёС‡РЅС‹Р№ РїСЂРёРµРј|РїРµСЂРІРёС‡РЅС‹Р№ РѕСЃРјРѕС‚СЂ'
    },
    {
      target_key: 'discharge_summary',
      labels: ['Р’С‹РїРёСЃРЅРѕР№ СЌРїРёРєСЂРёР·', 'Р­РїРёРєСЂРёР·', 'Р’С‹РїРёСЃРєР°'],
      screen_id: 'inspection',
      tab_key: 'dischargeSummary',
      document_type: 'readonly-document',
      preferred_selector: '[data-action="switch-tab"][data-tab="dischargeSummary"]',
      fallback_label_match: 'РІС‹РїРёСЃРЅРѕР№ СЌРїРёРєСЂРёР·|СЌРїРёРєСЂРёР·|РІС‹РїРёСЃРєР°'
    },
    {
      target_key: 'medical_records',
      labels: ['РњРµРґРёС†РёРЅСЃРєРёРµ Р·Р°РїРёСЃРё'],
      screen_id: 'inspection',
      tab_key: 'medicalRecords',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="medicalRecords"]',
      fallback_label_match: 'РјРµРґРёС†РёРЅСЃРєРёРµ Р·Р°РїРёСЃРё|РјРµРґ Р·Р°РїРёСЃРё'
    },
    {
      target_key: 'diagnoses',
      labels: ['Р”РёР°РіРЅРѕР·С‹'],
      screen_id: 'inspection',
      tab_key: 'diagnoses',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="diagnoses"]',
      fallback_label_match: 'РґРёР°РіРЅРѕР·С‹|РґРёР°РіРЅРѕР·'
    },
    {
      target_key: 'diaries',
      labels: ['Р”РЅРµРІРЅРёРєРѕРІС‹Рµ Р·Р°РїРёСЃРё'],
      screen_id: 'inspection',
      tab_key: 'diaries',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="diaries"]',
      fallback_label_match: 'РґРЅРµРІРЅРёРєРѕРІС‹Рµ Р·Р°РїРёСЃРё|РґРЅРµРІРЅРёРє'
    },
    {
      target_key: 'files',
      labels: ['Р¤Р°Р№Р»С‹'],
      screen_id: 'inspection',
      tab_key: 'files',
      document_type: 'readonly-tab',
      preferred_selector: '[data-action="switch-tab"][data-tab="files"]',
      fallback_label_match: 'С„Р°Р№Р»С‹|С„Р°Р№Р»'
    },
    {
      target_key: 'schedule',
      labels: ['Р Р°СЃРїРёСЃР°РЅРёРµ', 'Р“СЂР°С„РёРє', 'РљРѕРЅСЃСѓР»СЊС‚Р°С†РёСЏ Рё РґРёР°РіРЅРѕСЃС‚РёРєР°'],
      screen_id: 'schedule',
      tab_key: '',
      document_type: 'screen',
      preferred_selector: '',
      fallback_label_match: 'СЂР°СЃРїРёСЃР°РЅРёРµ|РіСЂР°С„РёРє|РЅР°Р·Р°Рґ'
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
    primary_specialty: '\u041c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a\u0430\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438\u044f',
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
      'complaints',
      'anamnesis',
      'objective-status',
      'appointments',
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
    { screen_id: 'schedule', field_key: 'schedule-root', preferred_selector: '#schedule', fallback_selectors: ['[data-screen="schedule"]'], control_type: 'container', read_strategy: 'exists', write_strategy: 'none' },
    { screen_id: 'schedule', field_key: 'calendar-date', preferred_selector: '#dpCalendarDate', fallback_selectors: ['input[data-field-key="calendar-date"]'], control_type: 'date', read_strategy: 'value', write_strategy: 'value' },
    { screen_id: 'schedule', field_key: 'grid-schedule', preferred_selector: '#cmbGridSchedules', fallback_selectors: ['select[data-field-key="grid-schedule"]'], control_type: 'select', read_strategy: 'value', write_strategy: 'value' },
    { screen_id: 'schedule', field_key: 'patient-search-grid', preferred_selector: '#grdSearchAttachPerson', fallback_selectors: ['[data-grid="patients"]'], control_type: 'grid', read_strategy: 'text', write_strategy: 'none' },
    { screen_id: 'schedule', field_key: 'attach-patient', preferred_selector: '#btnAttachPersonAccept', fallback_selectors: ['button[data-action="attach-patient"]'], control_type: 'button', read_strategy: 'enabled', write_strategy: 'click' },
    { screen_id: 'inspection', field_key: 'inspection-form', preferred_selector: '#frmInspectionResult', fallback_selectors: ['form[data-screen="inspection"]'], control_type: 'form', read_strategy: 'serialize', write_strategy: 'patch' },
    { screen_id: 'inspection', field_key: 'save-inspection', preferred_selector: '#btnSaveInspectionResult', fallback_selectors: ['button[data-action="save-inspection"]'], control_type: 'button', read_strategy: 'enabled', write_strategy: 'click' },
    { screen_id: 'inspection', field_key: 'save-close-inspection', preferred_selector: '#btnSaveAndCloseInspectionResult', fallback_selectors: ['button[data-action="save-close-inspection"]'], control_type: 'button', read_strategy: 'enabled', write_strategy: 'click' },
    { screen_id: 'inspection', field_key: 'complaints', preferred_selector: '#tbComplaints', fallback_selectors: ['[data-field-key="complaints"]'], control_type: 'textarea', read_strategy: 'value', write_strategy: 'value' },
    { screen_id: 'inspection', field_key: 'anamnesis', preferred_selector: '#tbAnamnesis', fallback_selectors: ['[data-field-key="anamnesis"]'], control_type: 'textarea', read_strategy: 'value', write_strategy: 'value' },
    { screen_id: 'inspection', field_key: 'objective-status', preferred_selector: '#tbObjectiveStatus', fallback_selectors: ['[data-field-key="objective-status"]'], control_type: 'textarea', read_strategy: 'value', write_strategy: 'value' },
    { screen_id: 'inspection', field_key: 'appointments', preferred_selector: '#tbAppointments', fallback_selectors: ['[data-field-key="appointments"]'], control_type: 'textarea', read_strategy: 'value', write_strategy: 'value' }
  ];

  for (const field of formFields) {
    locators.push({
      screen_id: 'inspection',
      field_key: field.field_key,
      preferred_selector: `#${field.dom_id}`,
      fallback_selectors: [`[name="${field.name}"]`, `[data-field-key="${field.field_key}"]`],
      control_type: field.widget_type,
      read_strategy: field.widget_type === 'checkbox-group' ? 'checked' : 'value',
      write_strategy: field.widget_type === 'checkbox-group' ? 'checkbox-group' : 'value'
    });
  }

  if (consultationIds.includes('btnPrevDay')) {
    locators.push({ screen_id: 'schedule', field_key: 'prev-day', preferred_selector: '#btnPrevDay', fallback_selectors: ['button[data-action="prev-day"]'], control_type: 'button', read_strategy: 'enabled', write_strategy: 'click' });
  }
  if (consultationIds.includes('btnNextDay')) {
    locators.push({ screen_id: 'schedule', field_key: 'next-day', preferred_selector: '#btnNextDay', fallback_selectors: ['button[data-action="next-day"]'], control_type: 'button', read_strategy: 'enabled', write_strategy: 'click' });
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
      visible_actions: patientButtons.filter((button) => /РЎРѕС…СЂР°РЅРёС‚СЊ|Save|Р—Р°РєСЂС‹С‚СЊ/i.test(button.label)),
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
      patient_name: patientModel.PatientMedicalRecords?.[0]?.MedicalRecord?.Record?.match(/PatientFullName" class="x-text-mark">([^<]+)/)?.[1] || 'РџР°С†РёРµРЅС‚',
      appointment_datetime: patientModel.AppointDateTimeStr,
      medical_final: patientModel.PatientMedicalRecords?.[0]?.MedicalRecord?.MedicalFinal || patientModel.MedicalFinal || '',
      provider_name: patientModel.ExecutePost?.PersonFullName || '',
      provider_short_name: patientModel.ExecutePost?.PersonShortName || '',
      service_name: patientModel.PatientMedicalRecords?.[0]?.MedicalRecordType?.Name || 'РљРѕРЅСЃСѓР»СЊС‚Р°С†РёСЏ'
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
  const safeName = normalizeKnownArchiveName(repairMojibakeText(name.replace(/\.pdf$/i, '').trim()));
  const fallbackNames = [
    'Қарақойшин Амре',
    'Темірбай Нұржан',
    'Құттыбекұлы Нұрәли',
    'Өмедист Әңкәр',
    'Рахметолла Айкунім'
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
  const sourceLabel = normalizeKnownArchiveName(repairMojibakeText(
    stripFileExtension(path.basename(historyItem.normalized_name || historyItem.original_path || ''))
  ));
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
    iin_or_local_id: `${190 + (index % 8)}${String(index * 7 + 3).padStart(2, '0')}${String(400000 + index * 137529).slice(0, 6)}`,
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

function addCalendarDays(startDate, count) {
  const days = [];
  const cursor = new Date(startDate);
  while (days.length < count) {
    days.push(new Date(cursor));
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
    baseline_conclusion: snapshot.medical_final || '\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438\u0447\u0435\u0441\u043a\u043e\u0435 \u0440\u0430\u0437\u0432\u0438\u0442\u0438\u0435 \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u043d\u0430\u0431\u043b\u044e\u0434\u0435\u043d\u0438\u044f \u0438 \u0440\u0435\u0433\u0443\u043b\u044f\u0440\u043d\u044b\u0445 \u0437\u0430\u043d\u044f\u0442\u0438\u0439.'
  };

  const rawHistoryPatients = artifacts.manifest
    .filter((item) => item.artifact_id.startsWith('history-'))
    .map((item, index) => buildArchivePatient(index, item, template));
  const provider = {
    provider_id: 'provider-1',
    full_name: repairMojibakeText(snapshot.provider_name) || '\u0416\u0430\u043d\u043d\u0430 \u0411\u0430\u0442\u044b\u0440\u0433\u0430\u043b\u0438\u0435\u0432\u0430',
    short_name: repairMojibakeText(snapshot.provider_short_name) || '\u0416. \u0411\u0430\u0442\u044b\u0440\u0433\u0430\u043b\u0438\u0435\u0432\u0430',
    specialty: '\u041c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a\u0430\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438\u044f',
    schedule_name: '\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433 \u2014 \u043a\u0430\u0431\u0438\u043d\u0435\u0442 1'
  };

  const providerBusySlots = {
    'provider-1': [
      { date: '2026-04-18', start: '09:00', end: '10:00' },
      { date: '2026-04-19', start: '15:00', end: '16:00' },
      { date: '2026-04-20', start: '09:00', end: '10:00' },
      { date: '2026-04-21', start: '09:00', end: '09:30' },
      { date: '2026-04-22', start: '10:00', end: '11:00' },
      { date: '2026-04-23', start: '09:00', end: '09:30' },
      { date: '2026-04-24', start: '09:00', end: '10:30' },
      { date: '2026-04-25', start: '14:00', end: '15:00' },
      { date: '2026-04-26', start: '11:00', end: '12:00' }
    ],
    'provider-2': [
      { date: '2026-04-18', start: '10:00', end: '10:30' },
      { date: '2026-04-19', start: '09:00', end: '10:00' },
      { date: '2026-04-20', start: '10:00', end: '11:00' },
      { date: '2026-04-21', start: '09:00', end: '10:00' },
      { date: '2026-04-22', start: '09:00', end: '09:30' },
      { date: '2026-04-23', start: '10:00', end: '11:30' },
      { date: '2026-04-24', start: '09:00', end: '09:30' },
      { date: '2026-04-25', start: '15:00', end: '16:00' },
      { date: '2026-04-26', start: '09:00', end: '10:00' }
    ],
    'provider-3': [
      { date: '2026-04-18', start: '16:00', end: '17:00' },
      { date: '2026-04-19', start: '10:00', end: '11:00' },
      { date: '2026-04-20', start: '09:00', end: '09:30' },
      { date: '2026-04-21', start: '10:30', end: '11:00' },
      { date: '2026-04-22', start: '09:00', end: '10:00' },
      { date: '2026-04-23', start: '09:30', end: '10:00' },
      { date: '2026-04-24', start: '10:00', end: '11:00' },
      { date: '2026-04-25', start: '09:00', end: '09:30' },
      { date: '2026-04-26', start: '10:00', end: '11:00' }
    ]
  };

  const providers = [
    {
      ...provider,
      scheduler_busy_slots: providerBusySlots['provider-1']
    },
    {
      provider_id: 'provider-2',
      full_name: '\u0410\u0439\u0436\u0430\u043d \u0421\u0435\u0440\u0438\u043a\u0431\u0430\u0435\u0432\u0430',
      short_name: '\u0410. \u0421\u0435\u0440\u0438\u043a\u0431\u0430\u0435\u0432\u0430',
      specialty: '\u041c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a\u0430\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438\u044f',
      schedule_name: '\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433 \u2014 \u043a\u0430\u0431\u0438\u043d\u0435\u0442 2',
      scheduler_busy_slots: providerBusySlots['provider-2']
    },
    {
      provider_id: 'provider-3',
      full_name: '\u0414\u0438\u043d\u0430\u0440\u0430 \u041a\u0430\u0441\u044b\u043c\u043e\u0432\u0430',
      short_name: '\u0414. \u041a\u0430\u0441\u044b\u043c\u043e\u0432\u0430',
      specialty: '\u041c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a\u0430\u044f \u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433\u0438\u044f',
      schedule_name: '\u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433 \u2014 \u043a\u0430\u0431\u0438\u043d\u0435\u0442 3',
      scheduler_busy_slots: providerBusySlots['provider-3']
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

  const calendarDays = addCalendarDays(new Date('2026-04-18T09:00:00'), 9);
  const boardHours = [
    '09:00', '09:30',
    '10:00', '10:30',
    '11:00', '11:30',
    '12:00', '12:30',
    '14:00', '14:30',
    '15:00', '15:30',
    '16:00', '16:30',
    '17:00', '17:30'
  ];
  const seededAppointments = new Map([
    ['2026-04-18-provider-1-09:00', { patient: linkedPrimaryPatient, status: 'completed' }],
    ['2026-04-18-provider-2-10:00', { patient: patients[1] || linkedPrimaryPatient, status: 'scheduled' }],
    ['2026-04-19-provider-1-09:00', { patient: linkedPrimaryPatient, status: 'scheduled' }],
    ['2026-04-20-provider-3-11:00', { patient: patients[2] || linkedPrimaryPatient, status: 'scheduled' }],
    ['2026-04-22-provider-2-15:00', { patient: patients[3] || linkedPrimaryPatient, status: 'scheduled' }]
  ]);
  const scheduleDays = calendarDays.map((day, dayIndex) => {
    const date = day.toISOString().slice(0, 10);
    const slots = providers.flatMap((providerItem, providerIndex) => boardHours.map((startTime, hourIndex) => {
      const seededAppointment = seededAppointments.get(`${date}-${providerItem.provider_id}-${startTime}`) || null;
      const patient = seededAppointment?.patient || null;
      const slotId = `slot-${date}-${providerItem.provider_id}-${hourIndex + 1}`;
      const appointmentId = `appointment-${dayIndex + 1}-${providerIndex + 1}-${hourIndex + 1}`;
      const status = seededAppointment?.status || 'available';
      const [slotHour, slotMinute] = startTime.split(':').map(Number);
      const endTotalMinutes = slotHour * 60 + slotMinute + 30;
      const endTime = `${String(Math.floor(endTotalMinutes / 60)).padStart(2, '0')}:${String(endTotalMinutes % 60).padStart(2, '0')}`;
      return {
        slot_id: slotId,
        date,
        start_time: startTime,
        end_time: endTime,
        provider_id: providerItem.provider_id,
        status,
        patient_id: patient?.patient_id || null,
        appointment_id: appointmentId,
        triage: 'minor',
        service_code: 'A02.005.000',
        service_name: '\u041a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f: \u041f\u0441\u0438\u0445\u043e\u043b\u043e\u0433'
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
    patient_assets: {},
    scheduleDays,
    appointments,
    auditEntries: [],
    transcriptSessions: {},
    speechSessions: {},
    procedureScheduleDrafts: {},
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
    complaints_text: '',
    anamnesis_text: '',
    objective_status_text: '',
    appointments_text: '',
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
  const extraFiles = arguments[1]?.extraFiles || [];
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
      ...extraFiles
    ]
  };
}

