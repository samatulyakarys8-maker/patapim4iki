import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifacts, buildReadonlyTabs, seedRuntimeState, writeArtifacts } from './lib/dataset.mjs';
import {
  applyInspectionSave,
  acceptProcedureSchedule,
  buildApplyPreview,
  buildProcedureSchedulePreview,
  buildHints,
  commitConfirmedInspectionSave,
  createSaveConfirmation,
  createAuditEntry,
  executeIntentPreview,
  getAppointmentById,
  getDeepgramRealtimeConfig,
  getDraftState,
  getPatientById,
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
import { buildPsychologistsFromRuntime, generatePsychologistSchedule } from './lib/scheduler.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3030);
const APP_DIR = path.join(__dirname, 'app');
const EXTENSION_DIR = path.join(__dirname, 'extension');
const GENERATED_DIR = path.join(__dirname, 'data/generated');
const RUNTIME_PATH = path.join(__dirname, 'data/runtime/state.json');

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
const runtime = seedRuntimeState(artifacts);
await fsp.writeFile(path.join(GENERATED_DIR, 'voice_lexicon.json'), JSON.stringify(runtime.voiceLexicon, null, 2), 'utf8');
await persistRuntime();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, payload, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
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

async function persistRuntime() {
  await fsp.mkdir(path.dirname(RUNTIME_PATH), { recursive: true });
  await fsp.writeFile(RUNTIME_PATH, JSON.stringify(runtime, null, 2), 'utf8');
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
    full_name: patient.full_name,
    birth_date: patient.birth_date || '',
    iin_or_local_id: patient.iin_or_local_id || '',
    sex: patient.sex || '',
    specialty_track: patient.specialty_track || 'psychology-rehabilitation'
  }));
}

function getSchedulerPatientById(runtime, patientId) {
  return getSchedulerPatients(runtime).find((patient) => patient.patient_id === patientId) || null;
}

function getAttachedPatientsByProvider(runtime, providerId) {
  const provider = Array.isArray(runtime?.providers)
    ? runtime.providers.find((item) => item.provider_id === providerId)
    : null;
  const attachedIds = new Set(Array.isArray(provider?.attached_patient_ids) ? provider.attached_patient_ids : []);
  if (!attachedIds.size) {
    return Array.isArray(runtime?.patients) ? runtime.patients : [];
  }
  return (Array.isArray(runtime?.patients) ? runtime.patients : []).filter((patient) => attachedIds.has(patient.patient_id));
}

function resetAppointmentMedicalState(appointment, patient) {
  appointment.patient_id = patient.patient_id;
  appointment.status = 'scheduled';
  appointment.executed_at = null;
  appointment.inspection_draft = {
    ...appointment.inspection_draft,
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
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(res, 200, {
      app: {
        name: 'Damumed Sandbox',
        phase: 'phase-1-vertical-slice',
        server_time: new Date().toISOString()
      },
      currentDate: runtime.currentDate,
      providers: runtime.providers,
      patients: getSchedulerPatients(runtime),
      scheduleDay: serializeScheduleDay(getCurrentDay(runtime.currentDate)),
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
    runtime.currentDate = date;
    return sendJson(res, 200, serializeScheduleDay(getCurrentDay(date), statusFilter));
  }

  if (req.method === 'POST' && url.pathname === '/api/current-date') {
    const body = await readBody(req);
    runtime.currentDate = body.date || runtime.currentDate;
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
      ? sourcePatients.filter((patient) => String(patient.full_name || '').toLowerCase().includes(normalized) || String(patient.iin_or_local_id || '').includes(normalized))
      : sourcePatients;
    return sendJson(res, 200, { patients });
  }

  if (req.method === 'POST' && url.pathname === '/api/psychologist-schedule/generate') {
    const body = await readBody(req);
    const patient = getPatientById(runtime, body.patientId) || getSchedulerPatientById(runtime, body.patientId);
    const sessionCount = Number(body.sessionCount || 9);

    if (!patient) {
      return sendJson(res, 404, { error: 'Patient not found.' });
    }

    if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 9) {
      return sendJson(res, 400, { error: 'sessionCount must be an integer from 1 to 9.' });
    }

    if (body.durationMin != null && Number(body.durationMin) !== 30) {
      return sendJson(res, 400, { error: 'Psychologist sessions currently support fixed 30-minute slots only.' });
    }

    return sendJson(res, 200, generatePsychologistSchedule({
      patient,
      psychologists: buildPsychologistsFromRuntime(runtime),
      startDate: body.startDate || runtime.currentDate,
      sessionCount
    }));
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

  if (req.method === 'POST' && url.pathname === '/api/save/preview') {
    const body = await readBody(req);
    const confirmation = createSaveConfirmation(runtime, {
      appointmentId: body.appointmentId,
      actionTarget: body.actionTarget,
      inspectionPayload: body.inspectionPayload,
      screenSnapshotHash: body.screenSnapshotHash,
      actionSource: body.actionSource || 'extension'
    });
    addAudit(createAuditEntry({
      actorType: body.actionSource || 'extension',
      actionType: 'save_preview_created',
      screenId: 'inspection',
      entityRefs: { appointment_id: body.appointmentId, patient_id: confirmation.patient_id },
      payload: {
        action_target: confirmation.action_type,
        confirmation_id: confirmation.confirmation_id
      },
      result: confirmation.status
    }));
    await persistRuntime();
    return sendJson(res, 200, {
      confirmation,
      savePreview: confirmation.preview_summary
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/save/confirm') {
    const body = await readBody(req);
    const result = commitConfirmedInspectionSave(runtime, {
      appointmentId: body.appointmentId,
      confirmationId: body.confirmationId,
      inspectionPayload: body.inspectionPayload,
      screenSnapshotHash: body.screenSnapshotHash
    });
    addAudit(createAuditEntry({
      actorType: body.actionSource || 'extension',
      actionType: 'save_confirmed_and_committed',
      screenId: 'inspection',
      entityRefs: { appointment_id: body.appointmentId, patient_id: result.confirmation.patient_id },
      payload: {
        confirmation_id: body.confirmationId,
        action_target: result.confirmation.action_type
      },
      result: 'confirmed'
    }));
    await persistRuntime();
    return sendJson(res, 200, {
      appointment: result.appointment,
      patient: getPatientById(runtime, result.appointment.patient_id),
      confirmation: result.confirmation
    });
  }

  if (req.method === 'POST' && /^\/api\/appointments\//.test(url.pathname) && url.pathname.endsWith('/save')) {
    const appointmentId = url.pathname.split('/')[3];
    const body = await readBody(req);
    const updated = applyInspectionSave(runtime, appointmentId, body);
    addAudit(createAuditEntry({
      actorType: 'ui',
      actionType: 'save_record',
      screenId: 'inspection',
      entityRefs: { appointment_id: appointmentId, patient_id: updated.patient_id },
      payload: body,
      result: 'completed'
    }));
    await persistRuntime();
    return sendJson(res, 200, { appointment: updated, patient: getPatientById(runtime, updated.patient_id) });
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
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
