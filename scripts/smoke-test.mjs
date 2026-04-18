import assert from 'node:assert/strict';
import { buildArtifacts, seedRuntimeState } from '../lib/dataset.mjs';
import { AdvisorContextError, analyzeAdvisor } from '../lib/advisor.mjs';
import { getOpenAiSttConfig, normalizeOpenAiAudioMimeType } from '../lib/openai-stt.mjs';
import { normalizeTranscript as normalizeCanonicalTranscript } from '../lib/transcript-normalizer.mjs';
import {
  buildProcedureSchedulePreview,
  getDeepgramRealtimeConfig,
  inferPatapimSpeakerRole,
  ingestTranscript,
  observeAgent,
  previewCommand
} from '../lib/agent.mjs';
import {
  buildPsychologistsFromRuntime,
  generateNext9CalendarDays,
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
  normalizeTranscript as normalizeCommandTranscript,
  parseVoiceCommand,
  resolvePatientQuery
} from '../lib/command-router.mjs';
import {
  BREAK_MODE_COMMANDS,
  BREAK_MODE_LAYOUT,
  BREAK_WIDGET_DEFAULTS,
  isBreakModeCommand,
  normalizeBreakModeCommand
} from '../extension/break-mode.js';

const artifacts = buildArtifacts();
const runtime = seedRuntimeState(artifacts);
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const normalizedSample = normalizeCanonicalTranscript('ну у ребенка эээ вечером болят ноги');
assert.equal(normalizedSample.raw_transcript, 'ну у ребенка эээ вечером болят ноги');
assert.equal(normalizedSample.normalized_transcript.includes('ну'), false);
assert.equal(normalizedSample.normalized_transcript.includes('эээ'), false);
assert.equal(normalizedSample.normalized_transcript.includes('вечером болят ноги'), true);
assert.ok(normalizedSample.removed_fillers.includes('ну'));
const canonicalVoice = normalizeCanonicalTranscript('otkroi nurzhan');
const commandVoice = normalizeCommandTranscript('otkroi nurzhan');
assert.equal(commandVoice.normalizedText, canonicalVoice.normalized_transcript);
assert.ok(commandVoice.tokens.includes('нуржан'));
assert.ok(commandVoice.normalizedText.includes('открой'));
const openAiSttConfig = getOpenAiSttConfig({
  OPENAI_API_KEY: 'test',
  OPENAI_TRANSCRIBE_MODEL: 'whisper-1',
  OPENAI_STT_PREFERRED: 'true'
});
assert.equal(openAiSttConfig.apiKeyConfigured, true);
assert.equal(openAiSttConfig.model, 'whisper-1');
assert.equal(openAiSttConfig.preferred, true);
assert.equal(normalizeOpenAiAudioMimeType('audio/webm;codecs=opus'), 'audio/webm');
assert.equal(normalizeOpenAiAudioMimeType('audio/ogg;codecs=opus'), 'audio/ogg');

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
assert.ok(runtime.patients.slice(1).every((patient) => /^\d+$/.test(patient.iin_or_local_id)));
assert.ok(runtime.scheduleDays[0].slots.some((slot) => slot.status === 'available'));
assert.ok(runtime.scheduleDays[0].slots.filter((slot) => slot.patient_id).length >= 1);
assert.equal(runtime.scheduleDays[0].slots.length, runtime.providers.length * 16);
assert.deepEqual(
  [...new Set(runtime.scheduleDays[0].slots.map((slot) => slot.provider_id))].sort(),
  runtime.providers.map((provider) => provider.provider_id).sort()
);

const advisorAppointmentId = Object.keys(runtime.appointments)[0];
const normalizedIngest = await ingestTranscript(runtime, {
  appointmentId: advisorAppointmentId,
  sessionId: 'test-normalization-session',
  text: 'ну у ребенка эээ вечером болят ноги',
  speakerTag: 'patient'
});
assert.equal(normalizedIngest.chunk.text, 'ну у ребенка эээ вечером болят ноги');
assert.equal(normalizedIngest.chunk.normalized_text.includes('эээ'), false);
assert.equal(normalizedIngest.chunk.normalized_text.includes('вечером болят ноги'), true);
assert.equal(
  normalizedIngest.draftPatches.some((patch) => ['tbmedicalfinal', 'recommendations', 'dynamics', 'work-plan'].includes(patch.field_key)),
  false
);

const advisor = await analyzeAdvisor(runtime, {
  appointmentId: advisorAppointmentId,
  question: 'Подскажи следующий шаг приема.',
  screenContext: { screen_id: 'inspection', selected_appointment_id: advisorAppointmentId }
});
assert.equal(advisor.provider.type, 'heuristic');
assert.ok(advisor.answer.next_step);
assert.ok(advisor.interview_reasoning);
assert.equal(advisor.interview_reasoning.stage, 'complaints');
assert.ok(Array.isArray(advisor.interview_reasoning.missing_fields));
assert.ok(advisor.interview_reasoning.next_best_question);
assert.ok(advisor.advisor_debug);
assert.equal(typeof advisor.advisor_debug.raw_deepgram_transcript, 'string');
assert.equal(typeof advisor.advisor_debug.normalized_transcript, 'string');
assert.equal(advisor.advisor_context.screen_scope, 'inspection');
assert.equal(advisor.advisor_context.can_patch_draft, true);
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.ui.visible, true);
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.ui.screen_scope, 'inspection');
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.ui.active_question, advisor.interview_reasoning.next_best_question);
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.ui.stage, advisor.interview_reasoning.stage);
assert.equal(Array.isArray(advisor.interview_reasoning.covered_fields), true);
assert.equal(typeof advisor.interview_reasoning.advisor_complete, 'boolean');
assert.equal(Array.isArray(advisor.interview_reasoning.patch_preview), true);
assert.ok(Array.isArray(advisor.answer.questions_to_ask));
assert.ok(advisor.answer.questions_to_ask.length > 0);
assert.ok(Array.isArray(advisor.answer.differential_hypotheses));
assert.ok(advisor.answer.differential_hypotheses.length > 0);
const advisorAnswerText = JSON.stringify(advisor).toLowerCase();
assert.equal(advisorAnswerText.includes('domoperations'), false);
assert.equal(advisorAnswerText.includes('selector'), false);

runtime.appointments[advisorAppointmentId].draft_state.advisor_state = null;
runtime.appointments[advisorAppointmentId].draft_state.transcript_chunks = [];

runtime.appointments[advisorAppointmentId].draft_state.transcript_chunks.push({
  chunk_id: 'test-advisor-complaint',
  session_id: 'test',
  start_ms: 0,
  end_ms: 1000,
  text: 'У ребенка вечером болят ноги и он быстро устает.',
  speaker_tag: 'patient',
  confidence: 0.92
});
const complaintAdvisor = await analyzeAdvisor(runtime, {
  appointmentId: advisorAppointmentId,
  question: 'Подскажи врачу следующий вопрос.',
  screenContext: { screen_id: 'inspection', selected_appointment_id: advisorAppointmentId }
});
assert.equal(complaintAdvisor.interview_reasoning.stage, 'complaints');
assert.ok(complaintAdvisor.interview_reasoning.new_facts.some((fact) => fact.field === 'main_complaint'));
assert.ok(complaintAdvisor.interview_reasoning.new_facts.some((fact) => fact.source === 'normalized_transcript'));
assert.equal(complaintAdvisor.advisor_debug.raw_deepgram_transcript.includes('болят ноги'), true);
assert.equal(complaintAdvisor.advisor_debug.normalized_transcript.includes('болят ноги'), true);
assert.equal(
  complaintAdvisor.interview_reasoning.normalized_field_values.tbmedicalfinal.includes('Жалобы на боли в нижних конечностях'),
  true
);
assert.equal(
  complaintAdvisor.interview_reasoning.next_best_question.toLowerCase().includes('что вас беспокоит'),
  false
);
assert.equal(
  /когда впервые появились|после ходьбы|в покое/i.test(complaintAdvisor.interview_reasoning.next_best_question),
  true
);
assert.equal(complaintAdvisor.interview_reasoning.follow_up_count, 1);
assert.deepEqual(complaintAdvisor.interview_reasoning.selected_gap_groups, ['timeline', 'load_vs_rest']);

runtime.appointments[advisorAppointmentId].draft_state.transcript_chunks.push({
  chunk_id: 'test-advisor-progress-1',
  session_id: 'test',
  start_ms: 0,
  end_ms: 1000,
  text: 'Началось две недели назад, после ходьбы усиливается.',
  speaker_tag: 'patient',
  confidence: 0.92
});
const progressedAdvisor = await analyzeAdvisor(runtime, {
  appointmentId: advisorAppointmentId,
  question: 'Подскажи врачу следующий вопрос.',
  screenContext: { screen_id: 'inspection', selected_appointment_id: advisorAppointmentId }
});
assert.notEqual(progressedAdvisor.interview_reasoning.next_best_question, complaintAdvisor.interview_reasoning.next_best_question);
assert.equal(progressedAdvisor.interview_reasoning.next_best_question.toLowerCase().includes('что вас беспокоит'), false);
assert.equal(
  /ночному сну|менее активным|в течение дня/i.test(progressedAdvisor.interview_reasoning.next_best_question),
  true
);
assert.equal(progressedAdvisor.interview_reasoning.follow_up_count, 2);
assert.equal(progressedAdvisor.interview_reasoning.demo_complete, false);

runtime.appointments[advisorAppointmentId].draft_state.transcript_chunks.push({
  chunk_id: 'test-advisor-progress-2',
  session_id: 'test',
  start_ms: 0,
  end_ms: 1000,
  text: 'Из-за боли просыпается ночью, быстро устает при ходьбе, днем стал менее активным. Состояние стало хуже, ранее проходил реабилитацию.',
  speaker_tag: 'patient',
  confidence: 0.92
});
const completedAdvisor = await analyzeAdvisor(runtime, {
  appointmentId: advisorAppointmentId,
  question: 'Подскажи врачу следующий вопрос.',
  screenContext: { screen_id: 'inspection', selected_appointment_id: advisorAppointmentId }
});
assert.equal(completedAdvisor.interview_reasoning.advisor_complete, true);
assert.equal(completedAdvisor.interview_reasoning.demo_complete, true);
assert.equal(completedAdvisor.interview_reasoning.next_best_question, '');
assert.equal(completedAdvisor.answer.questions_to_ask.length, 0);
assert.equal(completedAdvisor.interview_reasoning.patch_preview.length > 0, true);
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.ui.mode, 'completed');
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.ui.active_question, '');
assert.equal(runtime.appointments[advisorAppointmentId].draft_state.advisor_state.follow_up_count, 2);

const patientCardAdvisor = await analyzeAdvisor(runtime, {
  appointmentId: null,
  question: 'У ребенка вечером болят ноги.',
  screenContext: { screen_id: 'patient_card', selected_patient_id: runtime.patients[0].patient_id }
});
assert.equal(patientCardAdvisor.advisor_context.screen_scope, 'patient_card');
assert.equal(patientCardAdvisor.advisor_context.patient_id, runtime.patients[0].patient_id);
assert.equal(patientCardAdvisor.advisor_context.appointment_id, null);
assert.equal(patientCardAdvisor.advisor_context.can_patch_draft, false);
assert.ok(patientCardAdvisor.interview_reasoning.next_best_question);

const stalePatientIdAdvisor = await analyzeAdvisor(runtime, {
  appointmentId: null,
  question: 'У ребенка вечером болят ноги.',
  screenContext: {
    screen_id: 'patient_card',
    selected_patient_id: 'stale-dom-patient-id',
    selected_patient_name: runtime.patients[0].full_name
  }
});
assert.equal(stalePatientIdAdvisor.advisor_context.patient_id, runtime.patients[0].patient_id);

await assert.rejects(
  analyzeAdvisor(runtime, {
    appointmentId: null,
    question: 'У ребенка вечером болят ноги.',
    screenContext: { screen_id: 'patient_card', selected_patient_id: 'missing-patient' }
  }),
  (error) => error instanceof AdvisorContextError && error.code === 'advisor_context_missing'
);
if (originalOpenRouterKey) {
  process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
}

const workingDays = generateNext9WorkingDays('2026-04-17');
assert.equal(workingDays.length, 9);
assert.equal(workingDays[0], '2026-04-17');
assert.equal(workingDays[1], '2026-04-20');
assert.ok(workingDays.every((date) => isWorkingDay(date)));
const calendarDays = generateNext9CalendarDays('2026-04-18');
assert.equal(calendarDays.length, 9);
assert.equal(calendarDays[0], '2026-04-18');
assert.equal(calendarDays[8], '2026-04-26');
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
  startDate: '2026-04-18',
  sessionCount: 9
});

assert.equal(generated.patientId, patient.patient_id);
assert.equal(generated.days.length, 9);
assert.equal(generated.unassigned.length, 0);
assert.ok(generated.days.every((day) => day.appointments.length <= 1));
assert.ok(generated.days.every((day) => {
  const d = new Date(`${day.date}T00:00:00Z`);
  return d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
}));

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

const psy1Slots = getAvailablePsychologistSlots(psychologists[0], '2026-04-18', 30, []);
assert.equal(psy1Slots.some((slot) => slot.start === '10:00'), false);
assert.equal(psy1Slots.some((slot) => slot.start === '10:30'), true);

const distributed = generatePsychologistSchedule({
  patient,
  psychologists,
  startDate: '2026-04-18'
});
assert.equal(distributed.days.length, 9);
assert.ok(distributed.days[0].date < distributed.days[distributed.days.length - 1].date);
assert.ok(distributed.days.some((day) => day.date >= '2026-04-24'));

const duration40 = generatePsychologistSchedule({
  patient,
  psychologists,
  startDate: '2026-04-18',
  durationMin: 40
});
assert.equal(duration40.days.length, 9);
assert.ok(duration40.days.every((day) => day.appointments[0].durationMin === 40));

assert.throws(
  () => generatePsychologistSchedule({
    patient,
    psychologists,
    startDate: '2026-04-18',
    durationMin: 45
  }),
  /30 or 40/i
);

const blockedPsychologists = [1, 2, 3].map((index) => ({
  psychologist_id: `blocked-${index}`,
  full_name: `Blocked ${index}`,
  work_start: '09:00',
  work_end: '18:00',
  lunch_start: '13:00',
  lunch_end: '14:00',
  busy_slots: generateNext9WorkingDays('2026-04-18').flatMap((date) => [
    { date, start: '09:00', end: '13:00' },
    { date, start: '14:00', end: '18:00' }
  ])
}));

const unassigned = generatePsychologistSchedule({
  patient,
  psychologists: blockedPsychologists,
  startDate: '2026-04-18'
});
assert.equal(unassigned.days.length, 0);
assert.equal(unassigned.unassigned.length, 9);
assert.ok(unassigned.unassigned.every((item) => item.reason));

const firstSlot = runtime.scheduleDays[0].slots.find((slot) => slot.patient_id);
assert.ok(firstSlot);
const openPreview = previewCommand({
  command: 'Открой первичный прием',
  runtime,
  screenContext: { screen_id: 'schedule', visible_actions: [] }
});
assert.ok(['open_primary_visit', 'show_hint'].includes(openPreview.intent.type));
assert.ok(Array.isArray(openPreview.hints));

const scheduleEpicrisisPreview = previewCommand({
  command: 'Открой эпикриз',
  runtime,
  screenContext: { screen_id: 'schedule', visible_actions: [] }
});
assert.ok(['open_discharge_summary', 'show_hint'].includes(scheduleEpicrisisPreview.intent.type));

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
assert.ok(['open_discharge_summary', 'preview_changes'].includes(tabPreview.intent.type));

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
assert.equal(extractPatientQuery('открой пациента Темірбай'), 'темирбай');
assert.equal(extractPatientQuery('найди карточку Рахметолла'), 'рахметолла');
const patientMatch = resolvePatientQuery('темирбай айбат', runtime.patients);
assert.equal(patientMatch.status, 'matched');
assert.equal(patientMatch.matchedPatient.patient_id, 'patient-history-4');
assert.ok(patientMatch.candidates[0].score >= 0.72);
assert.equal(resolvePatientQuery('temirbay', runtime.patients).matchedPatient.patient_id, 'patient-history-4');
assert.equal(resolvePatientQuery('рахметула айкуным', runtime.patients).matchedPatient.patient_id, 'patient-1');
assert.equal(resolvePatientQuery('анкар', runtime.patients).matchedPatient.patient_id, 'patient-history-2');
assert.equal(resolvePatientQuery('рахметолла', runtime.patients).matchedPatient.full_name, 'РАХМЕТОЛЛА АЙКҮНІМ ХАБИДОЛЛАҚЫЗЫ');
assert.equal(resolvePatientQuery('пациента', runtime.patients).status, 'not_found');
assert.equal(parseVoiceCommand('otkroi nurzhan').intent, 'open_patient');
assert.equal(parseVoiceCommand('otkroi nurzhan').patientQuery, 'нуржан');

const contextualPatients = [
  { patient_id: 'ctx-1', full_name: 'Нуржан Алиев', iin_or_local_id: 'ctx-1' },
  { patient_id: 'ctx-2', full_name: 'Нурлан Алиев', iin_or_local_id: 'ctx-2' }
];
const contextualResolution = resolvePatientQuery('nurzhan', contextualPatients, {
  screenContext: {
    visible_slot_cards: [{ patient_id: 'ctx-1' }],
    selected_patient_id: 'ctx-1'
  },
  runtime: { currentDate: '2026-04-18', scheduleDays: [{ date: '2026-04-18', slots: [{ patient_id: 'ctx-1' }] }] }
});
assert.equal(contextualResolution.candidates[0].patient.patient_id, 'ctx-1');
assert.ok(contextualResolution.candidates[0].reasons.some((reason) => reason.startsWith('visible:+')));

const observeTab = await observeAgent(runtime, {
  command: 'открой вкладку медицинские записи',
  transcriptDelta: 'открой вкладку медицинские записи',
  screenContext: {
    screen_id: 'inspection',
    selected_appointment_id: firstSlot.appointment_id,
    visible_tabs: [
      { label: 'Медицинские записи', selector: '[data-action="switch-tab"][data-tab="medicalRecords"]' }
    ]
  }
});
assert.equal(observeTab.deterministicCommandResult.intent, 'open_tab');
assert.equal(observeTab.commandResult.debug.llmFallbackInvoked, false);
assert.equal(observeTab.commandResult.debug.provider, 'deterministic_command_router');

const observeMedicalSpeech = await observeAgent(runtime, {
  command: 'у ребенка вечером болят ноги',
  transcriptDelta: 'у ребенка вечером болят ноги',
  screenContext: {
    screen_id: 'inspection',
    selected_appointment_id: firstSlot.appointment_id
  }
});
assert.equal(observeMedicalSpeech.commandResult, null);

assert.ok(Array.isArray(BREAK_MODE_COMMANDS));
assert.equal(BREAK_MODE_COMMANDS.includes('play game'), true);
assert.equal(BREAK_MODE_COMMANDS.includes('break mode'), true);
assert.equal(isBreakModeCommand('play game'), true);
assert.equal(isBreakModeCommand('Break Mode'), true);
assert.equal(isBreakModeCommand('open patient'), false);
assert.equal(normalizeBreakModeCommand('  Break Mode  '), 'break mode');
assert.equal(BREAK_MODE_LAYOUT, 'overlay');
assert.equal(BREAK_WIDGET_DEFAULTS.minHeight, 420);
assert.equal(BREAK_WIDGET_DEFAULTS.pipeGap, 96);
assert.equal(BREAK_WIDGET_DEFAULTS.spawnEveryFrames, 126);

console.log('Smoke test passed');
