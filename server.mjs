import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { buildArtifacts, buildReadonlyTabs, seedRuntimeState, writeArtifacts } from './lib/dataset.mjs';
import {
  applyInspectionSave,
  acceptProcedureSchedule,
  buildApplyPreview,
  buildProcedureSchedulePreview,
  buildHints,
  createAuditEntry,
  executeIntentPreview,
  getAppointmentById,
  getDeepgramRealtimeConfig,
  getDraftState,
  getPatientById,
  injectDraftPatches,
  inferScreenId,
  ingestTranscript,
  markPreviewApplied,
  observeAgent,
  previewCommand,
  startSpeechSession,
  stopSpeechSession,
  searchPatients
} from './lib/agent.mjs';
import { AdvisorContextError, analyzeAdvisor } from './lib/advisor.mjs';
import { getOpenAiSttConfig, transcribeOpenAiAudio } from './lib/openai-stt.mjs';
import { buildPatientPresets, getPatientAssets, registerPatientAsset } from './lib/patient-assets.mjs';
import { createIntakeStore } from './lib/intake-db.mjs';
import { handleWhatsAppWebhook, sendWhatsAppMessage, sendWhatsAppTemplate, verifyWhatsAppWebhook } from './lib/whatsapp-cloud.mjs';
import { buildPsychologistsFromRuntime, generatePsychologistSchedule } from './lib/scheduler.mjs';
import {
  addCarePlanItem,
  carePlanSummaryText,
  confirmCarePlan,
  deleteCarePlanItem,
  findScheduleConflicts,
  getCarePlan,
  listCarePlans,
  listProviderTasks,
  suggestCarePlan,
  updateCarePlanItem,
  updateProviderTaskStatus
} from './lib/care-plan.mjs';
import { buildDialogueAnalysis, createDialogueTranscriptStore } from './lib/dialogue-transcripts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3030);
const APP_DIR = path.join(__dirname, 'app');
const EXTENSION_DIR = path.join(__dirname, 'extension');
const GENERATED_DIR = path.join(__dirname, 'data/generated');
const RUNTIME_PATH = path.join(__dirname, 'data/runtime/state.json');
const INTAKE_DB_PATH = path.join(__dirname, 'data/intake/intakes.sqlite');
const INTAKE_UPLOAD_DIR = path.join(__dirname, 'data/intake/uploads');
const WHATSAPP_WEBHOOK_LOG_PATH = path.join(__dirname, 'data/intake/webhook-events.log');
const DIALOGUE_DB_PATH = path.join(__dirname, 'data/encounters/dialogues.sqlite');

function loadLocalEnv() {
  for (const envFile of ['.env.local', '.env']) {
    const envPath = path.join(__dirname, envFile);
    if (!fs.existsSync(envPath)) continue;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [rawKey, ...rawValueParts] = trimmed.split('=');
      const key = rawKey.trim();
      const value = rawValueParts.join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadLocalEnv();

await writeArtifacts(GENERATED_DIR);
const artifacts = buildArtifacts();
let runtime = seedRuntimeState(artifacts);

function mergeRuntimeState(baseRuntime, persistedRuntime) {
  if (!persistedRuntime || typeof persistedRuntime !== 'object') return baseRuntime;

  const persistedDays = Array.isArray(persistedRuntime.scheduleDays) ? persistedRuntime.scheduleDays : [];
  const persistedAppointments = persistedRuntime.appointments || {};

  const scheduleDays = baseRuntime.scheduleDays.map((day) => {
    const persistedDay = persistedDays.find((item) => item.date === day.date);
    if (!persistedDay) return day;
    const slots = day.slots.map((slot) => {
      const persistedSlot = (persistedDay.slots || []).find((item) =>
        item.slot_id === slot.slot_id
        || (item.date === slot.date && item.provider_id === slot.provider_id && item.start_time === slot.start_time)
      );
      return persistedSlot ? { ...slot, ...persistedSlot } : slot;
    });
    return { ...day, ...persistedDay, slots };
  });

  const appointments = Object.fromEntries(
    Object.entries(baseRuntime.appointments).map(([appointmentId, baseAppointment]) => {
      const persistedAppointment = persistedAppointments[appointmentId];
      if (!persistedAppointment) return [appointmentId, baseAppointment];
      return [appointmentId, {
        ...baseAppointment,
        ...persistedAppointment,
        inspection_draft: {
          ...baseAppointment.inspection_draft,
          ...(persistedAppointment.inspection_draft || {}),
          supplemental: {
            ...baseAppointment.inspection_draft.supplemental,
            ...(persistedAppointment.inspection_draft?.supplemental || {})
          },
          medical_record_sections: Array.isArray(persistedAppointment.inspection_draft?.medical_record_sections)
            ? persistedAppointment.inspection_draft.medical_record_sections
            : baseAppointment.inspection_draft.medical_record_sections
        },
        draft_state: {
          ...baseAppointment.draft_state,
          ...(persistedAppointment.draft_state || {})
        },
        readonly_tabs: {
          ...baseAppointment.readonly_tabs,
          ...(persistedAppointment.readonly_tabs || {})
        }
      }];
    })
  );

  return {
    ...baseRuntime,
    ...persistedRuntime,
    providers: Array.isArray(persistedRuntime.providers) && persistedRuntime.providers.length ? persistedRuntime.providers : baseRuntime.providers,
    patients: Array.isArray(persistedRuntime.patients) && persistedRuntime.patients.length ? persistedRuntime.patients : baseRuntime.patients,
    patient_assets: persistedRuntime.patient_assets || {},
    scheduleDays,
    appointments,
    currentDate: persistedRuntime.currentDate || baseRuntime.currentDate,
    voiceLexicon: persistedRuntime.voiceLexicon || baseRuntime.voiceLexicon
  };
}

async function loadPersistedRuntime() {
  try {
    const raw = await fsp.readFile(RUNTIME_PATH, 'utf8');
    const persistedRuntime = JSON.parse(raw);
    runtime = mergeRuntimeState(runtime, persistedRuntime);
    normalizeRuntimePatients(runtime);
    for (const patient of runtime.patients || []) {
      syncPatientReadonlyFiles(runtime, patient.patient_id);
    }
  } catch {
    // Ignore absent or invalid runtime snapshots and keep a fresh seeded state.
  }
}

await loadPersistedRuntime();
ensureCarePlanningRuntime(runtime);
await fsp.writeFile(path.join(GENERATED_DIR, 'voice_lexicon.json'), JSON.stringify(runtime.voiceLexicon, null, 2), 'utf8');
await persistRuntime();
const intakeStore = createIntakeStore({
  dbPath: INTAKE_DB_PATH,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`,
  whatsappBusinessNumber: process.env.WHATSAPP_BUSINESS_NUMBER || ''
});
intakeStore.upsertDoctors(runtime.providers);
const dialogueTranscriptStore = createDialogueTranscriptStore({ dbPath: DIALOGUE_DB_PATH });

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, payload, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(payload);
}

async function appendWhatsAppWebhookLog(event) {
  await fsp.mkdir(path.dirname(WHATSAPP_WEBHOOK_LOG_PATH), { recursive: true });
  await fsp.appendFile(WHATSAPP_WEBHOOK_LOG_PATH, `${JSON.stringify({
    at: new Date().toISOString(),
    ...event
  })}\n`, 'utf8');
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

async function doctorWithQr(doctor) {
  if (!doctor) return null;
  return {
    ...doctor,
    qr_data_url: await QRCode.toDataURL(doctor.whatsapp_url, {
      margin: 1,
      width: 256,
      color: { dark: '#0f172a', light: '#ffffff' }
    })
  };
}

function normalizeWhatsAppRecipient(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^8\d{10}$/.test(digits)) {
    return `7${digits.slice(1)}`;
  }
  return digits;
}

function buildWhatsAppQuestionnaireMessage(doctor) {
  return [
    'Начнем консультацию.',
    `Код врача: ${doctor.qr_token}`,
    '',
    'Отправьте этот код ответом в WhatsApp. После этого бот задаст вопросы по одному:',
    '1. ИИН пациента',
    '2. ФИО пациента',
    '3. телефон',
    '4. жалоба и уточнения',
    '5. фото или документы, если нужно'
  ].join('\n');
}

function whatsappInviteTemplateConfig(doctor) {
  const name = process.env.WHATSAPP_INVITE_TEMPLATE_NAME || 'hello_world';
  const language = process.env.WHATSAPP_INVITE_TEMPLATE_LANGUAGE || 'en_US';
  const tokenParamEnabled = /^(1|true|yes)$/i.test(process.env.WHATSAPP_INVITE_TEMPLATE_TOKEN_PARAM || '');
  const questionnaireParamEnabled = /^(1|true|yes)$/i.test(process.env.WHATSAPP_INVITE_TEMPLATE_QUESTIONNAIRE_PARAM || '');
  const parameters = [];
  if (tokenParamEnabled) {
    parameters.push({ type: 'text', text: doctor.qr_token });
  }
  if (questionnaireParamEnabled) {
    parameters.push({ type: 'text', text: buildWhatsAppQuestionnaireMessage(doctor) });
  }
  return {
    name,
    language,
    components: parameters.length ? [{ type: 'body', parameters }] : []
  };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function serveStatic(res, baseDir, requestedPath) {
  const normalized = requestedPath === '/' ? '/index.html' : requestedPath;
  const filePath = path.normalize(path.join(baseDir, normalized));
  if (!filePath.startsWith(baseDir)) {
    return notFound(res);
  }
  try {
    const content = await fsp.readFile(filePath);
    sendText(res, 200, content, contentTypeFor(filePath));
  } catch (error) {
    notFound(res);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getCurrentDay(date) {
  return runtime.scheduleDays.find((day) => day.date === date) || runtime.scheduleDays[0];
}

function serializeScheduleDay(day, statusFilter = 'all') {
  const slots = day.slots.filter((slot) => {
    if (statusFilter === 'completed') return slot.status === 'completed';
    if (statusFilter === 'scheduled') return slot.status === 'scheduled';
    return true;
  }).map((slot) => ({
    ...slot,
    patient: getPatientById(runtime, slot.patient_id),
    appointment: getAppointmentById(runtime, slot.appointment_id)
  }));
  return { ...day, slots };
}

function serializeScheduleWindow(activeDate) {
  return runtime.scheduleDays.map((day, index) => {
    const slots = day.slots || [];
    const scheduledCount = slots.filter((slot) => slot.status === 'scheduled').length;
    const completedCount = slots.filter((slot) => slot.status === 'completed').length;
    const availableCount = slots.filter((slot) => slot.status === 'available').length;
    const occupiedCount = scheduledCount + completedCount;

    return {
      date: day.date,
      dayIndex: index + 1,
      isActive: day.date === activeDate,
      providerCount: new Set(slots.map((slot) => slot.provider_id)).size,
      slotsCount: slots.length,
      scheduledCount,
      completedCount,
      availableCount,
      occupiedCount,
      occupancyRate: slots.length ? Math.round((occupiedCount / slots.length) * 100) : 0
    };
  });
}

function serializeSchedulePayload(date, statusFilter = 'all') {
  const currentDay = getCurrentDay(date);
  runtime.currentDate = currentDay.date;
  return {
    currentDate: runtime.currentDate,
    scheduleDay: serializeScheduleDay(currentDay, statusFilter),
    scheduleWindow: serializeScheduleWindow(runtime.currentDate)
  };
}

async function persistRuntime() {
  await fsp.mkdir(path.dirname(RUNTIME_PATH), { recursive: true });
  await fsp.writeFile(RUNTIME_PATH, JSON.stringify(runtime, null, 2), 'utf8');
}

const KNOWN_PATIENT_NAME_FIXES = {
  'patient-history-1': 'Рахметолла Айкунім',
  'patient-history-2': 'Ахмедияр Іңкәр',
  'patient-history-3': 'Нұрбөлекұлы Нұрәли',
  'patient-history-4': 'Темірбай Айбат',
  'patient-history-5': 'Базархан Мирас',
  'patient-history-6': 'Қарақойшин Амре',
  'ARCH-001': 'Рахметолла Айкунім',
  'ARCH-002': 'Ахмедияр Іңкәр',
  'ARCH-003': 'Нұрбөлекұлы Нұрәли',
  'ARCH-004': 'Темірбай Айбат',
  'ARCH-005': 'Базархан Мирас',
  'ARCH-006': 'Қарақойшин Амре',
  'history-1': 'Рахметолла Айкунім',
  'history-2': 'Ахмедияр Іңкәр',
  'history-3': 'Нұрбөлекұлы Нұрәли',
  'history-4': 'Темірбай Айбат',
  'history-5': 'Базархан Мирас',
  'history-6': 'Қарақойшин Амре'
};

function looksLikeBrokenPatientName(value) {
  const text = String(value || '');
  return /Р[А-Яа-яA-Za-z]/.test(text) || /С[А-Яа-яA-Za-z]/.test(text) || text.includes('вЂ') || text.includes('пїЅ');
}

function normalizePatientFullName(patient) {
  const byPatientId = patient?.patient_id ? KNOWN_PATIENT_NAME_FIXES[patient.patient_id] : '';
  if (byPatientId) return byPatientId;
  const byLocalId = patient?.iin_or_local_id ? KNOWN_PATIENT_NAME_FIXES[patient.iin_or_local_id] : '';
  if (byLocalId) return byLocalId;
  const byHistoryRef = Array.isArray(patient?.history_refs)
    ? patient.history_refs.map((ref) => KNOWN_PATIENT_NAME_FIXES[ref]).find(Boolean)
    : '';
  if (byHistoryRef) return byHistoryRef;
  const name = String(patient?.full_name || '').trim();
  return looksLikeBrokenPatientName(name) ? '' : name;
}

function normalizePatientRecord(patient) {
  return {
    ...patient,
    full_name: normalizePatientFullName(patient) || patient.full_name || ''
  };
}

function normalizeRuntimePatients(targetRuntime) {
  if (!Array.isArray(targetRuntime?.patients)) return;
  targetRuntime.patients = targetRuntime.patients.map(normalizePatientRecord);
}

function ensureCarePlanningRuntime(targetRuntime) {
  if (!targetRuntime || typeof targetRuntime !== 'object') return;
  if (!targetRuntime.carePlans || typeof targetRuntime.carePlans !== 'object' || Array.isArray(targetRuntime.carePlans)) {
    targetRuntime.carePlans = {};
  }

  const requiredProviders = [
    {
      provider_id: 'provider-4',
      full_name: 'Мадина Абаева',
      short_name: 'М. Абаева',
      specialty: 'Терапевт',
      schedule_name: 'Терапевт — кабинет 4',
      care_role: 'therapist',
      scheduler_busy_slots: []
    },
    {
      provider_id: 'provider-5',
      full_name: 'Ерлан Садыков',
      short_name: 'Е. Садыков',
      specialty: 'Массажист',
      schedule_name: 'Массажист — кабинет 5',
      care_role: 'massage',
      scheduler_busy_slots: []
    }
  ];

  targetRuntime.providers = Array.isArray(targetRuntime.providers) ? targetRuntime.providers : [];
  for (const provider of targetRuntime.providers) {
    if (provider.provider_id === 'provider-1' && !provider.care_role) provider.care_role = 'primary';
    if (/психолог|psycholog/i.test(`${provider.specialty || ''} ${provider.schedule_name || ''}`) && !provider.care_role) {
      provider.care_role = 'psychology';
    }
  }
  for (const provider of requiredProviders) {
    if (!targetRuntime.providers.some((item) => item.provider_id === provider.provider_id)) {
      targetRuntime.providers.push(provider);
    }
  }

  if (!Array.isArray(targetRuntime.scheduleDays) || !targetRuntime.scheduleDays.length) return;
  targetRuntime.appointments = targetRuntime.appointments || {};
  const boardHours = [...new Set(targetRuntime.scheduleDays.flatMap((day) => (day.slots || []).map((slot) => slot.start_time)))].sort();
  const sampleAppointment = Object.values(targetRuntime.appointments)[0] || null;
  targetRuntime.scheduleDays.forEach((day, dayIndex) => {
    day.slots = Array.isArray(day.slots) ? day.slots : [];
    requiredProviders.forEach((provider) => {
      const providerHasSlots = day.slots.some((slot) => slot.provider_id === provider.provider_id);
      if (providerHasSlots) return;
      boardHours.forEach((startTime, hourIndex) => {
        const [slotHour, slotMinute] = startTime.split(':').map(Number);
        const endTotalMinutes = slotHour * 60 + slotMinute + 30;
        const endTime = `${String(Math.floor(endTotalMinutes / 60)).padStart(2, '0')}:${String(endTotalMinutes % 60).padStart(2, '0')}`;
        const slotId = `slot-${day.date}-${provider.provider_id}-${hourIndex + 1}`;
        const appointmentId = `appointment-${dayIndex + 1}-${provider.provider_id}-${hourIndex + 1}`;
        day.slots.push({
          slot_id: slotId,
          date: day.date,
          start_time: startTime,
          end_time: endTime,
          provider_id: provider.provider_id,
          status: 'available',
          patient_id: null,
          appointment_id: appointmentId,
          triage: 'minor',
          service_code: provider.care_role === 'massage' ? 'MASSAGE-001' : 'THERAPY-001',
          service_name: provider.care_role === 'massage' ? 'Массаж / реабилитация' : 'Консультация терапевта'
        });
        if (!targetRuntime.appointments[appointmentId]) {
          targetRuntime.appointments[appointmentId] = {
            ...(sampleAppointment || {}),
            appointment_id: appointmentId,
            patient_id: null,
            provider_id: provider.provider_id,
            schedule_slot_id: slotId,
            status: 'available',
            service_code: provider.care_role === 'massage' ? 'MASSAGE-001' : 'THERAPY-001',
            service_name: provider.care_role === 'massage' ? 'Массаж / реабилитация' : 'Консультация терапевта',
            created_at: `${day.date}T${startTime}:00`,
            executed_at: null,
            provider_result_note: '',
            inspection_draft: {
              ...(sampleAppointment?.inspection_draft || {}),
              appointment_id: appointmentId,
              execute_date: day.date,
              execute_time: startTime,
              duration_min: 30,
              specialist_name: provider.short_name || provider.full_name,
              conclusion_text: '',
              appointments_text: ''
            },
            draft_state: {
              appointment_id: appointmentId,
              draft_status: 'idle',
              transcript_chunks: [],
              fact_candidates: [],
              draft_patches: [],
              applied_patch_ids: [],
              updated_at: null,
              last_preview: null
            },
            readonly_tabs: sampleAppointment?.readonly_tabs || {}
          };
        }
      });
    });
  });
}

function addAudit(entry) {
  runtime.auditEntries.unshift(entry);
  if (runtime.auditEntries.length > 200) {
    runtime.auditEntries.length = 200;
  }
}

function getElevenLabsApiKey() {
  return process.env.ELEVENLABS_API_KEY || process.env.SPEECH_TO_TEXT_API_KEY || '';
}

function buildFallbackPatients() {
  return [
    {
      patient_id: 'patient-fallback-1',
      full_name: 'Алиева Амина Сериковна',
      birth_date: '2018-05-14',
      iin_or_local_id: '180514300001',
      sex: 'female',
      specialty_track: 'psychology-rehabilitation'
    },
    {
      patient_id: 'patient-fallback-2',
      full_name: 'Нургалиев Арсен Даниярович',
      birth_date: '2017-11-02',
      iin_or_local_id: '171102300002',
      sex: 'male',
      specialty_track: 'psychology-rehabilitation'
    },
    {
      patient_id: 'patient-fallback-3',
      full_name: 'Садыкова Малика Руслановна',
      birth_date: '2019-02-20',
      iin_or_local_id: '190220300003',
      sex: 'female',
      specialty_track: 'psychology-rehabilitation'
    }
  ];
}

function getSchedulerPatients(runtime) {
  const patients = Array.isArray(runtime?.patients) && runtime.patients.length
    ? runtime.patients
    : buildFallbackPatients();

  return patients.map((patient) => ({
    patient_id: patient.patient_id,
    full_name: normalizePatientFullName(patient) || patient.full_name,
    birth_date: patient.birth_date || '',
    iin_or_local_id: patient.iin_or_local_id || '',
    sex: patient.sex || '',
    specialty_track: patient.specialty_track || 'psychology-rehabilitation'
  }));
}

function getSchedulerPatientById(runtime, patientId) {
  return getSchedulerPatients(runtime).find((patient) => patient.patient_id === patientId) || null;
}

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function assetsToReadonlyFiles(assets = []) {
  return assets.map((asset) => ({
    id: asset.asset_id,
    name: asset.name,
    source: asset.category,
    summary: asset.text_excerpt || ''
  }));
}

function syncPatientReadonlyFiles(runtime, patientId) {
  const patient = getPatientById(runtime, patientId) || getSchedulerPatientById(runtime, patientId);
  if (!patient) return;
  const extraFiles = assetsToReadonlyFiles(getPatientAssets(runtime, patientId));
  const readonlyFiles = buildReadonlyTabs(patient, { extraFiles }).files;

  for (const appointment of Object.values(runtime.appointments || {})) {
    if (appointment.patient_id !== patientId) continue;
    appointment.readonly_tabs = {
      ...appointment.readonly_tabs,
      files: readonlyFiles
    };
  }
}

function presetFieldKey(fieldKey) {
  const map = {
    complaints_text: 'complaints',
    anamnesis_text: 'anamnesis',
    objective_status_text: 'objective-status',
    appointments_text: 'appointments',
    tbmedicalfinal: 'tbmedicalfinal',
    recommendations: 'recommendations',
    dynamics: 'dynamics',
    work_plan: 'work-plan',
    planned_sessions: 'planned-sessions',
    completed_sessions: 'completed-sessions'
  };
  return map[fieldKey] || fieldKey;
}

function buildPresetPatches(preset) {
  return Object.entries(preset?.fields || {})
    .map(([fieldKey, value]) => ({
      field_key: presetFieldKey(fieldKey),
      value_type: 'text',
      value: compactText(value),
      title: fieldKey
    }))
    .filter((patch) => patch.value);
}

function resolvePatientAssetsContext(runtime, { patientId = '', appointmentId = '' } = {}) {
  const appointment = appointmentId ? getAppointmentById(runtime, appointmentId) : null;
  const resolvedPatientId = patientId || appointment?.patient_id || '';
  const patient = resolvedPatientId ? (getPatientById(runtime, resolvedPatientId) || getSchedulerPatientById(runtime, resolvedPatientId)) : null;
  const assets = resolvedPatientId ? getPatientAssets(runtime, resolvedPatientId) : [];
  return {
    appointment,
    patient,
    patientId: resolvedPatientId,
    assets
  };
}

function getAttachedPatientsByProvider(runtime, providerId) {
  const provider = Array.isArray(runtime?.providers)
    ? runtime.providers.find((item) => item.provider_id === providerId)
    : null;
  const attachedIds = new Set(Array.isArray(provider?.attached_patient_ids) ? provider.attached_patient_ids : []);
  if (!attachedIds.size) {
    return Array.isArray(runtime?.patients) ? runtime.patients.map(normalizePatientRecord) : [];
  }
  return (Array.isArray(runtime?.patients) ? runtime.patients : [])
    .filter((patient) => attachedIds.has(patient.patient_id))
    .map(normalizePatientRecord);
}

function resetAppointmentMedicalState(appointment, patient) {
  appointment.patient_id = patient.patient_id;
  appointment.status = 'scheduled';
  appointment.executed_at = null;
  appointment.inspection_draft = {
    ...appointment.inspection_draft,
    complaints_text: '',
    anamnesis_text: '',
    objective_status_text: '',
    appointments_text: '',
    conclusion_text: '',
    medical_record_sections: appointment.inspection_draft.medical_record_sections.map((section) => ({
      ...section,
      text: '',
      options: (section.options || []).map((option) => ({ ...option, selected: false }))
    })),
    supplemental: {
      ...appointment.inspection_draft.supplemental,
      work_plan: '',
      planned_sessions: '',
      completed_sessions: '',
      dynamics: '',
      recommendations: ''
    }
  };
  appointment.draft_state = {
    appointment_id: appointment.appointment_id,
    draft_status: 'idle',
    transcript_chunks: [],
    fact_candidates: [],
    draft_patches: [],
    applied_patch_ids: [],
    updated_at: null,
    last_preview: null
  };
  appointment.readonly_tabs = {
    ...buildReadonlyTabs(patient),
    diaries: [{ id: 'diary-1', note: `${patient.full_name}: прием запланирован, форма ожидает заполнения.` }]
  };
  syncPatientReadonlyFiles(runtime, patient.patient_id);
}

function buildSchedulingPsychologists(runtime) {
  const psychologists = buildPsychologistsFromRuntime(runtime);
  return psychologists.map((psychologist) => {
    const occupiedSlots = runtime.scheduleDays
      .flatMap((day) => day.slots)
      .filter((slot) => slot.provider_id === psychologist.psychologist_id && slot.patient_id)
      .map((slot) => ({
        date: slot.date,
        start: slot.start_time,
        end: slot.end_time
      }));

    return {
      ...psychologist,
      busy_slots: [...(psychologist.busy_slots || []), ...occupiedSlots]
    };
  });
}

function applyGeneratedScheduleToRuntime(generated, patientId) {
  const applied = [];
  const unassigned = [...(generated.unassigned || [])];

  for (const day of generated.days || []) {
    for (const appointment of day.appointments || []) {
      const targetDay = runtime.scheduleDays.find((item) => item.date === day.date);
      const slot = targetDay?.slots.find((item) =>
        item.provider_id === appointment.psychologistId &&
        item.start_time === appointment.start
      );

      if (!slot) {
        unassigned.push({
          date: day.date,
          durationMin: appointment.durationMin,
          reason: 'Generated slot is outside the visible schedule grid.'
        });
        continue;
      }

      if (slot.patient_id && slot.patient_id !== patientId) {
        unassigned.push({
          date: day.date,
          durationMin: appointment.durationMin,
          reason: 'Target slot is already occupied in the schedule grid.'
        });
        continue;
      }

      const patient = getPatientById(runtime, patientId);
      if (!patient) continue;

      slot.patient_id = patient.patient_id;
      slot.status = 'scheduled';
      const runtimeAppointment = runtime.appointments[slot.appointment_id];
      resetAppointmentMedicalState(runtimeAppointment, patient);
      applied.push({
        date: day.date,
        slot_id: slot.slot_id,
        appointment_id: slot.appointment_id,
        provider_id: slot.provider_id,
        start: slot.start_time,
        end: slot.end_time
      });
    }
  }

  return {
    ...generated,
    applied,
    unassigned
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/whatsapp/webhook') {
    const verification = verifyWhatsAppWebhook(url.searchParams);
    await appendWhatsAppWebhookLog({
      method: 'GET',
      mode: url.searchParams.get('hub.mode') || '',
      ok: verification.ok
    });
    if (!verification.ok) {
      return sendJson(res, 403, { ok: false, error: 'Invalid WhatsApp verify token.' });
    }
    return sendText(res, 200, verification.challenge);
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/webhook') {
    const body = await readBody(req);
    const changes = (body?.entry || []).flatMap((entry) => entry?.changes || []);
    await appendWhatsAppWebhookLog({
      method: 'POST',
      object: body?.object || '',
      entries: Array.isArray(body?.entry) ? body.entry.length : 0,
      messageCount: changes.reduce((count, change) => count + (change?.value?.messages?.length || 0), 0),
      statusCount: changes.reduce((count, change) => count + (change?.value?.statuses?.length || 0), 0)
    });
    const result = await handleWhatsAppWebhook({
      store: intakeStore,
      body,
      uploadRoot: INTAKE_UPLOAD_DIR
    });
    return sendJson(res, 200, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/whatsapp/start') {
    const token = url.searchParams.get('token') || '';
    const doctor = intakeStore.getDoctorByToken(token);
    return sendJson(res, doctor ? 200 : 404, {
      ok: Boolean(doctor),
      doctor,
      message: doctor
        ? 'Open this link on a phone with WhatsApp and send the prepared doctor token.'
        : 'Doctor QR token was not found.'
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/whatsapp/doctors') {
    const doctors = await Promise.all(intakeStore.listDoctors().map(doctorWithQr));
    return sendJson(res, 200, { ok: true, doctors });
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/test-invite') {
    const body = await readBody(req);
    const doctor = intakeStore.getDoctor(body.doctorId);
    const to = normalizeWhatsAppRecipient(body.to);
    if (!doctor) return sendJson(res, 404, { ok: false, error: 'Doctor was not found.' });
    if (to.length < 8) return sendJson(res, 400, { ok: false, error: 'Valid WhatsApp recipient number is required.' });

    let templateResult = null;
    let instructionResult = null;
    let instructionError = null;
    const templateConfig = whatsappInviteTemplateConfig(doctor);
    const startMessage = buildWhatsAppQuestionnaireMessage(doctor);
    try {
      templateResult = await sendWhatsAppTemplate(
        to,
        templateConfig.name,
        templateConfig.language,
        templateConfig.components
      );
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: `Meta did not send the ${templateConfig.name} template. Check the access token, template name, language, and API Setup -> To recipient.`,
        details: error.message,
        manualToken: doctor.qr_token,
        questionnaire: startMessage
      });
    }

    const instructionText = [
      'Damumed Assistant: WhatsApp intake.',
      `Врач: ${doctor.display_name}.`,
      startMessage
    ].join('\n');
    try {
      instructionResult = await sendWhatsAppMessage(to, instructionText);
    } catch (error) {
      instructionError = error.message;
    }

    return sendJson(res, 200, {
      ok: true,
      to,
      doctor,
      template: templateResult,
      templateName: templateConfig.name,
      instruction: instructionResult,
      instructionError,
      manualToken: doctor.qr_token,
      questionnaire: startMessage
    });
  }

  if (req.method === 'POST' && /^\/api\/whatsapp\/doctors\/[^/]+\/qr$/.test(url.pathname)) {
    const doctorId = decodeURIComponent(url.pathname.split('/')[4]);
    const doctor = await doctorWithQr(intakeStore.ensureDoctorQr(doctorId));
    if (!doctor) return notFound(res);
    return sendJson(res, 200, { ok: true, doctor });
  }

  if (req.method === 'GET' && url.pathname === '/api/whatsapp/intakes') {
    const doctorId = url.searchParams.get('doctorId') || '';
    if (!doctorId) return sendJson(res, 400, { ok: false, error: 'doctorId is required.' });
    const intakes = intakeStore.listIntakes({
      doctorId,
      query: url.searchParams.get('query') || '',
      status: url.searchParams.get('status') || ''
    });
    return sendJson(res, 200, { ok: true, intakes });
  }

  if (req.method === 'GET' && /^\/api\/whatsapp\/intakes\/[^/]+$/.test(url.pathname)) {
    const intakeId = decodeURIComponent(url.pathname.split('/')[4]);
    const doctorId = url.searchParams.get('doctorId') || '';
    if (!doctorId) return sendJson(res, 400, { ok: false, error: 'doctorId is required.' });
    const intake = intakeStore.getIntakeForDoctor(intakeId, doctorId);
    if (!intake) return notFound(res);
    return sendJson(res, 200, { ok: true, intake });
  }

  if (req.method === 'POST' && /^\/api\/whatsapp\/intakes\/[^/]+\/import$/.test(url.pathname)) {
    const intakeId = decodeURIComponent(url.pathname.split('/')[4]);
    const body = await readBody(req);
    const intake = intakeStore.getIntakeForDoctor(intakeId, body.doctorId);
    if (!intake) return notFound(res);
    intakeStore.updateIntake(intakeId, { status: 'imported' });
    return sendJson(res, 200, {
      ok: true,
      intake: intakeStore.getIntake(intakeId),
      message: {
        title: 'WhatsApp intake',
        body: [
          intake.patient_fio ? `Пациент: ${intake.patient_fio}` : '',
          intake.iin ? `ИИН: ${intake.iin}` : '',
          intake.phone ? `Телефон: ${intake.phone}` : '',
          intake.main_complaint ? `Жалоба: ${intake.main_complaint}` : '',
          intake.analysis_text || ''
        ].filter(Boolean).join('\n')
      }
    });
  }

  if (req.method === 'POST' && /^\/api\/whatsapp\/intakes\/[^/]+\/status$/.test(url.pathname)) {
    const intakeId = decodeURIComponent(url.pathname.split('/')[4]);
    const body = await readBody(req);
    const intake = intakeStore.getIntakeForDoctor(intakeId, body.doctorId);
    if (!intake) return notFound(res);
    const status = ['new', 'reviewed', 'imported', 'collecting'].includes(body.status) ? body.status : 'reviewed';
    return sendJson(res, 200, { ok: true, intake: intakeStore.updateIntake(intakeId, { status }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const schedulePayload = serializeSchedulePayload(runtime.currentDate, 'all');
    return sendJson(res, 200, {
      app: {
        name: 'Damumed Sandbox',
        phase: 'phase-1-vertical-slice',
        server_time: new Date().toISOString()
      },
      currentDate: schedulePayload.currentDate,
      providers: runtime.providers,
      patients: getSchedulerPatients(runtime),
      scheduleDay: schedulePayload.scheduleDay,
      scheduleWindow: schedulePayload.scheduleWindow,
      sourceOfTruth: {
        generated_at: artifacts.generated_at,
        screens: artifacts.screen_inventory,
        fieldCount: artifacts.field_map.length,
        locatorCount: artifacts.locator_registry.length,
        usingFallbacks: artifacts.dataset_paths.usingFallbacks
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/source-of-truth') {
    return sendJson(res, 200, artifacts);
  }

  if (req.method === 'GET' && url.pathname === '/api/schedule') {
    const date = url.searchParams.get('date') || runtime.currentDate;
    const statusFilter = url.searchParams.get('status') || 'all';
    return sendJson(res, 200, serializeSchedulePayload(date, statusFilter));
  }

  if (req.method === 'GET' && url.pathname === '/api/care-plans') {
    return sendJson(res, 200, {
      ok: true,
      carePlans: listCarePlans(runtime, {
        patientId: url.searchParams.get('patientId') || '',
        primaryProviderId: url.searchParams.get('primaryProviderId') || '',
        status: url.searchParams.get('status') || ''
      })
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/care-plans/suggest') {
    const body = await readBody(req);
    const plan = suggestCarePlan(runtime, {
      patientId: body.patientId,
      appointmentId: body.appointmentId,
      planningWindowDays: body.planningWindowDays
    });
    addAudit(createAuditEntry({
      actorType: 'ai',
      actionType: 'suggest_care_plan',
      screenId: 'care-plan',
      entityRefs: { appointment_id: body.appointmentId, patient_id: plan.patient_id },
      payload: { planningWindowDays: plan.planning_window_days },
      result: `draft:${plan.items.length}`
    }));
    await persistRuntime();
    return sendJson(res, 200, { ok: true, plan });
  }

  if (req.method === 'GET' && /^\/api\/care-plans\/[^/]+$/.test(url.pathname)) {
    const planId = decodeURIComponent(url.pathname.split('/')[3]);
    const plan = getCarePlan(runtime, planId);
    if (!plan) return sendJson(res, 404, { ok: false, error: 'Care plan not found.' });
    return sendJson(res, 200, { ok: true, plan });
  }

  if (req.method === 'PATCH' && /^\/api\/care-plans\/[^/]+\/items\/[^/]+$/.test(url.pathname)) {
    const [, , , planId, , itemId] = url.pathname.split('/');
    const body = await readBody(req);
    const plan = updateCarePlanItem(runtime, decodeURIComponent(planId), decodeURIComponent(itemId), body);
    await persistRuntime();
    return sendJson(res, 200, { ok: true, plan });
  }

  if (req.method === 'POST' && /^\/api\/care-plans\/[^/]+\/items$/.test(url.pathname)) {
    const planId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const plan = addCarePlanItem(runtime, planId, body);
    await persistRuntime();
    return sendJson(res, 200, { ok: true, plan });
  }

  if (req.method === 'POST' && /^\/api\/care-plans\/[^/]+\/items\/[^/]+\/delete$/.test(url.pathname)) {
    const [, , , planId, , itemId] = url.pathname.split('/');
    const plan = deleteCarePlanItem(runtime, decodeURIComponent(planId), decodeURIComponent(itemId));
    await persistRuntime();
    return sendJson(res, 200, { ok: true, plan });
  }

  if (req.method === 'POST' && /^\/api\/care-plans\/[^/]+\/confirm$/.test(url.pathname)) {
    const planId = decodeURIComponent(url.pathname.split('/')[3]);
    const result = confirmCarePlan(runtime, planId);
    addAudit(createAuditEntry({
      actorType: 'ui',
      actionType: 'confirm_care_plan',
      screenId: 'care-plan',
      entityRefs: { care_plan_id: planId, patient_id: result.plan?.patient_id },
      payload: { itemCount: result.plan?.items?.length || 0 },
      result: result.ok ? 'confirmed' : `conflicts:${result.conflicts.length}`
    }));
    await persistRuntime();
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/providers/tasks') {
    const providerId = url.searchParams.get('providerId') || '';
    return sendJson(res, 200, {
      ok: true,
      tasks: providerId ? listProviderTasks(runtime, providerId, { status: url.searchParams.get('status') || '' }) : []
    });
  }

  if (req.method === 'GET' && /^\/api\/providers\/[^/]+\/tasks$/.test(url.pathname)) {
    const providerId = decodeURIComponent(url.pathname.split('/')[3]);
    return sendJson(res, 200, {
      ok: true,
      tasks: listProviderTasks(runtime, providerId, { status: url.searchParams.get('status') || '' })
    });
  }

  if (req.method === 'POST' && /^\/api\/provider-tasks\/[^/]+\/status$/.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const result = updateProviderTaskStatus(runtime, taskId, {
      status: body.status,
      resultNote: body.resultNote
    });
    addAudit(createAuditEntry({
      actorType: 'ui',
      actionType: 'update_provider_task_status',
      screenId: 'care-plan',
      entityRefs: { task_id: taskId, care_plan_id: result.plan?.plan_id },
      payload: { status: body.status, resultNote: body.resultNote || '' },
      result: result.task?.status || body.status
    }));
    await persistRuntime();
    return sendJson(res, 200, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/schedule/conflicts') {
    const planId = url.searchParams.get('planId') || '';
    const plan = planId ? getCarePlan(runtime, planId) : null;
    const items = plan?.items || [{
      item_id: 'query',
      provider_id: url.searchParams.get('providerId') || '',
      date: url.searchParams.get('date') || '',
      start_time: url.searchParams.get('start') || '',
      end_time: url.searchParams.get('end') || ''
    }];
    return sendJson(res, 200, { ok: true, conflicts: findScheduleConflicts(runtime, { items, planId }) });
  }

  if (req.method === 'POST' && url.pathname === '/api/dialogue-transcripts') {
    const body = await readBody(req);
    const appointment = body.appointmentId ? runtime.appointments?.[body.appointmentId] : null;
    const patientId = body.patientId || appointment?.patient_id || '';
    const analysis = buildDialogueAnalysis(body.transcript || '');
    const transcript = dialogueTranscriptStore.saveTranscript({
      appointmentId: body.appointmentId || '',
      patientId,
      source: body.source || 'extension',
      durationSec: body.durationSec || 0,
      transcript: body.transcript || '',
      analysis
    });
    if (appointment?.draft_state && transcript.transcript_text) {
      appointment.draft_state.transcript_chunks = [
        ...(appointment.draft_state.transcript_chunks || []),
        {
          id: `dialogue-${transcript.transcript_id}`,
          text: transcript.transcript_text,
          speakerTag: 'dialogue',
          created_at: transcript.created_at
        }
      ];
      appointment.draft_state.updated_at = transcript.created_at;
    }
    addAudit(createAuditEntry({
      actorType: 'speech',
      actionType: 'save_dialogue_transcript',
      screenId: 'inspection',
      entityRefs: { appointment_id: body.appointmentId || '', patient_id: patientId },
      payload: { durationSec: body.durationSec || 0, source: body.source || 'extension' },
      result: 'saved_text_only'
    }));
    await persistRuntime();
    return sendJson(res, 200, { ok: true, transcript });
  }

  if (req.method === 'GET' && url.pathname === '/api/dialogue-transcripts') {
    return sendJson(res, 200, {
      ok: true,
      transcripts: dialogueTranscriptStore.listTranscripts({
        appointmentId: url.searchParams.get('appointmentId') || '',
        patientId: url.searchParams.get('patientId') || ''
      })
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/current-date') {
    const body = await readBody(req);
    runtime.currentDate = getCurrentDay(body.date || runtime.currentDate).date;
    await persistRuntime();
    return sendJson(res, 200, { currentDate: runtime.currentDate });
  }

  if (req.method === 'GET' && url.pathname === '/api/patients/search') {
    const q = url.searchParams.get('q') || '';
    const providerIdFromQuery = url.searchParams.get('providerId') || '';
    const slotId = url.searchParams.get('slotId') || '';
    const slotProviderId = slotId
      ? runtime.scheduleDays.flatMap((day) => day.slots).find((slot) => slot.slot_id === slotId)?.provider_id || ''
      : '';
    const providerId = providerIdFromQuery || slotProviderId;
    const runtimePatients = providerId
      ? getAttachedPatientsByProvider(runtime, providerId)
      : (Array.isArray(runtime?.patients) ? runtime.patients : []);
    const sourcePatients = runtimePatients.length
      ? (q ? runtimePatients.filter((patient) => String(patient.full_name || '').toLowerCase().includes(String(q).trim().toLowerCase()) || String(patient.iin_or_local_id || '').includes(q)) : runtimePatients)
      : getSchedulerPatients(runtime);
    const normalized = String(q || '').trim().toLowerCase();
    const patients = normalized
      ? sourcePatients.filter((patient) => String(normalizePatientFullName(patient) || patient.full_name || '').toLowerCase().includes(normalized) || String(patient.iin_or_local_id || '').includes(normalized))
      : sourcePatients;
    return sendJson(res, 200, { patients: patients.map(normalizePatientRecord) });
  }

  if (req.method === 'GET' && url.pathname === '/api/patient-assets') {
    const context = resolvePatientAssetsContext(runtime, {
      patientId: url.searchParams.get('patientId') || '',
      appointmentId: url.searchParams.get('appointmentId') || ''
    });
    return sendJson(res, 200, {
      patientId: context.patientId,
      assets: context.assets
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/patient-assets/upload') {
    const body = await readBody(req);
    const context = resolvePatientAssetsContext(runtime, {
      patientId: body.patientId || '',
      appointmentId: body.appointmentId || ''
    });
    if (!context.patientId || !context.patient) {
      return sendJson(res, 404, { error: 'Patient not found for asset upload.' });
    }
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) {
      return sendJson(res, 400, { error: 'No files were provided.' });
    }

    const uploaded = [];
    for (const file of files) {
      if (!file?.base64Data || !file?.name) continue;
      const asset = await registerPatientAsset(runtime, {
        patientId: context.patientId,
        fileName: file.name,
        mimeType: file.mimeType,
        base64Data: file.base64Data,
        category: file.category
      });
      uploaded.push(asset);
    }

    if (!uploaded.length) {
      return sendJson(res, 400, { error: 'Files were empty or invalid.' });
    }

    syncPatientReadonlyFiles(runtime, context.patientId);
    addAudit(createAuditEntry({
      actorType: 'extension',
      actionType: 'upload_patient_assets',
      screenId: context.appointment ? 'inspection' : 'schedule',
      entityRefs: { patient_id: context.patientId, appointment_id: context.appointment?.appointment_id || null },
      payload: {
        file_count: uploaded.length,
        files: uploaded.map((asset) => ({ asset_id: asset.asset_id, name: asset.name, category: asset.category }))
      },
      result: 'uploaded'
    }));
    await persistRuntime();
    return sendJson(res, 200, {
      patientId: context.patientId,
      assets: getPatientAssets(runtime, context.patientId)
    });
  }

  if (req.method === 'GET' && /^\/api\/appointments\/[^/]+\/presets$/.test(url.pathname)) {
    const appointmentId = url.pathname.split('/')[3];
    const appointment = getAppointmentById(runtime, appointmentId);
    if (!appointment) return notFound(res);
    const patient = getPatientById(runtime, appointment.patient_id);
    const assets = getPatientAssets(runtime, appointment.patient_id);
    const presets = buildPatientPresets({ patient, appointment, assets });
    return sendJson(res, 200, {
      appointmentId,
      patientId: appointment.patient_id,
      presets
    });
  }

  if (req.method === 'POST' && /^\/api\/appointments\/[^/]+\/preset-preview$/.test(url.pathname)) {
    const appointmentId = url.pathname.split('/')[3];
    const appointment = getAppointmentById(runtime, appointmentId);
    if (!appointment) return notFound(res);
    const body = await readBody(req);
    const patient = getPatientById(runtime, appointment.patient_id);
    const assets = getPatientAssets(runtime, appointment.patient_id);
    const presets = buildPatientPresets({ patient, appointment, assets });
    const preset = presets.find((item) => item.preset_id === body.presetId);
    if (!preset) {
      return sendJson(res, 404, { error: 'Preset not found.' });
    }

    const queued = injectDraftPatches(runtime, appointmentId, buildPresetPatches(preset), {
      provenance: `preset:${preset.preset_id}`
    });
    addAudit(createAuditEntry({
      actorType: 'extension',
      actionType: 'queue_patient_preset',
      screenId: 'inspection',
      entityRefs: { appointment_id: appointmentId, patient_id: appointment.patient_id },
      payload: { preset_id: preset.preset_id, preset_title: preset.title },
      result: 'preview_ready'
    }));
    await persistRuntime();
    return sendJson(res, 200, queued);
  }

  if (req.method === 'POST' && url.pathname === '/api/psychologist-schedule/generate') {
    const body = await readBody(req);
    const patient = getPatientById(runtime, body.patientId) || getSchedulerPatientById(runtime, body.patientId);
    const durationMin = Number(body.durationMin || 30);

    if (!patient) {
      return sendJson(res, 404, { error: 'Patient not found.' });
    }

    if (![30, 40].includes(durationMin)) {
      return sendJson(res, 400, { error: 'durationMin must be 30 or 40.' });
    }

    const generated = generatePsychologistSchedule({
      patient,
      psychologists: buildSchedulingPsychologists(runtime),
      startDate: body.startDate || runtime.currentDate,
      durationMin
    });

    if (body.apply) {
      const appliedSchedule = applyGeneratedScheduleToRuntime(generated, patient.patient_id);
      addAudit(createAuditEntry({
        actorType: 'user',
        actionType: 'generate_psychologist_schedule',
        screenId: 'board',
        entityRefs: { patient_id: patient.patient_id },
        payload: { sessionCount: 9, durationMin, startDate: body.startDate || runtime.currentDate },
        result: `applied:${appliedSchedule.applied.length}`
      }));
      await persistRuntime();
      return sendJson(res, 200, {
        ...appliedSchedule,
        currentDate: runtime.currentDate,
        scheduleWindow: serializeScheduleWindow(runtime.currentDate)
      });
    }

    return sendJson(res, 200, generated);
  }

  if (req.method === 'GET' && /^\/api\/appointments\//.test(url.pathname)) {
    const appointmentId = url.pathname.split('/')[3];
    const appointment = getAppointmentById(runtime, appointmentId);
    if (!appointment) return notFound(res);
    return sendJson(res, 200, {
      appointment,
      patient: getPatientById(runtime, appointment.patient_id),
      draftState: appointment.draft_state,
      advisor_ui: appointment.draft_state?.advisor_state?.ui || null,
      hints: buildHints(runtime, { screen_id: 'inspection', selected_appointment_id: appointmentId })
    });
  }

  if (req.method === 'POST' && /^\/api\/slots\//.test(url.pathname) && url.pathname.endsWith('/assign')) {
    const slotId = url.pathname.split('/')[3];
    const body = await readBody(req);
    const targetDay = runtime.scheduleDays.find((day) => day.slots.some((slot) => slot.slot_id === slotId));
    const slot = targetDay?.slots.find((item) => item.slot_id === slotId);
    const patient = getPatientById(runtime, body.patient_id);
    if (!slot || !patient) return notFound(res);
    slot.patient_id = patient.patient_id;
    slot.status = 'scheduled';
    const appointment = runtime.appointments[slot.appointment_id];
    resetAppointmentMedicalState(appointment, patient);
    appointment.readonly_tabs = {
      ...appointment.readonly_tabs,
      diaries: [{ id: 'diary-1', note: `${patient.full_name}: прием запланирован, форма ожидает заполнения.` }]
    };
    addAudit(createAuditEntry({
      actorType: 'user',
      actionType: 'assign_patient_to_slot',
      screenId: 'schedule',
      entityRefs: { slot_id: slot.slot_id, appointment_id: appointment.appointment_id, patient_id: patient.patient_id },
      payload: body,
      result: 'assigned'
    }));
    await persistRuntime();
    return sendJson(res, 200, { appointment, patient });
  }

  if (req.method === 'POST' && /^\/api\/slots\//.test(url.pathname) && url.pathname.endsWith('/unassign')) {
    const slotId = url.pathname.split('/')[3];
    const targetDay = runtime.scheduleDays.find((day) => day.slots.some((slot) => slot.slot_id === slotId));
    const slot = targetDay?.slots.find((item) => item.slot_id === slotId);
    if (!slot) return notFound(res);
    slot.patient_id = null;
    slot.status = 'available';
    const appointment = runtime.appointments[slot.appointment_id];
    appointment.patient_id = null;
    appointment.status = 'available';
    appointment.executed_at = null;
    appointment.inspection_draft = {
      ...appointment.inspection_draft,
      complaints_text: '',
      anamnesis_text: '',
      objective_status_text: '',
      appointments_text: '',
      conclusion_text: '',
      medical_record_sections: appointment.inspection_draft.medical_record_sections.map((section) => ({
        ...section,
        text: '',
        options: (section.options || []).map((option) => ({ ...option, selected: false }))
      })),
      supplemental: {
        ...appointment.inspection_draft.supplemental,
        work_plan: '',
        planned_sessions: '',
        completed_sessions: '',
        dynamics: '',
        recommendations: ''
      }
    };
    appointment.draft_state = {
      appointment_id: appointment.appointment_id,
      draft_status: 'idle',
      transcript_chunks: [],
      fact_candidates: [],
      draft_patches: [],
      applied_patch_ids: [],
      updated_at: null,
      last_preview: null
    };
    addAudit(createAuditEntry({
      actorType: 'user',
      actionType: 'unassign_patient_from_slot',
      screenId: 'schedule',
      entityRefs: { slot_id: slot.slot_id, appointment_id: appointment.appointment_id },
      payload: { slot_id: slot.slot_id },
      result: 'unassigned'
    }));
    await persistRuntime();
    return sendJson(res, 200, { appointment, slot });
  }

  if (req.method === 'POST' && url.pathname === '/api/speech/session/start') {
    const body = await readBody(req);
    const session = startSpeechSession(runtime, body.appointmentId, body.provider);
    addAudit(createAuditEntry({
      actorType: 'speech',
      actionType: 'start_speech_session',
      screenId: 'inspection',
      entityRefs: { appointment_id: body.appointmentId, session_id: session.session_id },
      payload: body,
      result: 'listening'
    }));
    await persistRuntime();
    return sendJson(res, 200, { session });
  }

  if (req.method === 'POST' && url.pathname === '/api/speech/elevenlabs/token') {
    const apiKey = getElevenLabsApiKey();
    if (!apiKey) {
      return sendJson(res, 400, {
        ok: false,
        provider: 'elevenlabs',
        error: 'ELEVENLABS_API_KEY is not configured on the local backend.'
      });
    }

    const tokenResponse = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey
      }
    });

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text();
      return sendJson(res, tokenResponse.status, {
        ok: false,
        provider: 'elevenlabs',
        error: 'Failed to create ElevenLabs realtime token.',
        details
      });
    }

    const payload = await tokenResponse.json();
    return sendJson(res, 200, {
      ok: true,
      provider: 'elevenlabs',
      model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v2_realtime',
      ...payload
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/speech/deepgram/config') {
    const config = getDeepgramRealtimeConfig();
    if (!config.apiKeyConfigured) {
      return sendJson(res, 400, {
        ok: false,
        provider: 'deepgram',
        error: 'DEEPGRAM_API_KEY is not configured on the local backend.'
      });
    }
    let permissionCheck = {
      checked: false,
      ok: true,
      status: null,
      reason: null
    };
    try {
      const grantResponse = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: {
          Authorization: `Token ${config.apiKey}`
        }
      });
      const details = await grantResponse.text();
      let parsed = null;
      try {
        parsed = JSON.parse(details);
      } catch {
        // Keep diagnostics structured without leaking response bodies into the extension UI.
      }
      permissionCheck = {
        checked: true,
        ok: grantResponse.ok,
        status: grantResponse.status,
        reason: parsed?.err_msg || parsed?.error || (grantResponse.ok ? null : 'Deepgram permission check failed.')
      };
    } catch (error) {
      permissionCheck = {
        checked: true,
        ok: false,
        status: null,
        reason: error.message || 'Deepgram permission check failed.'
      };
    }
    return sendJson(res, 200, {
      ok: true,
      realtimeUsable: permissionCheck.ok,
      permissionCheck,
      ...config
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/speech/openai/config') {
    const config = getOpenAiSttConfig();
    return sendJson(res, 200, {
      ok: true,
      provider: config.provider,
      apiKeyConfigured: config.apiKeyConfigured,
      model: config.model,
      preferred: config.preferred,
      language: config.language
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/speech/openai/transcribe') {
    const config = getOpenAiSttConfig();
    if (!config.apiKeyConfigured) {
      return sendJson(res, 400, {
        ok: false,
        provider: 'openai',
        error: 'OPENAI_API_KEY is not configured on the local backend.'
      });
    }
    const body = await readBody(req);
    try {
      const transcript = await transcribeOpenAiAudio({
        audioBase64: body.audioBase64,
        mimeType: body.mimeType || 'audio/webm',
        apiKey: process.env.OPENAI_API_KEY,
        model: config.model,
        endpoint: config.endpoint,
        language: body.language || config.language,
        prompt: body.prompt || config.prompt
      });
      addAudit(createAuditEntry({
        actorType: 'speech',
        actionType: 'openai_transcribe_audio',
        screenId: inferScreenId(body.screenContext || {}),
        entityRefs: { appointment_id: body.screenContext?.selected_appointment_id || null },
        payload: {
          provider: 'openai',
          model: config.model,
          mimeType: body.mimeType || 'audio/webm',
          audioBytes: body.audioBase64 ? Buffer.byteLength(body.audioBase64, 'base64') : 0
        },
        result: transcript.text ? 'transcribed' : 'empty'
      }));
      await persistRuntime();
      return sendJson(res, 200, {
        ok: true,
        provider: 'openai',
        model: config.model,
        text: transcript.text,
        raw: transcript.raw
      });
    } catch (error) {
      return sendJson(res, 502, {
        ok: false,
        provider: 'openai',
        model: config.model,
        error: error.message || 'OpenAI transcription failed.'
      });
    }
  }

  if (req.method === 'POST' && /^\/api\/speech\/session\/[^/]+\/chunk$/.test(url.pathname)) {
    const sessionId = url.pathname.split('/')[4];
    const session = runtime.speechSessions[sessionId];
    if (!session) return notFound(res);
    const body = await readBody(req);
    const transcript = await ingestTranscript(runtime, {
      appointmentId: session.appointment_id,
      sessionId,
      text: body.text,
      speakerTag: body.speakerTag
    });
    addAudit(createAuditEntry({
      actorType: 'speech',
      actionType: 'speech_chunk',
      screenId: 'inspection',
      entityRefs: { appointment_id: session.appointment_id, session_id: sessionId },
      payload: body,
      result: transcript.factCandidates.length ? 'draft_updated' : 'logged_only'
    }));
    await persistRuntime();
    return sendJson(res, 200, transcript);
  }

  if (req.method === 'POST' && /^\/api\/speech\/session\/[^/]+\/stop$/.test(url.pathname)) {
    const sessionId = url.pathname.split('/')[4];
    const session = stopSpeechSession(runtime, sessionId);
    addAudit(createAuditEntry({
      actorType: 'speech',
      actionType: 'stop_speech_session',
      screenId: 'inspection',
      entityRefs: { appointment_id: session.appointment_id, session_id: sessionId },
      payload: {},
      result: session.status
    }));
    await persistRuntime();
    return sendJson(res, 200, { session, draftState: runtime.appointments[session.appointment_id].draft_state });
  }

  if (req.method === 'POST' && /^\/api\/appointments\//.test(url.pathname) && url.pathname.endsWith('/save')) {
    const appointmentId = url.pathname.split('/')[3];
    const body = await readBody(req);
    const appointmentBeforeSave = getAppointmentById(runtime, appointmentId);
    const wasPrimaryVisit = appointmentBeforeSave && appointmentBeforeSave.status === 'scheduled';
    const updated = applyInspectionSave(runtime, appointmentId, body);
    addAudit(createAuditEntry({
      actorType: 'ui',
      actionType: 'save_record',
      screenId: 'inspection',
      entityRefs: { appointment_id: appointmentId, patient_id: updated.patient_id },
      payload: body,
      result: 'completed'
    }));

    // Module 3: Smart Scheduling — auto-generate 9-working-day schedule after primary visit
    let carePlanResult = null;
    if (wasPrimaryVisit && updated.patient_id) {
      try {
        carePlanResult = suggestCarePlan(runtime, {
          patientId: updated.patient_id,
          appointmentId,
          planningWindowDays: body.planningWindowDays || 9
        });
        addAudit(createAuditEntry({
          actorType: 'ai',
          actionType: 'draft_care_plan_after_primary_visit',
          screenId: 'inspection',
          entityRefs: { appointment_id: appointmentId, patient_id: updated.patient_id },
          payload: {
            planningWindowDays: carePlanResult.planning_window_days,
            trigger: 'primary_visit_save'
          },
          result: `draft:${carePlanResult.items.length}`
        }));
      } catch (carePlanError) {
        carePlanResult = { error: carePlanError.message || 'Care plan generation failed' };
      }
    }

    await persistRuntime();
    return sendJson(res, 200, {
      appointment: updated,
      patient: getPatientById(runtime, updated.patient_id),
      carePlan: carePlanResult,
      scheduleWindow: carePlanResult && !carePlanResult.error
        ? serializeScheduleWindow(runtime.currentDate)
        : undefined
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/hints') {
    const screenId = url.searchParams.get('screenId') || 'schedule';
    const appointmentId = url.searchParams.get('appointmentId');
    return sendJson(res, 200, {
      hints: buildHints(runtime, { screen_id: screenId, selected_appointment_id: appointmentId })
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/preview') {
    const body = await readBody(req);
    const preview = previewCommand({
      command: body.command,
      runtime,
      screenContext: body.screenContext || {}
    });
    addAudit(createAuditEntry({
      actorType: 'agent',
      actionType: 'preview_command',
      screenId: inferScreenId(body.screenContext || {}),
      entityRefs: { appointment_id: body.screenContext?.selected_appointment_id || null },
      payload: { command: body.command, screenContext: body.screenContext },
      result: preview.intent.type
    }));
    await persistRuntime();
    return sendJson(res, 200, preview);
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/observe') {
    const body = await readBody(req);
    const observation = await observeAgent(runtime, {
      screenContext: body.screenContext || {},
      transcriptDelta: body.transcriptDelta || '',
      command: body.command || ''
    });
    addAudit(createAuditEntry({
      actorType: 'agent',
      actionType: 'observe',
      screenId: inferScreenId(body.screenContext || {}),
      entityRefs: {
        appointment_id: body.screenContext?.selected_appointment_id || null,
        patient_id: body.screenContext?.selected_patient_id || null
      },
      payload: { command: body.command, transcriptDelta: body.transcriptDelta, screenContext: body.screenContext },
      result: observation.intents?.[0]?.type || 'observed'
    }));
    await persistRuntime();
    return sendJson(res, 200, observation);
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/execute-intent-preview') {
    const body = await readBody(req);
    const preview = executeIntentPreview(runtime, {
      intent: body.intent,
      command: body.command,
      screenContext: body.screenContext || {}
    });
    addAudit(createAuditEntry({
      actorType: 'agent',
      actionType: 'execute_intent_preview',
      screenId: inferScreenId(body.screenContext || {}),
      entityRefs: { appointment_id: body.screenContext?.selected_appointment_id || null },
      payload: body,
      result: preview.intent?.type || 'preview_ready'
    }));
    await persistRuntime();
    return sendJson(res, 200, preview);
  }

  if (req.method === 'POST' && url.pathname === '/api/advisor/analyze') {
    const body = await readBody(req);
    let advisor;
    try {
      advisor = await analyzeAdvisor(runtime, {
        appointmentId: body.appointmentId,
        question: body.question,
        screenContext: body.screenContext || {}
      });
    } catch (error) {
      if (error instanceof AdvisorContextError) {
        return sendJson(res, 200, {
          ok: false,
          error: error.code,
          message: error.message,
          advisor_context: {
            screen_scope: 'unsupported',
            patient_id: body.screenContext?.selected_patient_id || null,
            appointment_id: body.appointmentId || body.screenContext?.selected_appointment_id || null,
            can_patch_draft: false
          }
        });
      }
      throw error;
    }
    addAudit(createAuditEntry({
      actorType: 'advisor',
      actionType: 'advisor_analyze',
      screenId: inferScreenId(body.screenContext || {}),
      entityRefs: {
        appointment_id: body.appointmentId || body.screenContext?.selected_appointment_id || null,
        patient_id: body.screenContext?.selected_patient_id || null
      },
      payload: { question: body.question || '' },
      result: advisor.provider?.type || 'unknown'
    }));
    await persistRuntime();
    const preview = advisor.advisor_context?.appointment_id
      ? buildApplyPreview(runtime, advisor.advisor_context.appointment_id)
      : null;
    return sendJson(res, 200, { ok: true, ...advisor, preview });
  }

  if (req.method === 'POST' && url.pathname === '/api/transcripts/ingest') {
    const body = await readBody(req);
    const transcript = await ingestTranscript(runtime, {
      appointmentId: body.appointmentId,
      sessionId: body.sessionId,
      text: body.text,
      speakerTag: body.speakerTag
    });
    addAudit(createAuditEntry({
      actorType: 'speech',
      actionType: 'ingest_transcript_chunk',
      screenId: 'inspection',
      entityRefs: { appointment_id: body.appointmentId },
      payload: body,
      result: transcript.factCandidates.length ? 'draft_candidates_created' : 'transcript_logged'
    }));
    await persistRuntime();
    return sendJson(res, 200, transcript);
  }

  if (req.method === 'GET' && /^\/api\/drafts\//.test(url.pathname)) {
    const appointmentId = url.pathname.split('/')[3];
    if (!appointmentId || !getAppointmentById(runtime, appointmentId)) {
      return sendJson(res, 404, { ok: false, error: 'Appointment not found for draft state.' });
    }
    const draftState = getDraftState(runtime, appointmentId);
    return sendJson(res, 200, {
      draftState,
      preview: buildApplyPreview(runtime, appointmentId),
      hints: buildHints(runtime, { screen_id: 'inspection', selected_appointment_id: appointmentId })
    });
  }

  if (req.method === 'POST' && /^\/api\/drafts\/[^/]+\/apply-preview$/.test(url.pathname)) {
    const appointmentId = url.pathname.split('/')[3];
    if (!appointmentId || !getAppointmentById(runtime, appointmentId)) {
      return sendJson(res, 404, { ok: false, error: 'Appointment not found for apply preview.' });
    }
    const preview = buildApplyPreview(runtime, appointmentId);
    addAudit(createAuditEntry({
      actorType: 'agent',
      actionType: 'build_apply_preview',
      screenId: 'inspection',
      entityRefs: { appointment_id: appointmentId },
      payload: { patch_count: preview.patches.length },
      result: 'preview_ready'
    }));
    await persistRuntime();
    return sendJson(res, 200, { preview, draftState: runtime.appointments[appointmentId].draft_state });
  }

  if (req.method === 'POST' && /^\/api\/drafts\/[^/]+\/mark-applied$/.test(url.pathname)) {
    const appointmentId = url.pathname.split('/')[3];
    if (!appointmentId || !getAppointmentById(runtime, appointmentId)) {
      return sendJson(res, 404, { ok: false, error: 'Appointment not found for mark-applied.' });
    }
    const body = await readBody(req);
    const draftState = markPreviewApplied(runtime, appointmentId, body.patchIds || []);
    await persistRuntime();
    return sendJson(res, 200, { draftState });
  }

  if (req.method === 'POST' && url.pathname === '/api/procedure-schedule/preview') {
    const body = await readBody(req);
    const draft = buildProcedureSchedulePreview(runtime, { appointmentId: body.appointmentId });
    addAudit(createAuditEntry({
      actorType: 'agent',
      actionType: 'procedure_schedule_preview',
      screenId: 'inspection',
      entityRefs: { appointment_id: body.appointmentId, patient_id: draft.patient_id },
      payload: { day_count: draft.days.length },
      result: 'suggested'
    }));
    await persistRuntime();
    return sendJson(res, 200, { draft });
  }

  if (req.method === 'POST' && url.pathname === '/api/procedure-schedule/accept') {
    const body = await readBody(req);
    const draft = acceptProcedureSchedule(runtime, body.draftId);
    addAudit(createAuditEntry({
      actorType: 'extension',
      actionType: 'procedure_schedule_accept',
      screenId: 'inspection',
      entityRefs: { appointment_id: draft.appointment_id, patient_id: draft.patient_id },
      payload: { draft_id: draft.draft_id },
      result: 'accepted'
    }));
    await persistRuntime();
    return sendJson(res, 200, { draft });
  }

  if (req.method === 'POST' && url.pathname === '/api/audit') {
    const body = await readBody(req);
    addAudit(createAuditEntry({
      actorType: body.actorType || 'extension',
      actionType: body.actionType || 'unknown',
      screenId: body.screenId || 'unknown',
      entityRefs: body.entityRefs || {},
      payload: body.payload || body,
      result: body.result || 'logged'
    }));
    await persistRuntime();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    return sendJson(res, 200, { auditEntries: runtime.auditEntries });
  }

  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    if (url.pathname.startsWith('/extension/')) {
      return serveStatic(res, EXTENSION_DIR, url.pathname.replace('/extension', '') || '/sidepanel.html');
    }

    if (url.pathname === '/' || url.pathname.startsWith('/app') || url.pathname === '/index.html') {
      return serveStatic(res, APP_DIR, url.pathname === '/' ? '/index.html' : url.pathname.replace('/app', '') || '/index.html');
    }

    return serveStatic(res, APP_DIR, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Internal server error', details: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Damumed sandbox server running at http://localhost:${PORT}`);
  console.log(`Extension files served at http://localhost:${PORT}/extension/sidepanel.html`);
});
