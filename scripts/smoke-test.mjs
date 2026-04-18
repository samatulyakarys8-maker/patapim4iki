import assert from 'node:assert/strict';
import { buildArtifacts, seedRuntimeState } from '../lib/dataset.mjs';
import {
  buildProcedureSchedulePreview,
  getDeepgramRealtimeConfig,
  inferPatapimSpeakerRole,
  previewCommand
} from '../lib/agent.mjs';
import {
  agentGreeting,
  shouldCreateBackendSpeechSession,
  transcriptRouteForScreen
} from '../lib/voice-mode.mjs';
import {
  extractPatientQuery,
  parseVoiceCommand,
  resolvePatientQuery
} from '../lib/command-router.mjs';

const artifacts = buildArtifacts();
const runtime = seedRuntimeState(artifacts);

assert.ok(artifacts.screen_inventory.some((screen) => screen.screen_id === 'schedule'));
assert.ok(artifacts.screen_inventory.some((screen) => screen.screen_id === 'inspection'));
assert.ok(artifacts.field_map.some((field) => field.dom_id === 'tbMedicalFinal'));
assert.ok(artifacts.locator_registry.some((locator) => locator.preferred_selector === '#frmInspectionResult'));
assert.ok(artifacts.navigation_targets.some((target) => target.target_key === 'discharge_summary'));
assert.ok(artifacts.process_steps.some((step) => step.step_key === 'inspection_fill'));
assert.equal(runtime.scheduleDays.length, 9);
assert.ok(Object.values(runtime.appointments).some((appointment) => appointment.status === 'completed'));

const firstSlot = runtime.scheduleDays[0].slots[1];
const openPreview = previewCommand({
  command: 'Открой первичный прием',
  runtime,
  screenContext: { screen_id: 'schedule', visible_actions: [] }
});
assert.equal(openPreview.intent.type, 'open_primary_visit');
assert.ok(openPreview.domOperations.some((operation) => operation.type === 'navigate-hash' && operation.hash.includes(firstSlot.appointment_id)));

const scheduleEpicrisisPreview = previewCommand({
  command: 'Открой эпикриз',
  runtime,
  screenContext: { screen_id: 'schedule', visible_actions: [] }
});
assert.equal(scheduleEpicrisisPreview.intent.type, 'open_discharge_summary');
assert.ok(scheduleEpicrisisPreview.domOperations.some((operation) => operation.type === 'open-appointment-tab'));

const tabPreview = previewCommand({
  command: 'Перейди к выписному эпикризу',
  runtime,
  screenContext: {
    screen_id: 'inspection',
    selected_appointment_id: firstSlot.appointment_id,
    visible_tabs: [
      { label: 'Выписной эпикриз', selector: '[data-action="switch-tab"][data-tab="dischargeSummary"]' }
    ]
  }
});
assert.equal(tabPreview.intent.type, 'open_discharge_summary');
assert.equal(tabPreview.domOperations[0].type, 'switch-tab');
assert.equal(tabPreview.commandResult.intent, 'open_tab');
assert.equal(tabPreview.commandResult.actionTarget, 'discharge-summary');
assert.equal(tabPreview.actionPlan.actionTarget, 'discharge-summary');

const deterministicTabPreview = previewCommand({
  command: 'Открой вкладку медицинские записи',
  runtime,
  screenContext: {
    screen_id: 'inspection',
    selected_appointment_id: firstSlot.appointment_id,
    visible_tabs: [
      { label: 'Медицинские записи', selector: '[data-action="switch-tab"][data-tab="medicalRecords"]' }
    ]
  }
});
assert.equal(deterministicTabPreview.commandResult.intent, 'open_tab');
assert.equal(deterministicTabPreview.commandResult.actionTarget, 'medical-records');
assert.equal(deterministicTabPreview.actionPlan.intent, 'open_tab');

const patientPreview = previewCommand({
  command: 'Открой пациента Темірбай',
  runtime,
  screenContext: { screen_id: 'schedule', visible_actions: [] }
});
assert.equal(patientPreview.commandResult.intent, 'open_patient');
assert.equal(patientPreview.commandResult.matchedPatient.patient_id, 'patient-3');
assert.equal(patientPreview.actionPlan.intent, 'open_patient');

const procedureDraft = buildProcedureSchedulePreview(runtime, { appointmentId: firstSlot.appointment_id });
assert.equal(procedureDraft.days.length, 9);
assert.equal(procedureDraft.status, 'suggested');

const applyDraftPreview = previewCommand({
  command: 'примени черновик',
  runtime,
  screenContext: {
    screen_id: 'inspection',
    selected_appointment_id: firstSlot.appointment_id
  }
});
assert.equal(applyDraftPreview.intent.type, 'apply_current_draft');

const deepgramConfig = getDeepgramRealtimeConfig('demo-key');
assert.equal(deepgramConfig.provider, 'deepgram');
assert.ok(deepgramConfig.url.includes('wss://api.deepgram.com/v1/listen'));
assert.ok(deepgramConfig.url.includes('language=multi'));
assert.ok(deepgramConfig.keyterms.includes('выписной эпикриз'));

assert.equal(inferPatapimSpeakerRole({ speakerId: '0', text: 'режим доктора Патапима' }), 'doctor');
assert.equal(inferPatapimSpeakerRole({ speakerId: '1', text: 'я пациент, у меня болит голова' }), 'patient');
assert.equal(inferPatapimSpeakerRole({ speakerId: '0', text: 'сохрани и закрой', currentMap: { 0: 'doctor' } }), 'doctor');
assert.equal(shouldCreateBackendSpeechSession('schedule'), false);
assert.equal(shouldCreateBackendSpeechSession('inspection'), true);
assert.equal(transcriptRouteForScreen('schedule'), 'observe');
assert.equal(transcriptRouteForScreen('inspection'), 'ingest');
assert.equal(agentGreeting(), 'На связи Патапим. Чем вам помочь?');

assert.deepEqual(
  {
    intent: parseVoiceCommand('открой вкладку медицинские записи').intent,
    actionTarget: parseVoiceCommand('открой вкладку медицинские записи').actionTarget
  },
  { intent: 'open_tab', actionTarget: 'medical-records' }
);
assert.equal(parseVoiceCommand('перейди в назначения').actionTarget, 'assignments');
assert.equal(parseVoiceCommand('открой дневниковые записи').actionTarget, 'diaries');
assert.equal(parseVoiceCommand('открой диагнозы').actionTarget, 'diagnoses');
assert.equal(parseVoiceCommand('мед записи открой').actionTarget, 'medical-records');
assert.equal(parseVoiceCommand('открой дневник').actionTarget, 'diaries');
assert.equal(parseVoiceCommand('открой выписку').actionTarget, 'discharge-summary');
assert.equal(parseVoiceCommand('сохрани и закрой').actionTarget, 'save-and-close');
assert.equal(parseVoiceCommand('сохрани запись').intent, 'save_record');
assert.equal(parseVoiceCommand('сформируй расписание').intent, 'generate_schedule');
assert.equal(parseVoiceCommand('отметь процедуру выполненной').intent, 'complete_service');
assert.equal(extractPatientQuery('открой пациента Темірбай'), 'темірбай');
assert.equal(extractPatientQuery('найди карточку Рахметолла'), 'рахметолла');
const patientMatch = resolvePatientQuery('темирбай нуржан', runtime.patients);
assert.equal(patientMatch.status, 'matched');
assert.equal(patientMatch.matchedPatient.patient_id, 'patient-3');
assert.ok(patientMatch.candidates[0].score >= 0.72);
assert.equal(resolvePatientQuery('nurzhan', runtime.patients).matchedPatient.patient_id, 'patient-3');
assert.equal(resolvePatientQuery('рахметула айкуным', runtime.patients).matchedPatient.patient_id, 'patient-1');
assert.equal(resolvePatientQuery('анкар', runtime.patients).matchedPatient.patient_id, 'patient-5');
assert.equal(resolvePatientQuery('нур', runtime.patients).status, 'ambiguous');

console.log('Smoke test passed');
