import assert from 'node:assert/strict';
import { buildArtifacts, seedRuntimeState } from '../lib/dataset.mjs';
import {
  buildProcedureSchedulePreview,
  getDeepgramRealtimeConfig,
  inferPatapimSpeakerRole,
  previewCommand
} from '../lib/agent.mjs';
import {
  buildPsychologistsFromRuntime,
  getAvailablePsychologistSlots,
  generateNext9WorkingDays,
  generatePsychologistSchedule,
  isWorkingDay,
  overlaps
} from '../lib/scheduler.mjs';
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
assert.ok(runtime.patients.length >= 1);
assert.ok(runtime.patients.every((patient) => patient.patient_id && patient.full_name && patient.iin_or_local_id));
assert.ok(runtime.providers.every((provider) => Array.isArray(provider.attached_patient_ids)));
assert.equal(
  runtime.patients.some((patient) => runtime.providers.some((provider) => provider.full_name === patient.full_name)),
  false
);
assert.ok(runtime.patients.slice(1).every((patient) => patient.iin_or_local_id.startsWith('ARCH-')));
assert.ok(runtime.scheduleDays[0].slots.some((slot) => slot.status === 'available'));
assert.equal(
  runtime.scheduleDays[0].slots.filter((slot) => slot.patient_id).every((slot) => slot.patient_id === 'patient-1'),
  true
);

const workingDays = generateNext9WorkingDays('2026-04-17');
assert.equal(workingDays.length, 9);
assert.equal(workingDays[0], '2026-04-17');
assert.equal(workingDays[1], '2026-04-20');
assert.ok(workingDays.every((date) => isWorkingDay(date)));
assert.equal(isWorkingDay('2026-04-18'), false);
assert.equal(isWorkingDay('2026-04-20'), true);

assert.equal(
  overlaps(
    { date: '2026-04-20', start: '10:00', end: '10:30' },
    { date: '2026-04-20', start: '10:20', end: '10:50' }
  ),
  true
);
assert.equal(
  overlaps(
    { date: '2026-04-20', start: '10:00', end: '10:30' },
    { date: '2026-04-20', start: '10:30', end: '11:00' }
  ),
  false
);

const patient = runtime.patients[0];
const psychologists = buildPsychologistsFromRuntime(runtime);
assert.ok(psychologists.length >= 2);
const generated = generatePsychologistSchedule({
  patient,
  psychologists,
  startDate: '2026-04-17',
  sessionCount: 9
});

assert.equal(generated.patientId, patient.patient_id);
assert.equal(generated.days.length, 9);
assert.equal(generated.unassigned.length, 0);
assert.ok(generated.days.every((day) => isWorkingDay(day.date)));
assert.ok(generated.days.every((day) => day.appointments.length <= 1));
assert.deepEqual(
  generated.days.map((day) => day.date),
  workingDays
);

for (const day of generated.days) {
  for (const appointment of day.appointments) {
    assert.equal(appointment.type, 'psychologist');
    assert.equal(appointment.durationMin, 30);
    assert.notEqual(appointment.start, '13:00');
    assert.notEqual(appointment.end, '13:30');
    assert.ok(runtime.providers.some((provider) => provider.full_name === appointment.psychologistName));
    assert.equal(/^Dr\./.test(appointment.psychologistName), false);
  }
}

const psy1Slots = getAvailablePsychologistSlots(psychologists[0], '2026-04-17', 30, []);
assert.equal(psy1Slots.some((slot) => slot.start === '10:00'), false);
assert.equal(psy1Slots.some((slot) => slot.start === '10:30'), true);

const distributed = generatePsychologistSchedule({
  patient,
  psychologists,
  startDate: '2026-04-17',
  sessionCount: 5
});
assert.equal(distributed.days.length, 5);
assert.ok(distributed.days[0].date < distributed.days[distributed.days.length - 1].date);
assert.ok(distributed.days.some((day) => day.date >= '2026-04-24'));

assert.throws(
  () => generatePsychologistSchedule({
    patient,
    psychologists,
    startDate: '2026-04-17',
    sessionCount: 3,
    durationMin: 40
  }),
  /fixed 30-minute slots only/i
);

const blockedPsychologists = [1, 2, 3].map((index) => ({
  psychologist_id: `blocked-${index}`,
  full_name: `Blocked ${index}`,
  work_start: '09:00',
  work_end: '18:00',
  lunch_start: '13:00',
  lunch_end: '14:00',
  busy_slots: workingDays.flatMap((date) => [
    { date, start: '09:00', end: '13:00' },
    { date, start: '14:00', end: '18:00' }
  ])
}));

const unassigned = generatePsychologistSchedule({
  patient,
  psychologists: blockedPsychologists,
  startDate: '2026-04-17',
  sessionCount: 4
});
assert.equal(unassigned.days.length, 0);
assert.equal(unassigned.unassigned.length, 4);
assert.ok(unassigned.unassigned.every((item) => item.reason));

const firstSlot = runtime.scheduleDays[0].slots.find((slot) => slot.patient_id);
assert.ok(firstSlot);
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
assert.equal(patientPreview.commandResult.matchedPatient.patient_id, 'patient-history-4');
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
const patientMatch = resolvePatientQuery('темирбай айбат', runtime.patients);
assert.equal(patientMatch.status, 'matched');
assert.equal(patientMatch.matchedPatient.patient_id, 'patient-history-4');
assert.ok(patientMatch.candidates[0].score >= 0.72);
assert.equal(resolvePatientQuery('temirbay', runtime.patients).matchedPatient.patient_id, 'patient-history-4');
assert.equal(resolvePatientQuery('рахметула айкуным', runtime.patients).matchedPatient.patient_id, 'patient-1');
assert.equal(resolvePatientQuery('анкар', runtime.patients).matchedPatient.patient_id, 'patient-history-2');
assert.equal(resolvePatientQuery('пациента', runtime.patients).status, 'not_found');

console.log('Smoke test passed');
