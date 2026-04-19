import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTranscript(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildFallbackAnalysis(transcript) {
  const text = normalizeTranscript(transcript);
  const lower = text.toLowerCase();
  const redFlags = [];
  if (/судорог|потер|обморок|удуш|кров|резк|регресс|самоповреж|суицид/.test(lower)) {
    redFlags.push('Есть формулировки, похожие на красные флаги. Нужна очная оценка и решение врача.');
  }
  if (!redFlags.length) {
    redFlags.push('Явных красных флагов по тексту не выделено, но врач должен проверить их отдельно.');
  }

  return {
    provider: { type: 'fallback', note: 'OPENROUTER_API_KEY не подключен, использован безопасный шаблон.' },
    summary: text
      ? `Кратко: ${text.slice(0, 420)}${text.length > 420 ? '...' : ''}`
      : 'Транскрипт пустой, анализ не сформирован.',
    suggested_fields: [
      { field: 'Жалобы', value: text.slice(0, 240), confidence: 0.62 },
      { field: 'Рекомендации', value: 'Уточнить динамику симптомов, переносимость нагрузки и запрос семьи.', confidence: 0.58 }
    ],
    red_flags: redFlags,
    follow_up_questions: [
      'Когда началась проблема и как менялась по дням?',
      'Что ухудшает или улучшает состояние?',
      'Есть ли нарушения сна, аппетита, речи, моторики или поведения?',
      'Какая помощь уже пробовалась и какой был эффект?'
    ],
    care_plan_updates: [
      'После первичного осмотра рассмотреть маршрут на 7 или 9 дней.',
      'При признаках соматического ухудшения добавить контроль терапевта до нагрузочных занятий.',
      'Если есть сенсомоторное напряжение, рассмотреть мягкий массаж/реабилитационный блок.'
    ]
  };
}

export function createDialogueTranscriptStore({
  dbPath = path.join(process.cwd(), 'data/encounters/dialogues.sqlite')
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dialogue_transcripts (
      transcript_id TEXT PRIMARY KEY,
      appointment_id TEXT,
      patient_id TEXT,
      source TEXT NOT NULL DEFAULT 'extension',
      duration_sec INTEGER NOT NULL DEFAULT 0,
      transcript_text TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  function rowToObject(row) {
    if (!row) return null;
    return {
      transcript_id: row.transcript_id,
      appointment_id: row.appointment_id,
      patient_id: row.patient_id,
      source: row.source,
      duration_sec: row.duration_sec,
      transcript_text: row.transcript_text,
      analysis: parseJson(row.analysis_json, {}),
      created_at: row.created_at
    };
  }

  function saveTranscript({
    appointmentId = '',
    patientId = '',
    source = 'extension',
    durationSec = 0,
    transcript = '',
    analysis = null
  } = {}) {
    const transcriptText = normalizeTranscript(transcript);
    const payload = analysis || buildFallbackAnalysis(transcriptText);
    const transcriptId = `dlg_${randomUUID()}`;
    db.prepare(`
      INSERT INTO dialogue_transcripts (
        transcript_id,
        appointment_id,
        patient_id,
        source,
        duration_sec,
        transcript_text,
        analysis_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transcriptId,
      appointmentId || '',
      patientId || '',
      source || 'extension',
      Number(durationSec || 0),
      transcriptText,
      JSON.stringify(payload),
      nowIso()
    );
    return getTranscript(transcriptId);
  }

  function getTranscript(transcriptId) {
    return rowToObject(db.prepare('SELECT * FROM dialogue_transcripts WHERE transcript_id = ?').get(transcriptId));
  }

  function listTranscripts({ appointmentId = '', patientId = '' } = {}) {
    const rows = appointmentId
      ? db.prepare('SELECT * FROM dialogue_transcripts WHERE appointment_id = ? ORDER BY created_at DESC').all(appointmentId)
      : patientId
        ? db.prepare('SELECT * FROM dialogue_transcripts WHERE patient_id = ? ORDER BY created_at DESC').all(patientId)
        : db.prepare('SELECT * FROM dialogue_transcripts ORDER BY created_at DESC LIMIT 50').all();
    return rows.map(rowToObject);
  }

  return {
    saveTranscript,
    getTranscript,
    listTranscripts,
    close: () => db.close()
  };
}

export function buildDialogueAnalysis(transcript) {
  return buildFallbackAnalysis(transcript);
}
