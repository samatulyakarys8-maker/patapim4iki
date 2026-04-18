import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return `dr_${randomBytes(8).toString('hex')}`;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function createIntakeStore({
  dbPath = path.join(process.cwd(), 'data/intake/intakes.sqlite'),
  publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3030',
  whatsappBusinessNumber = process.env.WHATSAPP_BUSINESS_NUMBER || ''
} = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS doctors (
      doctor_id TEXT PRIMARY KEY,
      provider_id TEXT,
      display_name TEXT NOT NULL,
      qr_token TEXT NOT NULL UNIQUE,
      whatsapp_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intakes (
      intake_id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL DEFAULT '',
      wa_id TEXT,
      contact_name TEXT,
      status TEXT NOT NULL DEFAULT 'collecting',
      conversation_step TEXT NOT NULL DEFAULT 'fio',
      patient_fio TEXT,
      iin TEXT,
      phone TEXT,
      main_complaint TEXT,
      analysis_json TEXT,
      analysis_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intake_messages (
      message_id TEXT PRIMARY KEY,
      intake_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (intake_id) REFERENCES intakes(intake_id)
    );

    CREATE TABLE IF NOT EXISTS intake_files (
      file_id TEXT PRIMARY KEY,
      intake_id TEXT NOT NULL,
      whatsapp_media_id TEXT,
      local_path TEXT,
      caption TEXT,
      mime_type TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (intake_id) REFERENCES intakes(intake_id)
    );
  `);

  ensureColumn(db, 'doctors', 'provider_id', 'TEXT');
  ensureColumn(db, 'doctors', 'whatsapp_url', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'intakes', 'doctor_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'intakes', 'wa_id', 'TEXT');
  ensureColumn(db, 'intakes', 'contact_name', 'TEXT');
  ensureColumn(db, 'intake_files', 'whatsapp_media_id', 'TEXT');

  function whatsappLink(token) {
    const number = String(whatsappBusinessNumber || '').replace(/\D/g, '');
    const message = `Начнем консультацию. Код врача: ${token}`;
    if (number) {
      return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
    }
    return `${publicBaseUrl.replace(/\/$/, '')}/api/whatsapp/start?token=${encodeURIComponent(token)}`;
  }

  function doctorRowToObject(row) {
    if (!row) return null;
    return {
      doctor_id: row.doctor_id,
      provider_id: row.provider_id,
      display_name: row.display_name,
      qr_token: row.qr_token,
      whatsapp_url: row.whatsapp_url,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  function intakeRowToObject(row) {
    if (!row) return null;
    const files = db.prepare('SELECT * FROM intake_files WHERE intake_id = ? ORDER BY created_at ASC').all(row.intake_id);
    const messages = db.prepare('SELECT * FROM intake_messages WHERE intake_id = ? ORDER BY created_at ASC').all(row.intake_id);
    return {
      intake_id: row.intake_id,
      doctor_id: row.doctor_id,
      wa_id: row.wa_id,
      contact_name: row.contact_name,
      status: row.status,
      conversation_step: row.conversation_step,
      patient_fio: row.patient_fio,
      iin: row.iin,
      phone: row.phone,
      main_complaint: row.main_complaint,
      analysis: parseJson(row.analysis_json, null),
      analysis_text: row.analysis_text,
      created_at: row.created_at,
      updated_at: row.updated_at,
      messages,
      files
    };
  }

  function upsertDoctors(providers = []) {
    for (const provider of providers) {
      const doctorId = provider.provider_id || provider.doctor_id;
      if (!doctorId) continue;
      const existing = db.prepare('SELECT * FROM doctors WHERE doctor_id = ?').get(doctorId);
      const displayName = provider.short_name || provider.full_name || doctorId;
      if (existing) {
        db.prepare('UPDATE doctors SET provider_id = ?, display_name = ?, whatsapp_url = ?, updated_at = ? WHERE doctor_id = ?')
          .run(provider.provider_id || doctorId, displayName, whatsappLink(existing.qr_token), nowIso(), doctorId);
      } else {
        const token = randomToken();
        db.prepare(`
          INSERT INTO doctors (doctor_id, provider_id, display_name, qr_token, whatsapp_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(doctorId, provider.provider_id || doctorId, displayName, token, whatsappLink(token), nowIso(), nowIso());
      }
    }
  }

  function listDoctors() {
    return db.prepare('SELECT * FROM doctors ORDER BY display_name ASC').all().map(doctorRowToObject);
  }

  function getDoctor(doctorId) {
    return doctorRowToObject(db.prepare('SELECT * FROM doctors WHERE doctor_id = ?').get(doctorId));
  }

  function getDoctorByToken(token) {
    return doctorRowToObject(db.prepare('SELECT * FROM doctors WHERE qr_token = ?').get(String(token || '').trim()));
  }

  function ensureDoctorQr(doctorId) {
    const doctor = getDoctor(doctorId);
    if (!doctor) return null;
    const whatsappUrl = whatsappLink(doctor.qr_token);
    db.prepare('UPDATE doctors SET whatsapp_url = ?, updated_at = ? WHERE doctor_id = ?').run(whatsappUrl, nowIso(), doctorId);
    return { ...doctor, whatsapp_url: whatsappUrl };
  }

  function createOrActivateDoctorIntake({ waId = '', contactName = '', doctorId = '' }) {
    const normalizedWaId = String(waId || '');
    const existing = db.prepare(`
      SELECT * FROM intakes
      WHERE wa_id = ? AND doctor_id = ? AND status = 'collecting'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(normalizedWaId, doctorId);
    if (existing) {
      db.prepare('UPDATE intakes SET contact_name = ?, updated_at = ? WHERE intake_id = ?')
        .run(contactName || existing.contact_name || '', nowIso(), existing.intake_id);
      return getIntake(existing.intake_id);
    }

    const intakeId = randomUUID();
    db.prepare(`
      INSERT INTO intakes (intake_id, doctor_id, wa_id, contact_name, status, conversation_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'collecting', 'fio', ?, ?)
    `).run(intakeId, doctorId, normalizedWaId, contactName, nowIso(), nowIso());
    return getIntake(intakeId);
  }

  function getActiveIntakeByWhatsAppUser(waId, doctorId = '') {
    const normalizedWaId = String(waId || '');
    const row = doctorId
      ? db.prepare(`
          SELECT * FROM intakes
          WHERE wa_id = ? AND doctor_id = ? AND status = 'collecting'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `).get(normalizedWaId, doctorId)
      : db.prepare(`
          SELECT * FROM intakes
          WHERE wa_id = ? AND status = 'collecting'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `).get(normalizedWaId);
    return intakeRowToObject(row);
  }

  function getLatestIntakeByWhatsAppUser(waId) {
    const row = db.prepare(`
      SELECT * FROM intakes
      WHERE wa_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(String(waId || ''));
    return intakeRowToObject(row);
  }

  function getIntake(intakeId) {
    return intakeRowToObject(db.prepare('SELECT * FROM intakes WHERE intake_id = ?').get(intakeId));
  }

  function getIntakeForDoctor(intakeId, doctorId) {
    const row = db.prepare('SELECT * FROM intakes WHERE intake_id = ? AND doctor_id = ?').get(intakeId, doctorId);
    return intakeRowToObject(row);
  }

  function listIntakes({ doctorId, query = '', status = '' } = {}) {
    const rows = doctorId
      ? db.prepare('SELECT * FROM intakes WHERE doctor_id = ? ORDER BY updated_at DESC').all(doctorId)
      : db.prepare("SELECT * FROM intakes WHERE doctor_id != '' ORDER BY updated_at DESC").all();
    const normalizedQuery = normalizeSearch(query);
    return rows
      .filter((row) => !status || row.status === status)
      .filter((row) => {
        if (!normalizedQuery) return true;
        return [row.patient_fio, row.iin, row.phone, row.main_complaint, row.contact_name]
          .some((value) => normalizeSearch(value).includes(normalizedQuery));
      })
      .map(intakeRowToObject);
  }

  function appendMessage(intakeId, role, text) {
    db.prepare('INSERT INTO intake_messages (message_id, intake_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), intakeId, role, String(text || ''), nowIso());
    db.prepare('UPDATE intakes SET updated_at = ? WHERE intake_id = ?').run(nowIso(), intakeId);
  }

  function updateIntake(intakeId, fields) {
    const allowed = [
      'doctor_id',
      'wa_id',
      'contact_name',
      'status',
      'conversation_step',
      'patient_fio',
      'iin',
      'phone',
      'main_complaint',
      'analysis_json',
      'analysis_text'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return getIntake(intakeId);
    const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE intakes SET ${setClause}, updated_at = ? WHERE intake_id = ?`)
      .run(...entries.map(([, value]) => value), nowIso(), intakeId);
    return getIntake(intakeId);
  }

  function saveAttachment({
    intakeId,
    whatsappMediaId = '',
    localPath = '',
    caption = '',
    mimeType = ''
  }) {
    db.prepare(`
      INSERT INTO intake_files (file_id, intake_id, whatsapp_media_id, local_path, caption, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), intakeId, whatsappMediaId, localPath, caption, mimeType, nowIso());
    db.prepare('UPDATE intakes SET updated_at = ? WHERE intake_id = ?').run(nowIso(), intakeId);
    return getIntake(intakeId);
  }

  function close() {
    db.close();
  }

  return {
    db,
    upsertDoctors,
    listDoctors,
    getDoctor,
    getDoctorByToken,
    ensureDoctorQr,
    createOrActivateDoctorIntake,
    getActiveIntakeByWhatsAppUser,
    getLatestIntakeByWhatsAppUser,
    getIntake,
    getIntakeForDoctor,
    listIntakes,
    appendMessage,
    updateIntake,
    saveAttachment,
    close
  };
}
