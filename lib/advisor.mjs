import { getAppointmentById, getPatientById } from './agent.mjs';
import { normalizeTranscript } from './transcript-normalizer.mjs';

const DEFAULT_NOTE = 'Это клиническая подсказка для врача. Финальное решение, диагноз и назначения принимает специалист.';

const STAGES = {
  complaints: {
    label: 'Жалобы',
    next: 'anamnesis',
    required: ['main_complaint', 'duration', 'trigger_or_time_pattern', 'severity_or_impact'],
    questions: {
      main_complaint: 'Что сейчас беспокоит пациента больше всего?',
      duration: 'Когда это началось?',
      trigger_or_time_pattern: 'Когда это чаще появляется: после нагрузки, вечером или даже в покое?',
      severity_or_impact: 'Насколько это мешает ходьбе или обычной активности?'
    }
  },
  anamnesis: {
    label: 'Анамнез / динамика',
    next: 'functional_impact',
    required: ['onset', 'course_or_stability', 'progression', 'relevant_background_facts'],
    questions: {
      onset: 'С чего началось ухудшение?',
      course_or_stability: 'Состояние ухудшается, улучшается или остается стабильным?',
      progression: 'За последнее время симптомы стали чаще, сильнее или остались такими же?',
      relevant_background_facts: 'Какие важные особенности развития, лечения или перенесенные события нужно учесть?'
    }
  },
  functional_impact: {
    label: 'Функциональное влияние',
    next: null,
    required: ['walking_or_movement_impact', 'sleep_impact', 'daily_activity_or_behavior_impact'],
    questions: {
      walking_or_movement_impact: 'Как это влияет на ходьбу или движение?',
      sleep_impact: 'Мешает ли это сну?',
      daily_activity_or_behavior_impact: 'Как это влияет на обычную активность, поведение или занятия в течение дня?'
    }
  }
};

const COMPLETED_STAGE = 'completed';
const NORMALIZED_PATCH_FIELDS = ['tbmedicalfinal', 'dynamics', 'work-plan', 'recommendations'];
const DEMO_FOLLOW_UP_POLICY = {
  target: 2,
  max: 3
};
const QUESTION_SIGNATURES = {
  main_complaint: 'ask_main_complaint',
  duration: 'ask_duration',
  trigger_or_time_pattern: 'ask_relation_to_load',
  severity_or_impact: 'ask_severity_or_impact',
  onset: 'ask_onset',
  course_or_stability: 'ask_course_or_stability',
  progression: 'ask_progression',
  relevant_background_facts: 'ask_background_facts',
  walking_or_movement_impact: 'ask_walking_impact',
  sleep_impact: 'ask_sleep_impact',
  daily_activity_or_behavior_impact: 'ask_daily_activity_impact'
};

const ALL_FIELDS = new Set(Object.values(STAGES).flatMap((stage) => stage.required));
const STAGE_KEYS = Object.keys(STAGES);
const GAP_GROUPS = {
  main_complaint: 'main_complaint',
  duration: 'timeline',
  onset: 'timeline',
  trigger_or_time_pattern: 'trigger_timing',
  severity_or_impact: 'general_impact',
  walking_or_movement_impact: 'walking_impact',
  sleep_impact: 'sleep_impact',
  daily_activity_or_behavior_impact: 'daily_impact',
  course_or_stability: 'course',
  progression: 'progression',
  relevant_background_facts: 'background'
};

function nowIso() {
  return new Date().toISOString();
}

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(input) {
  return compactText(input).toLowerCase().replace(/ё/g, 'е');
}

function uniquePhrases(values) {
  return [...new Set((values || []).map((item) => compactText(item)).filter(Boolean))];
}

function finishSentence(text) {
  const value = compactText(text);
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function normalizePersonText(input) {
  return normalizeText(input)
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class AdvisorContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdvisorContextError';
    this.code = code;
  }
}

function findPatientFromScreenContext(runtime, patientId, screenContext = {}) {
  const byId = patientId ? getPatientById(runtime, patientId) : null;
  if (byId) return byId;

  const selectedName = normalizePersonText(screenContext.selected_patient_name);
  if (!selectedName) return null;

  return runtime.patients.find((patient) => {
    const fullName = normalizePersonText(patient.full_name);
    return fullName === selectedName
      || fullName.includes(selectedName)
      || selectedName.includes(fullName);
  }) || null;
}

function clampConfidence(value, fallback = 0.7) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function asList(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item)).filter(Boolean).slice(0, limit);
}

function fieldLabel(fieldKey) {
  const labels = {
    tbmedicalfinal: 'Заключение',
    recommendations: 'Рекомендации',
    dynamics: 'Динамика развития',
    'work-plan': 'План работы',
    'planned-sessions': 'Планируемые занятия',
    'completed-sessions': 'Проведенные занятия',
    main_complaint: 'Ведущая жалоба',
    duration: 'Длительность жалобы',
    trigger_or_time_pattern: 'Триггер или время появления',
    severity_or_impact: 'Выраженность или влияние',
    onset: 'Начало состояния',
    course_or_stability: 'Течение или стабильность',
    progression: 'Прогрессирование',
    relevant_background_facts: 'Значимые факты анамнеза',
    walking_or_movement_impact: 'Влияние на ходьбу/движение',
    sleep_impact: 'Влияние на сон',
    daily_activity_or_behavior_impact: 'Влияние на активность/поведение'
  };
  return labels[fieldKey] || 'Поле формы';
}

function stageLabel(stageKey) {
  return STAGES[stageKey]?.label || 'Уточнение';
}

function getOpenRouterConfig() {
  return {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_ADVISOR_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    fallbackModel: process.env.OPENROUTER_ADVISOR_FALLBACK_MODEL || '',
    endpoint: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
    appTitle: process.env.OPENROUTER_APP_TITLE || 'Damumed Sandbox Agent',
    appReferer: process.env.OPENROUTER_APP_REFERER || 'http://localhost:3030'
  };
}

function recentTranscript(appointment) {
  return (appointment?.draft_state?.transcript_chunks || [])
    .slice(-8)
    .map((chunk) => ({
      speaker: chunk.speaker_tag || 'unknown',
      text: compactText(chunk.text),
      normalized_text: compactText(chunk.normalized_text || chunk.normalization?.normalized_transcript || ''),
      normalization: chunk.normalization || null,
      confidence: chunk.confidence
    }))
    .filter((chunk) => chunk.text);
}

function draftFacts(appointment) {
  return (appointment?.draft_state?.fact_candidates || [])
    .slice(-24)
    .map((fact) => ({
      field: fact.field_key,
      value: compactText(fact.normalized_value || fact.raw_evidence),
      confidence: fact.confidence,
      source: fact.source_type || 'draft_state'
    }))
    .filter((fact) => fact.value);
}

function formGuidanceFromPatches(appointment) {
  return (appointment?.draft_state?.draft_patches || [])
    .filter((patch) => patch.status !== 'applied')
    .slice(0, 6)
    .map((patch) => ({
      field_label: patch.title || fieldLabel(patch.field_key),
      suggestion: patch.value_type === 'checkbox-group'
        ? 'Проверьте и отметьте подходящие пункты раздела.'
        : compactText(patch.value),
      reason: 'Предложено по данным текущего приема.'
    }))
    .filter((item) => item.suggestion);
}

function readonlySummary(appointment) {
  const tabs = appointment?.readonly_tabs || {};
  return {
    diagnoses: (tabs.diagnoses || []).map((item) => compactText(item.label || item.code)).filter(Boolean),
    healthIndicators: (tabs.healthIndicators || []).map((item) => `${compactText(item.label)}: ${compactText(item.value)}`).filter(Boolean),
    diaries: (tabs.diaries || []).map((item) => compactText(item.note)).filter(Boolean).slice(-4),
    files: (tabs.files || []).map((item) => compactText(item.name)).filter(Boolean),
    medicalRecords: (tabs.medicalRecords || []).map((item) => compactText(item.title)).filter(Boolean)
  };
}

function screenScopeFor(screenContext, appointment, patient) {
  if (appointment) return 'inspection';
  const screenId = String(screenContext?.screen_id || '').replace(/-/g, '_');
  if (patient && ['patient_card', 'patient', 'patient_profile'].includes(screenId)) return 'patient_card';
  if (patient && screenContext?.selected_patient_id && !screenContext?.selected_appointment_id) return 'patient_card';
  return 'unsupported';
}

function getInitialAdvisorState(scope, patientId) {
  return {
    scope,
    patient_id: patientId || null,
    current_stage: 'complaints',
    initial_answer_captured: false,
    follow_up_count: 0,
    target_follow_up_questions: DEMO_FOLLOW_UP_POLICY.target,
    max_follow_up_questions: DEMO_FOLLOW_UP_POLICY.max,
    resolved_gap_groups: [],
    known_facts: [],
    normalized_facts: [],
    covered_fields: [],
    asked_questions: [],
    asked_question_signatures: [],
    last_reasoning: null,
    stage_complete: false,
    advisor_complete: false,
    completion_ready: false,
    final_preview_ready: false,
    updated_at: null
  };
}

function currentAdvisorState(appointment, context) {
  if (appointment?.draft_state?.advisor_state) return appointment.draft_state.advisor_state;
  return getInitialAdvisorState(context.advisor_context.screen_scope, context.advisor_context.patient_id);
}

function buildAdvisorContext(runtime, { appointmentId, question, screenContext = {} }) {
  const normalizedAppointmentId = appointmentId || screenContext?.selected_appointment_id || null;
  const appointment = normalizedAppointmentId ? getAppointmentById(runtime, normalizedAppointmentId) : null;
  const patientId = appointment?.patient_id || screenContext?.selected_patient_id || null;
  const patient = findPatientFromScreenContext(runtime, patientId, screenContext);
  const screenScope = screenScopeFor(screenContext, appointment, patient);

  if (!patient || screenScope === 'unsupported') {
    throw new AdvisorContextError(
      'advisor_context_missing',
      'Откройте карточку пациента или форму приема, чтобы советчик видел медицинский контекст.'
    );
  }

  const advisorContext = {
    screen_scope: screenScope,
    patient_id: patient.patient_id,
    appointment_id: appointment?.appointment_id || null,
    can_patch_draft: Boolean(appointment)
  };
  const state = currentAdvisorState(appointment, { advisor_context: advisorContext });
  const transcript = recentTranscript(appointment);
  const latestChunk = transcript[transcript.length - 1] || null;
  const rawLatestTranscript = latestChunk?.text || compactText(question);
  const normalization = latestChunk?.normalization || normalizeTranscript(rawLatestTranscript);
  const normalizedLatestTranscript = latestChunk?.normalized_text || normalization.normalized_transcript || compactText(question);

  return {
    question: compactText(question),
    latest_answer: normalizedLatestTranscript,
    raw_latest_answer: rawLatestTranscript,
    normalization,
    screen: screenScope,
    advisor_context: advisorContext,
    advisor_state: state,
    patient: {
      patient_id: patient.patient_id,
      full_name: patient.full_name,
      birth_date: patient.birth_date,
      sex: patient.sex,
      specialty_track: patient.specialty_track,
      baseline_conclusion: patient.baseline_conclusion,
      summary: patient.summary,
      history_refs: patient.history_refs || [],
      template_sections: (patient.medical_template?.sections || []).slice(0, 12).map((section) => ({
        section_key: section.section_key,
        title: section.title,
        kind: section.kind,
        option_labels: (section.options || []).map((option) => option.label).slice(0, 8)
      }))
    },
    appointment: appointment ? {
      appointment_id: appointment.appointment_id,
      status: appointment.status,
      conclusion_text: appointment.inspection_draft?.conclusion_text || '',
      supplemental: appointment.inspection_draft?.supplemental || {}
    } : null,
    history: readonlySummary(appointment),
    transcript,
    facts: draftFacts(appointment),
    form_guidance: formGuidanceFromPatches(appointment)
  };
}

function normalizeFieldKey(field) {
  const key = String(field || '').trim().replace(/^advisor\./, '');
  if (ALL_FIELDS.has(key)) return key;
  return null;
}

function makeFact(field, value, confidence = 0.72, source = 'latest_answer', extra = {}) {
  const fieldKey = normalizeFieldKey(field);
  const text = compactText(value);
  if (!fieldKey || !text) return null;
  return {
    field: fieldKey,
    value: text,
    confidence: clampConfidence(confidence),
    source,
    raw_evidence: compactText(extra.raw_evidence || text),
    semantic_slot: compactText(extra.semantic_slot || QUESTION_SIGNATURES[fieldKey] || '')
  };
}

function extractRelativeTimePhrase(normalized) {
  const explicitDigits = normalized.match(/(\d+)\s*(дн(?:я|ей)?|недел(?:и|ю)?|месяц(?:а|ев)?|год(?:а|ов)?|час(?:а|ов)?)/);
  if (explicitDigits) return compactText(`${explicitDigits[1]} ${explicitDigits[2]}`);

  const explicitWords = normalized.match(
    /(?:^|\s)(один|одну|одной|два|две|три|тр[её]х|четыре|четырех|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|несколько)\s+(дн(?:я|ей)?|недель|недели|неделю|месяц(?:а|ев)?|год(?:а|ов)?|час(?:а|ов)?)(?=\s|$)/
  );
  if (explicitWords) return compactText(`${explicitWords[1]} ${explicitWords[2]}`);
  return '';
}

function joinFactValues(existingValue, nextValue) {
  return uniquePhrases([
    ...String(existingValue || '').split(/[.;]/),
    ...String(nextValue || '').split(/[.;]/)
  ]).join('. ');
}

function normalizeDurationFact(normalized) {
  const relativeTimePhrase = extractRelativeTimePhrase(normalized);
  if (relativeTimePhrase) return `Длительность жалоб около ${relativeTimePhrase}`;
  if (/с рождения/.test(normalized)) return 'Жалобы отмечаются с рождения';
  if (/давно/.test(normalized)) return 'Жалобы сохраняются длительное время';
  if (/сегодня/.test(normalized)) return 'Жалобы появились сегодня';
  if (/вчера/.test(normalized)) return 'Жалобы появились накануне';
  return '';
}

function normalizeTriggerOrTimePattern(normalized) {
  const fragments = [];
  if (/после ходьб|после прогул|после нагруз/.test(normalized)) fragments.push('усиливаются после ходьбы или нагрузки');
  if (/в покое/.test(normalized)) fragments.push('сохраняются в покое');
  if (/вечер/.test(normalized)) fragments.push('более выражены в вечернее время');
  if (/ноч/.test(normalized)) fragments.push('отмечаются в ночное время');
  if (!fragments.length) return '';
  return `Симптомы ${fragments.join(', ')}`;
}

function normalizeSeverityOrImpact(normalized) {
  if (/не может ходить|не может долго ходить|трудно ходить/.test(normalized)) {
    return 'Симптомы ограничивают возможность ходьбы';
  }
  if (/быстро устает.*ход|устает.*при ход/.test(normalized)) {
    return 'Симптомы сопровождаются быстрой утомляемостью при ходьбе';
  }
  if (/меша|огранич|сильно|выраж/.test(normalized)) {
    return 'Симптомы значимо ограничивают повседневную активность';
  }
  return '';
}

function normalizeOnsetFact(normalized) {
  const relativeTimePhrase = extractRelativeTimePhrase(normalized);
  if (relativeTimePhrase && /(начал|началось|появил|впервые|стало)/.test(normalized)) {
    return `Жалобы появились около ${relativeTimePhrase} назад`;
  }
  if (/с рождения/.test(normalized)) return 'Особенности отмечаются с рождения';
  if (/начал|началось|появил/.test(normalized)) return 'Пациент связывает начало жалоб с указанным периодом';
  return '';
}

function normalizeCourseFact(normalized) {
  if (/стабильн|без измен|сохраняется/.test(normalized)) return 'Состояние без существенной динамики';
  if (/хуже|ухудш/.test(normalized)) return 'Отмечается ухудшение состояния';
  if (/лучше|улучш/.test(normalized)) return 'Отмечается улучшение состояния';
  return '';
}

function normalizeProgressionFact(normalized) {
  if (/стало хуже|хуже|чаще|сильнее|нараст/.test(normalized)) return 'Симптомы имеют тенденцию к нарастанию';
  if (/реже|уменьш|слабее/.test(normalized)) return 'Выраженность симптомов уменьшилась';
  return '';
}

function normalizeBackgroundFact(normalized) {
  const fragments = [];
  if (/реабилитац/.test(normalized)) fragments.push('в анамнезе курс реабилитации');
  if (/лечение/.test(normalized)) fragments.push('имеется указание на предшествующее лечение');
  if (/травм/.test(normalized)) fragments.push('имеется указание на травматический фактор');
  if (!fragments.length) return '';
  return `Из анамнеза: ${fragments.join(', ')}`;
}

function normalizeWalkingImpactFact(normalized) {
  if (/быстро устает.*ход|устает.*при ход/.test(normalized)) return 'Быстрая утомляемость при ходьбе';
  if (/боль.*ход|ходит.*боль|после ходьб/.test(normalized)) return 'Усиление симптомов при ходьбе';
  if (/трудно ходить|не может ходить/.test(normalized)) return 'Затруднение ходьбы';
  return '';
}

function normalizeSleepImpactFact(normalized) {
  if (/просып|ночью плачет|ночью кричит/.test(normalized)) return 'Нарушение сна с ночными пробуждениями';
  if (/мешает спать|не спит/.test(normalized)) return 'Симптомы нарушают ночной сон';
  return '';
}

function normalizeDailyImpactFact(normalized) {
  if (/менее актив|меньше играет|хуже играет/.test(normalized)) return 'Снижение дневной активности';
  if (/дома устает|быстро устает днем/.test(normalized)) return 'Быстрая утомляемость в течение дня';
  if (/поведен|капризн|плаксив/.test(normalized)) return 'Изменение поведения на фоне симптомов';
  return '';
}

function normalizeMainComplaintFact(normalized) {
  const fragments = [];
  if (/бол.*ног|ног.*бол|ножк.*бол/.test(normalized)) fragments.push('Жалобы на боли в нижних конечностях');
  if (/быстро устает.*ход|устает.*при ход/.test(normalized)) fragments.push('Быстрая утомляемость при ходьбе');
  if (/просып|ночью плачет|мешает спать/.test(normalized)) fragments.push('Нарушение сна на фоне жалоб');
  if (/слабост/.test(normalized) && !fragments.length) fragments.push('Жалобы на слабость');
  if (!fragments.length && /бол|жалоб|беспоко|устал|трудно/.test(normalized)) {
    fragments.push('Жалобы на текущие симптомы, требующие уточнения');
  }
  return uniquePhrases(fragments).join(', ');
}

function extractFactsFromText(text, source = 'latest_answer') {
  const normalized = normalizeText(text);
  const original = compactText(text);
  if (!normalized) return [];

  const facts = [];
  const complaint = normalizeMainComplaintFact(normalized);
  if (complaint) facts.push(makeFact('main_complaint', complaint, 0.84, source, { raw_evidence: original }));

  const duration = normalizeDurationFact(normalized);
  if (duration) facts.push(makeFact('duration', duration, 0.76, source, { raw_evidence: original }));

  const trigger = normalizeTriggerOrTimePattern(normalized);
  if (trigger) facts.push(makeFact('trigger_or_time_pattern', trigger, 0.8, source, { raw_evidence: original }));

  const severity = normalizeSeverityOrImpact(normalized);
  if (severity) facts.push(makeFact('severity_or_impact', severity, 0.8, source, { raw_evidence: original }));

  const onset = normalizeOnsetFact(normalized);
  if (onset) facts.push(makeFact('onset', onset, 0.76, source, { raw_evidence: original }));

  const course = normalizeCourseFact(normalized);
  if (course) facts.push(makeFact('course_or_stability', course, 0.76, source, { raw_evidence: original }));

  const progression = normalizeProgressionFact(normalized);
  if (progression) facts.push(makeFact('progression', progression, 0.78, source, { raw_evidence: original }));

  const background = normalizeBackgroundFact(normalized);
  if (background) facts.push(makeFact('relevant_background_facts', background, 0.74, source, { raw_evidence: original }));

  const walkingImpact = normalizeWalkingImpactFact(normalized);
  if (walkingImpact) facts.push(makeFact('walking_or_movement_impact', walkingImpact, 0.82, source, { raw_evidence: original }));

  const sleepImpact = normalizeSleepImpactFact(normalized);
  if (sleepImpact) facts.push(makeFact('sleep_impact', sleepImpact, 0.82, source, { raw_evidence: original }));

  const dailyImpact = normalizeDailyImpactFact(normalized);
  if (dailyImpact) facts.push(makeFact('daily_activity_or_behavior_impact', dailyImpact, 0.78, source, { raw_evidence: original }));

  return mergeFacts(facts);
}

function mergeFacts(facts) {
  const mergeableFields = new Set(['main_complaint', 'trigger_or_time_pattern', 'relevant_background_facts']);
  const byField = new Map();
  for (const fact of facts) {
    const normalized = makeFact(fact.field, fact.value, fact.confidence, fact.source, fact);
    if (!normalized) continue;
    const existing = byField.get(normalized.field);
    if (existing && mergeableFields.has(normalized.field)) {
      byField.set(normalized.field, {
        ...existing,
        value: joinFactValues(existing.value, normalized.value),
        raw_evidence: joinFactValues(existing.raw_evidence, normalized.raw_evidence),
        confidence: Math.max(existing.confidence, normalized.confidence)
      });
      continue;
    }
    if (!existing || normalized.confidence >= existing.confidence) {
      byField.set(normalized.field, normalized);
    }
  }
  return [...byField.values()];
}

function collectKnownFacts(context) {
  const facts = [];
  facts.push(...(context.advisor_state?.normalized_facts || context.advisor_state?.known_facts || []));
  facts.push(...context.facts.map((fact) => makeFact(fact.field, fact.value, fact.confidence, fact.source)).filter(Boolean));
  for (const chunk of context.transcript) {
    facts.push(...extractFactsFromText(chunk.normalized_text || chunk.text, 'normalized_transcript'));
  }
  facts.push(...extractFactsFromText(context.latest_answer, 'normalized_transcript'));
  if (context.appointment?.conclusion_text) {
    facts.push(makeFact('main_complaint', context.appointment.conclusion_text, 0.65, 'existing_form_context'));
  }
  return mergeFacts(facts);
}

function missingFields(stageKey, facts) {
  if (stageKey === COMPLETED_STAGE) return [];
  const known = new Set(facts.map((fact) => fact.field));
  return (STAGES[stageKey]?.required || STAGES.complaints.required).filter((field) => !known.has(field));
}

function chooseStage(stateStage, facts) {
  if (stateStage === COMPLETED_STAGE) return COMPLETED_STAGE;
  let stage = STAGES[stateStage] ? stateStage : 'complaints';
  while (STAGES[stage]?.next && missingFields(stage, facts).length === 0) {
    stage = STAGES[stage].next;
  }
  return stage;
}

function isQuestionAlreadyAsked(question, askedQuestions) {
  const normalized = normalizeText(question);
  return (askedQuestions || []).some((asked) => {
    const askedNormalized = normalizeText(asked);
    return askedNormalized && (askedNormalized.includes(normalized) || normalized.includes(askedNormalized));
  });
}

function questionVariants(stageKey, field, facts) {
  const factMap = Object.fromEntries(facts.map((fact) => [fact.field, fact.value]));
  if (field === 'duration') {
    return ['Когда впервые появились эти жалобы?', 'Как давно сохраняются эти симптомы?'];
  }
  if (field === 'trigger_or_time_pattern') {
    return [
      'Симптомы усиливаются после ходьбы или бывают и в покое?',
      'В какое время жалобы выражены сильнее: вечером, после нагрузки или ночью?'
    ];
  }
  if (field === 'severity_or_impact') {
    return [
      'Насколько это мешает ребенку ходить или двигаться?',
      'Из-за этих симптомов ребенок ограничивает обычную активность?'
    ];
  }
  if (field === 'onset') {
    return ['С чего начались эти жалобы?', 'С чем вы связываете появление жалоб?'];
  }
  if (field === 'course_or_stability') {
    return ['Состояние сейчас ухудшается, улучшается или остается без изменений?', 'Жалобы держатся на одном уровне или меняются со временем?'];
  }
  if (field === 'progression') {
    return ['За последнее время симптомы стали сильнее или чаще?', 'Есть ли нарастание жалоб в динамике?'];
  }
  if (field === 'relevant_background_facts') {
    return ['Было ли раньше лечение, реабилитация или похожие жалобы?', 'Есть ли важные события или лечение, которые нужно учесть в анамнезе?'];
  }
  if (field === 'walking_or_movement_impact') {
    return ['Как это влияет на ходьбу или движение?', 'Ребенок быстрее устает или ограничивает ходьбу из-за этих жалоб?'];
  }
  if (field === 'sleep_impact') {
    return ['Из-за этих симптомов ребенок просыпается ночью?', 'Жалобы мешают ночному сну?'];
  }
  if (field === 'daily_activity_or_behavior_impact') {
    return ['Как это влияет на дневную активность или поведение?', 'Из-за симптомов ребенок стал менее активным в течение дня?'];
  }
  if (field === 'main_complaint' && factMap.main_complaint) {
    return [];
  }
  return [STAGES[stageKey]?.questions?.[field] || 'Какой следующий важный факт нужно уточнить?'];
}

function countAskedSignature(signature, askedQuestionSignatures = []) {
  return (askedQuestionSignatures || []).filter((item) => item === signature).length;
}

function factMapFromFacts(facts) {
  return Object.fromEntries((facts || []).map((fact) => [fact.field, fact.value]));
}

function resolvedGapGroupsFromFacts(facts = []) {
  const resolved = new Set();
  for (const fact of facts) {
    const group = GAP_GROUPS[fact.field];
    if (group) resolved.add(group);
    if (fact.field === 'trigger_or_time_pattern' && /(после ходьб|после нагруз|в покое)/i.test(fact.value || '')) {
      resolved.add('load_vs_rest');
    }
    if (['severity_or_impact', 'walking_or_movement_impact', 'sleep_impact', 'daily_activity_or_behavior_impact'].includes(fact.field)) {
      resolved.add('impact_any');
    }
    if (['duration', 'onset'].includes(fact.field)) {
      resolved.add('timeline');
    }
  }
  return [...resolved];
}

function missingDemoGapGroups(facts = []) {
  const resolved = new Set(resolvedGapGroupsFromFacts(facts));
  const missing = [];
  if (!resolved.has('main_complaint')) missing.push('main_complaint');
  if (!resolved.has('timeline')) missing.push('timeline');
  if (!resolved.has('load_vs_rest')) missing.push('load_vs_rest');
  if (!resolved.has('impact_any')) missing.push('impact_any');
  return missing;
}

function isDemoComplaintReady(facts = []) {
  return missingDemoGapGroups(facts).length === 0;
}

function symptomSubject(facts = []) {
  const complaint = normalizeText(factMapFromFacts(facts).main_complaint || '');
  if (/нижних конечност|ног/.test(complaint)) return 'эти боли в ногах';
  if (/утомляемост/.test(complaint)) return 'эта утомляемость';
  if (complaint) return 'эти жалобы';
  return 'эти симптомы';
}

function buildDemoQuestionCandidates(stageKey, facts, options = {}) {
  const resolvedGroups = new Set(options.resolvedGapGroups || resolvedGapGroupsFromFacts(facts));
  const followUpCount = Number(options.followUpCount || 0);
  const targetFollowUps = Number(options.targetFollowUps || DEMO_FOLLOW_UP_POLICY.target);
  const subject = symptomSubject(facts);
  const candidates = [];

  if (stageKey === 'complaints') {
    if (!resolvedGroups.has('timeline') && !resolvedGroups.has('load_vs_rest')) {
      candidates.push({
        field: 'duration',
        signature: 'ask_timeline_and_load',
        groups: ['timeline', 'load_vs_rest'],
        strength: 0.96,
        priority: 100,
        question: `Когда впервые появились ${subject} и усиливаются ли они после ходьбы или бывают и в покое?`
      });
    } else if (!resolvedGroups.has('timeline')) {
      candidates.push({
        field: 'duration',
        signature: 'ask_timeline',
        groups: ['timeline'],
        strength: 0.92,
        priority: 95,
        question: `Когда впервые появились ${subject}?`
      });
    } else if (!resolvedGroups.has('load_vs_rest')) {
      candidates.push({
        field: 'trigger_or_time_pattern',
        signature: 'ask_load_vs_rest',
        groups: ['load_vs_rest'],
        strength: 0.92,
        priority: 94,
        question: `Эти жалобы усиливаются после ходьбы или бывают и в покое?`
      });
    }

    if (!resolvedGroups.has('impact_any')) {
      candidates.push({
        field: 'severity_or_impact',
        signature: 'ask_walking_and_sleep_impact',
        groups: ['walking_impact', 'sleep_impact', 'impact_any'],
        strength: 0.95,
        priority: 93,
        question: 'Насколько это мешает ходить и просыпается ли ребенок из-за этого ночью?'
      });
    } else if (followUpCount < targetFollowUps) {
      if (!resolvedGroups.has('sleep_impact') && !resolvedGroups.has('daily_impact')) {
        candidates.push({
          field: 'sleep_impact',
          signature: 'ask_sleep_and_daily_impact',
          groups: ['sleep_impact', 'daily_impact'],
          strength: 0.91,
          priority: 90,
          question: 'Кроме этого, жалобы мешают ночному сну или делают ребенка менее активным в течение дня?'
        });
      } else if (!resolvedGroups.has('sleep_impact')) {
        candidates.push({
          field: 'sleep_impact',
          signature: 'ask_sleep_impact_detail',
          groups: ['sleep_impact'],
          strength: 0.88,
          priority: 88,
          question: 'Из-за этих жалоб ребенок просыпается ночью или сон остается спокойным?'
        });
      } else if (!resolvedGroups.has('daily_impact')) {
        candidates.push({
          field: 'daily_activity_or_behavior_impact',
          signature: 'ask_daily_impact_detail',
          groups: ['daily_impact'],
          strength: 0.87,
          priority: 87,
          question: 'Из-за симптомов ребенок стал менее активным, быстрее утомляется или хуже переносит обычные занятия днем?'
        });
      } else if (!resolvedGroups.has('progression')) {
        candidates.push({
          field: 'progression',
          signature: 'ask_progression_demo',
          groups: ['progression'],
          strength: 0.84,
          priority: 82,
          question: 'За последнее время эти симптомы стали появляться чаще или выражены сильнее, чем раньше?'
        });
      }
    }
  }

  if (stageKey === 'anamnesis') {
    if (!resolvedGroups.has('course') && !resolvedGroups.has('background')) {
      candidates.push({
        field: 'course_or_stability',
        signature: 'ask_course_and_background',
        groups: ['course', 'background'],
        strength: 0.86,
        priority: 85,
        question: 'Состояние в целом ухудшается или держится стабильно, и было ли раньше лечение или реабилитация по этим жалобам?'
      });
    } else if (!resolvedGroups.has('course')) {
      candidates.push({
        field: 'course_or_stability',
        signature: 'ask_course_detail',
        groups: ['course'],
        strength: 0.84,
        priority: 80,
        question: 'Состояние сейчас улучшается, ухудшается или сохраняется без заметных изменений?'
      });
    } else if (!resolvedGroups.has('background')) {
      candidates.push({
        field: 'relevant_background_facts',
        signature: 'ask_background_detail',
        groups: ['background'],
        strength: 0.82,
        priority: 78,
        question: 'Было ли раньше лечение, реабилитация или похожие эпизоды, которые важно учесть сейчас?'
      });
    }
  }

  if (stageKey === 'functional_impact') {
    if (!resolvedGroups.has('walking_impact') && !resolvedGroups.has('sleep_impact')) {
      candidates.push({
        field: 'walking_or_movement_impact',
        signature: 'ask_walking_and_sleep_followup',
        groups: ['walking_impact', 'sleep_impact'],
        strength: 0.86,
        priority: 84,
        question: 'Это больше ограничивает ходьбу днем или все-таки заметно влияет и на ночной сон?'
      });
    }
  }

  return candidates;
}

function isCandidateAvailable(candidate, askedQuestions = [], askedQuestionSignatures = [], resolvedGapGroups = []) {
  if (!candidate?.question) return false;
  if (isQuestionAlreadyAsked(candidate.question, askedQuestions)) return false;
  if (candidate.signature && countAskedSignature(candidate.signature, askedQuestionSignatures) > 0) return false;
  if ((candidate.groups || []).every((group) => resolvedGapGroups.includes(group))) return false;
  return true;
}

function chooseQuestionPlan(stageKey, missing, facts, askedQuestions = [], askedQuestionSignatures = [], options = {}) {
  if (stageKey === COMPLETED_STAGE) {
    return { field: '', signature: '', question: '', groups: [], strength: 0 };
  }
  const stage = STAGES[stageKey] || STAGES.complaints;
  const resolvedGapGroups = options.resolvedGapGroups || resolvedGapGroupsFromFacts(facts);
  const demoCandidates = buildDemoQuestionCandidates(stageKey, facts, {
    resolvedGapGroups,
    followUpCount: options.followUpCount || 0,
    targetFollowUps: options.targetFollowUps || DEMO_FOLLOW_UP_POLICY.target
  })
    .filter((candidate) => isCandidateAvailable(candidate, askedQuestions, askedQuestionSignatures, resolvedGapGroups))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
  if (demoCandidates.length) {
    const candidate = demoCandidates[0];
    return {
      field: candidate.field,
      signature: candidate.signature,
      question: candidate.question,
      groups: candidate.groups || [],
      strength: candidate.strength || 0.85
    };
  }
  for (const field of (missing.length ? missing : stage.required)) {
    const signature = QUESTION_SIGNATURES[field] || `ask_${field}`;
    const variants = questionVariants(stageKey, field, facts)
      .map((question) => compactText(question))
      .filter(Boolean)
      .filter((question) => !isQuestionAlreadyAsked(question, askedQuestions));
    if (!variants.length) continue;
    const askedCount = countAskedSignature(signature, askedQuestionSignatures);
    if (askedCount >= variants.length) continue;
    const selected = variants[askedCount];
    if (selected) {
      return { field, signature, question: selected, groups: [GAP_GROUPS[field]].filter(Boolean), strength: 0.74 };
    }
  }
  return { field: '', signature: '', question: '', groups: [], strength: 0 };
}

function chooseQuestion(stageKey, missing, facts, askedQuestions = [], askedQuestionSignatures = []) {
  return chooseQuestionPlan(stageKey, missing, facts, askedQuestions, askedQuestionSignatures).question;
}

function buildDemoPolicy(context, facts, clinicalStageKey, clinicalStageComplete) {
  const state = context.advisor_state || {};
  const targetFollowUps = Number(state.target_follow_up_questions || DEMO_FOLLOW_UP_POLICY.target);
  const maxFollowUps = Number(state.max_follow_up_questions || DEMO_FOLLOW_UP_POLICY.max);
  const followUpCount = Number(state.follow_up_count || 0);
  const resolvedGapGroups = resolvedGapGroupsFromFacts(facts);
  const criticalGapGroups = missingDemoGapGroups(facts);
  const initialAnswerCaptured = Boolean(state.initial_answer_captured || facts.length);
  const complaintReady = criticalGapGroups.length === 0;
  const allowThirdQuestion = followUpCount >= targetFollowUps && followUpCount < maxFollowUps && criticalGapGroups.length > 0;
  const demoComplete = followUpCount >= maxFollowUps || (followUpCount >= targetFollowUps && complaintReady);
  const advisorComplete = Boolean(demoComplete || (clinicalStageComplete && !STAGES[clinicalStageKey]?.next));
  return {
    initialAnswerCaptured,
    followUpCount,
    targetFollowUps,
    maxFollowUps,
    resolvedGapGroups,
    criticalGapGroups,
    complaintReady,
    allowAnotherQuestion: !advisorComplete && (followUpCount < targetFollowUps || allowThirdQuestion),
    allowThirdQuestion,
    demoComplete,
    advisorComplete
  };
}

function buildNormalizedFieldValues(facts) {
  const factMap = Object.fromEntries(facts.map((fact) => [fact.field, fact.value]));
  const conclusionParts = uniquePhrases([
    factMap.main_complaint,
    factMap.duration,
    factMap.trigger_or_time_pattern,
    factMap.severity_or_impact,
    factMap.walking_or_movement_impact,
    factMap.sleep_impact,
    factMap.daily_activity_or_behavior_impact
  ]);
  const dynamicsParts = uniquePhrases([
    factMap.onset,
    factMap.course_or_stability,
    factMap.progression,
    factMap.relevant_background_facts
  ]);
  const workPlanParts = uniquePhrases([
    factMap.walking_or_movement_impact ? 'Продолжить оценку влияния симптомов на ходьбу и переносимость нагрузки' : '',
    factMap.sleep_impact ? 'Продолжить оценку влияния жалоб на качество сна' : '',
    factMap.daily_activity_or_behavior_impact ? 'Продолжить оценку влияния жалоб на повседневную активность и поведение' : '',
    conclusionParts.length ? 'Динамическое наблюдение за выраженностью жалоб и функциональными ограничениями' : ''
  ]);
  const recommendationParts = uniquePhrases([
    factMap.trigger_or_time_pattern || factMap.walking_or_movement_impact ? 'Контроль переносимости физической нагрузки и выраженности симптомов в динамике' : '',
    factMap.sleep_impact ? 'Наблюдение за ночным сном и частотой пробуждений' : '',
    conclusionParts.length ? 'Повторная очная оценка при нарастании жалоб' : ''
  ]);

  return {
    tbmedicalfinal: conclusionParts.map(finishSentence).join(' '),
    dynamics: dynamicsParts.map(finishSentence).join(' '),
    'work-plan': workPlanParts.map(finishSentence).join(' '),
    recommendations: recommendationParts.map(finishSentence).join(' ')
  };
}

function buildAdvisorPatchPreview(normalizedFieldValues, context) {
  if (!context.advisor_context.can_patch_draft) return [];
  return NORMALIZED_PATCH_FIELDS
    .map((fieldKey) => {
      const value = compactText(normalizedFieldValues[fieldKey]);
      if (!value) return null;
      return {
        patch_id: `advisor-normalized-${fieldKey}`,
        field_key: fieldKey,
        title: fieldLabel(fieldKey),
        value_type: 'text',
        value,
        provenance: 'advisor_reasoning_normalized',
        confidence: 0.9,
        status: 'suggested'
      };
    })
    .filter(Boolean);
}

function knownFactsSummary(facts) {
  return facts
    .slice(0, 8)
    .map((fact) => `${fieldLabel(fact.field)}: ${fact.value}`);
}

function buildFallbackReasoning(context) {
  const knownFacts = collectKnownFacts(context);
  const newFacts = extractFactsFromText(context.latest_answer, 'normalized_transcript');
  const mergedFacts = mergeFacts([...knownFacts, ...newFacts]);
  const mergedStage = chooseStage(context.advisor_state?.current_stage, mergedFacts);
  const mergedMissing = missingFields(mergedStage, mergedFacts);
  const mergedStageComplete = mergedMissing.length === 0;
  const mergedDemoPolicy = buildDemoPolicy(context, mergedFacts, mergedStage, mergedStageComplete);
  const questionPlan = mergedDemoPolicy.allowAnotherQuestion
    ? chooseQuestionPlan(
        mergedStage,
        mergedMissing,
        mergedFacts,
        context.advisor_state?.asked_questions || [],
        context.advisor_state?.asked_question_signatures || [],
        {
          followUpCount: mergedDemoPolicy.followUpCount,
          targetFollowUps: mergedDemoPolicy.targetFollowUps,
          resolvedGapGroups: mergedDemoPolicy.resolvedGapGroups
        }
      )
    : { field: '', signature: '', question: '', groups: [], strength: 0 };
  const normalizedFieldValues = buildNormalizedFieldValues(mergedFacts);
  const patchPreview = buildAdvisorPatchPreview(normalizedFieldValues, context);
  return {
    stage: mergedStage,
    new_facts: newFacts,
    known_facts_summary: knownFactsSummary(mergedFacts),
    covered_fields: mergedFacts.map((fact) => fact.field),
    missing_fields: mergedMissing,
    resolved_gap_groups: mergedDemoPolicy.resolvedGapGroups,
    normalized_field_values: normalizedFieldValues,
    patch_preview: patchPreview,
    selected_question_field: questionPlan.field,
    selected_question_signature: questionPlan.signature,
    selected_gap_groups: questionPlan.groups || [],
    follow_up_question_strength: questionPlan.strength || 0,
    follow_up_count: mergedDemoPolicy.followUpCount + (questionPlan.question ? 1 : 0),
    target_follow_up_questions: mergedDemoPolicy.targetFollowUps,
    max_follow_up_questions: mergedDemoPolicy.maxFollowUps,
    demo_ready_after_this_question: mergedDemoPolicy.complaintReady && (mergedDemoPolicy.followUpCount + (questionPlan.question ? 1 : 0)) >= mergedDemoPolicy.targetFollowUps,
    next_best_question: mergedDemoPolicy.allowAnotherQuestion ? questionPlan.question : '',
    question_reason: mergedDemoPolicy.advisorComplete
      ? 'Все обязательные поля собраны, можно завершить интервью и проверить черновик формы.'
      : mergedDemoPolicy.demoComplete
        ? 'Для demo собран достаточно сильный структурированный набор данных, можно переходить к preview.'
        : mergedMissing.length
          ? `Нужно закрыть ключевые gaps: ${mergedMissing.map(fieldLabel).join(', ')}.`
          : `Этап "${STAGES[mergedStage].label}" заполнен достаточно, можно перейти дальше.`,
    stage_complete: mergedStageComplete,
    clinical_stage_complete: mergedStageComplete,
    demo_complete: mergedDemoPolicy.demoComplete,
    advisor_complete: mergedDemoPolicy.advisorComplete,
    completion_ready: mergedDemoPolicy.advisorComplete,
    final_preview_ready: mergedDemoPolicy.advisorComplete && patchPreview.length > 0,
    stage_completion_reason: mergedDemoPolicy.demoComplete
      ? 'Demo-цикл завершен: собрано достаточно ключевых фактов для краткого структурированного черновика.'
      : mergedStageComplete
        ? `Все обязательные поля этапа "${STAGES[mergedStage].label}" уже покрыты.`
        : `Этап "${STAGES[mergedStage].label}" пока не завершен: ${mergedMissing.map(fieldLabel).join(', ')}.`,
    completion_title: mergedDemoPolicy.advisorComplete ? 'Сбор данных завершен' : '',
    completion_message: mergedDemoPolicy.advisorComplete ? 'Черновик для demo подготовлен. Проверьте и подтвердите заполнение.' : '',
    should_update_draft: context.advisor_context.can_patch_draft && patchPreview.length > 0,
    should_patch_draft: context.advisor_context.can_patch_draft && patchPreview.length > 0
  };
}

function fallbackHypotheses(context) {
  const known = context.history.diagnoses?.filter(Boolean) || [];
  if (known.length) {
    return known.slice(0, 3).map((name) => ({
      name: `Проверить ранее указанное состояние: ${name}`,
      likelihood: 'medium',
      supporting_signs: ['Есть упоминание в истории пациента.'],
      missing_checks: ['Сравнить с текущими жалобами, наблюдением и динамикой на приеме.'],
      cautions: ['Не считать это новым диагнозом без подтверждения текущими данными.']
    }));
  }
  return [{
    name: 'Клиническая гипотеза требует уточнения',
    likelihood: 'low',
    supporting_signs: ['В текущем контексте пока недостаточно подтвержденных признаков.'],
    missing_checks: ['Собрать недостающие факты текущего этапа интервью.'],
    cautions: ['Не формулировать диагноз до очной оценки и проверки ключевых признаков.']
  }];
}

function answerFromReasoning(reasoning, context) {
  const formGuidance = reasoning.patch_preview?.length
    ? reasoning.patch_preview.map((patch) => ({
        field_label: fieldLabel(patch.field_key),
        suggestion: patch.value,
        reason: `Нормализовано советчиком на основе собранных данных: ${reasoning.question_reason}`
      }))
    : [];
  const patientCardGuidance = context.advisor_context.screen_scope === 'patient_card'
    ? [{
        field_label: 'Черновик формы',
        suggestion: 'Откройте прием или назначение пациента, чтобы перенести эти факты в черновик формы.',
        reason: 'Сейчас открыт контекст карточки пациента без активного назначения.'
      }]
    : [];
  return {
    summary: reasoning.known_facts_summary.length
      ? reasoning.known_facts_summary.join('; ')
      : 'Пока недостаточно структурированных фактов. Советчик начнет с первого этапа интервью.',
    next_step: reasoning.advisor_complete
      ? 'Сбор данных завершен. Проверьте черновик формы и подтвердите заполнение.'
      : reasoning.next_best_question,
    differential_hypotheses: fallbackHypotheses(context),
    questions_to_ask: reasoning.advisor_complete || !reasoning.next_best_question ? [] : [reasoning.next_best_question],
    symptoms_to_check: reasoning.missing_fields.map(fieldLabel),
    form_guidance: formGuidance.length ? formGuidance : [...context.form_guidance, ...patientCardGuidance].slice(0, 6),
    red_flags: [
      'Резкое ухудшение состояния',
      'Потеря ранее сформированных навыков',
      'Судороги, выраженная сонливость или спутанность',
      'Острое нарушение речи или движения'
    ],
    doctor_note: DEFAULT_NOTE
  };
}

function parseModelJson(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function isGenericQuestion(question, facts) {
  const normalized = normalizeText(question);
  if (!facts.some((fact) => fact.field === 'main_complaint')) return false;
  return /что.*беспокоит|какие.*жалоб|расскажите.*жалоб|tell me more/.test(normalized);
}

function canonicalizeModelFact(fact, context) {
  const field = normalizeFieldKey(fact?.field);
  if (!field) return null;

  const sourceValue = compactText(fact?.value);
  const evidenceText = compactText(fact?.raw_evidence || context.raw_latest_answer || context.latest_answer || sourceValue);
  const combined = normalizeText([sourceValue, evidenceText, context.latest_answer].filter(Boolean).join(' '));
  let normalizedValue = '';

  if (field === 'main_complaint') {
    normalizedValue = normalizeMainComplaintFact(combined) || sourceValue;
  } else if (field === 'duration') {
    normalizedValue = normalizeDurationFact(combined);
  } else if (field === 'trigger_or_time_pattern') {
    normalizedValue = normalizeTriggerOrTimePattern(combined);
  } else if (field === 'severity_or_impact') {
    normalizedValue = normalizeSeverityOrImpact(combined) || sourceValue;
  } else if (field === 'onset') {
    normalizedValue = normalizeOnsetFact(combined);
  } else if (field === 'course_or_stability') {
    normalizedValue = normalizeCourseFact(combined);
  } else if (field === 'progression') {
    normalizedValue = normalizeProgressionFact(combined);
  } else if (field === 'relevant_background_facts') {
    normalizedValue = normalizeBackgroundFact(combined) || sourceValue;
  } else if (field === 'walking_or_movement_impact') {
    normalizedValue = normalizeWalkingImpactFact(combined) || sourceValue;
  } else if (field === 'sleep_impact') {
    normalizedValue = normalizeSleepImpactFact(combined) || sourceValue;
  } else if (field === 'daily_activity_or_behavior_impact') {
    normalizedValue = normalizeDailyImpactFact(combined) || sourceValue;
  }

  if (!compactText(normalizedValue)) return null;
  return makeFact(field, normalizedValue, fact?.confidence, fact?.source || 'normalized_transcript', {
    raw_evidence: evidenceText,
    semantic_slot: fact?.semantic_slot || QUESTION_SIGNATURES[field]
  });
}

function sanitizeModelFacts(modelFacts, context) {
  if (!Array.isArray(modelFacts)) return [];
  return modelFacts
    .map((fact) => canonicalizeModelFact(fact, context))
    .filter(Boolean);
}

function normalizeReasoning(raw, fallback, context) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const knownFacts = collectKnownFacts(context);
  const heuristicLatestFacts = extractFactsFromText(context.latest_answer, 'normalized_transcript');
  const normalizedFacts = mergeFacts([
    ...sanitizeModelFacts(Array.isArray(source.new_facts) ? source.new_facts : [], context),
    ...heuristicLatestFacts
  ]);
  const askedQuestions = context.advisor_state?.asked_questions || [];
  const askedQuestionSignatures = context.advisor_state?.asked_question_signatures || [];
  const mergedFacts = mergeFacts([...knownFacts, ...normalizedFacts]);
  const stage = chooseStage(context.advisor_state?.current_stage, mergedFacts);
  const resolvedMissing = missingFields(stage, mergedFacts);
  const stageComplete = resolvedMissing.length === 0;
  const demoPolicy = buildDemoPolicy(context, mergedFacts, stage, stageComplete);
  const fallbackPlan = demoPolicy.allowAnotherQuestion
    ? chooseQuestionPlan(stage, resolvedMissing, mergedFacts, askedQuestions, askedQuestionSignatures, {
        followUpCount: demoPolicy.followUpCount,
        targetFollowUps: demoPolicy.targetFollowUps,
        resolvedGapGroups: demoPolicy.resolvedGapGroups
      })
    : { field: '', signature: '', question: '', groups: [], strength: 0 };
  let question = demoPolicy.advisorComplete ? '' : (fallbackPlan.question || compactText(source.next_best_question) || fallback.next_best_question);
  if (!demoPolicy.advisorComplete && (isGenericQuestion(question, mergedFacts) || isQuestionAlreadyAsked(question, askedQuestions))) {
    question = fallbackPlan.question;
  }
  const normalizedFieldValues = buildNormalizedFieldValues(mergedFacts);
  const patchPreview = buildAdvisorPatchPreview(normalizedFieldValues, context);
  const nextFollowUpCount = demoPolicy.followUpCount + (question ? 1 : 0);
  return {
    stage,
    new_facts: normalizedFacts,
    known_facts_summary: asList(source.known_facts_summary).length
      ? asList(source.known_facts_summary)
      : knownFactsSummary(mergedFacts),
    covered_fields: mergedFacts.map((fact) => fact.field),
    missing_fields: resolvedMissing,
    resolved_gap_groups: demoPolicy.resolvedGapGroups,
    normalized_field_values: normalizedFieldValues,
    patch_preview: patchPreview,
    selected_question_field: fallbackPlan.field,
    selected_question_signature: fallbackPlan.signature,
    selected_gap_groups: fallbackPlan.groups || asList(source.selected_gap_groups, 4),
    follow_up_question_strength: clampConfidence(source.follow_up_question_strength, fallbackPlan.strength || 0.75),
    follow_up_count: nextFollowUpCount,
    target_follow_up_questions: demoPolicy.targetFollowUps,
    max_follow_up_questions: demoPolicy.maxFollowUps,
    demo_ready_after_this_question: demoPolicy.complaintReady && nextFollowUpCount >= demoPolicy.targetFollowUps,
    next_best_question: question,
    question_reason: (
      demoPolicy.advisorComplete
        ? 'Собрано достаточно данных для demo-черновика, можно завершить интервью и проверить preview.'
        : fallbackPlan.field
          ? `Нужно закрыть gap-группы: ${(fallbackPlan.groups || []).join(', ') || fieldLabel(fallbackPlan.field)}.`
          : compactText(source.question_reason) || fallback.question_reason
    ),
    stage_complete: stageComplete,
    clinical_stage_complete: stageComplete,
    demo_complete: demoPolicy.demoComplete,
    advisor_complete: demoPolicy.advisorComplete,
    completion_ready: demoPolicy.advisorComplete,
    final_preview_ready: demoPolicy.advisorComplete && patchPreview.length > 0,
    stage_completion_reason: demoPolicy.demoComplete
      ? 'Demo-цикл завершен: собрано достаточно фактов для краткого структурированного черновика.'
      : demoPolicy.advisorComplete
        ? 'Все этапы интервью заполнены достаточно.'
      : stageComplete
        ? `Все обязательные поля этапа "${STAGES[stage].label}" уже покрыты.`
        : `Этап "${STAGES[stage].label}" пока не завершен: ${resolvedMissing.map(fieldLabel).join(', ')}.`,
    completion_title: demoPolicy.advisorComplete ? 'Сбор данных завершен' : '',
    completion_message: demoPolicy.advisorComplete ? 'Черновик для demo подготовлен. Проверьте и подтвердите заполнение.' : '',
    should_update_draft: context.advisor_context.can_patch_draft && patchPreview.length > 0 && mergedFacts.length > 0,
    should_patch_draft: context.advisor_context.can_patch_draft && patchPreview.length > 0 && mergedFacts.length > 0
  };
}

function reasoningSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      stage: { type: 'string', enum: STAGE_KEYS },
      new_facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', enum: [...ALL_FIELDS] },
            value: { type: 'string' },
            confidence: { type: 'number' },
            source: { type: 'string', enum: ['normalized_transcript', 'transcript_chunk', 'existing_patient_context', 'history_template'] }
          },
          required: ['field', 'value', 'confidence', 'source']
        }
      },
      known_facts_summary: { type: 'array', items: { type: 'string' } },
      missing_fields: { type: 'array', items: { type: 'string', enum: [...ALL_FIELDS] } },
      selected_gap_groups: { type: 'array', items: { type: 'string' } },
      follow_up_question_strength: { type: 'number' },
      demo_ready_after_this_question: { type: 'boolean' },
      next_best_question: { type: 'string' },
      question_reason: { type: 'string' },
      stage_complete: { type: 'boolean' },
      stage_completion_reason: { type: 'string' },
      should_update_draft: { type: 'boolean' }
    },
    required: [
      'stage',
      'new_facts',
      'known_facts_summary',
      'missing_fields',
      'selected_gap_groups',
      'follow_up_question_strength',
      'demo_ready_after_this_question',
      'next_best_question',
      'question_reason',
      'stage_complete',
      'stage_completion_reason',
      'should_update_draft'
    ]
  };
}

function buildModelRequestPayload(context) {
  const knownFacts = collectKnownFacts(context);
  const currentStage = chooseStage(context.advisor_state?.current_stage, knownFacts);
  const demoPolicy = buildDemoPolicy(context, knownFacts, currentStage, missingFields(currentStage, knownFacts).length === 0);
  return {
    raw_transcript: context.raw_latest_answer,
    normalized_transcript: context.latest_answer,
    normalization_debug: context.normalization,
    current_stage: currentStage,
    stages: STAGES,
    screen_scope: context.advisor_context.screen_scope,
    can_patch_draft: context.advisor_context.can_patch_draft,
    known_facts: knownFacts,
    covered_fields: knownFacts.map((fact) => fact.field),
    resolved_gap_groups: demoPolicy.resolvedGapGroups,
    missing_fields_before_model: missingFields(currentStage, knownFacts),
    asked_questions: context.advisor_state?.asked_questions || [],
    asked_question_signatures: context.advisor_state?.asked_question_signatures || [],
    follow_up_count: demoPolicy.followUpCount,
    target_follow_up_questions: demoPolicy.targetFollowUps,
    max_follow_up_questions: demoPolicy.maxFollowUps,
    demo_goal: 'После начального рассказа пациента задать 2 сильных уточняющих follow-up вопроса и разрешить 3-й только если без него summary будет слишком слабым.',
    patient_context: context.patient,
    appointment_context: context.appointment,
    readonly_history: context.history,
    allowed_target_fields: [...ALL_FIELDS]
  };
}

function buildOpenRouterRequest(model, requestPayload) {
  return {
    model,
    temperature: 0.15,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'damumed_advisor_interview_reasoning',
        strict: true,
        schema: reasoningSchema()
      }
    },
    messages: [
      {
        role: 'system',
        content: [
          'Ты клинический советчик врача в локальной Damumed-песочнице.',
          'Отвечай только валидным JSON по схеме. Все текстовые значения на русском.',
          'Ты не чат-бот, не диагностируешь и не управляешь DOM.',
          'Ты анализируешь жалобы и ответы пациента, выделяешь только явно сказанные факты, находишь missing_fields и выбираешь ровно один next_best_question.',
          'Это demo-режим короткого интервью: врач уже задал стартовый общий вопрос, пациент уже дал первый обобщенный ответ.',
          'Твоя задача — после начального ответа выбрать 2 сильных follow-up вопроса, а 3-й разрешать только если без него summary будет слишком слабым.',
          'Предпочитай один сильный детальный вопрос, который закрывает 1-2 связанных gap-группы, вместо длинной цепочки однотипных коротких вопросов.',
          'Нормализуй бытовые слова пациента в клиническую документационную формулировку без постановки диагноза.',
          'Не копируй raw transcript в медицинскую форму. Формулировки должны быть медицинскими и нейтральными.',
          'Используй строгую медицинскую терминологию: "нога болит" -> "боли в нижних конечностях", "быстро устает когда ходит" -> "быстрая утомляемость при ходьбе", "просыпается ночью" -> "нарушение сна с ночными пробуждениями".',
          'Не путай поля: duration — это срок (дни, недели, месяцы), trigger_or_time_pattern — время суток или связь с нагрузкой, severity_or_impact — влияние на функцию и активность.',
          'Не повторяй вопросы из asked_questions. Не задавай общий вопрос о жалобах, если жалоба уже известна.',
          'Если стартовая речь уже закрыла semantic gap, не спрашивай об этом повторно.',
          'Не выдумывай факты. Не возвращай DOM selectors, HTML, JS, patches или инструкции по реализации.',
          'Если открыт patient_card без appointment, не предлагай применять форму напрямую; should_update_draft должен быть false.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify(requestPayload)
      }
    ]
  };
}

async function callOpenRouter(config, model, requestPayload) {
  const requestBody = buildOpenRouterRequest(model, requestPayload);
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.appReferer,
      'X-Title': config.appTitle
    },
    body: JSON.stringify(requestBody)
  });
  return { response, requestBody };
}

async function analyzeWithOpenRouter(context, fallbackReasoning) {
  const config = getOpenRouterConfig();
  const requestPayload = buildModelRequestPayload(context);
  const baseDebug = {
    raw_deepgram_transcript: context.raw_latest_answer,
    normalized_transcript: context.latest_answer,
    normalization: context.normalization,
    model: config.model,
    model_request_payload: requestPayload,
    model_response_json: null,
    fallback_used: false,
    extracted_facts: fallbackReasoning.new_facts,
    normalized_facts: fallbackReasoning.new_facts,
    covered_fields: fallbackReasoning.covered_fields,
    resolved_gap_groups: fallbackReasoning.resolved_gap_groups,
    normalized_field_values: fallbackReasoning.normalized_field_values,
    missing_fields: fallbackReasoning.missing_fields,
    selected_next_question: fallbackReasoning.next_best_question,
    follow_up_count: fallbackReasoning.follow_up_count,
    target_follow_up_questions: fallbackReasoning.target_follow_up_questions,
    max_follow_up_questions: fallbackReasoning.max_follow_up_questions,
    stage_complete: fallbackReasoning.stage_complete,
    advisor_complete: fallbackReasoning.advisor_complete,
    patch_preview: fallbackReasoning.patch_preview
  };

  if (!config.apiKey) {
    return {
      reasoning: fallbackReasoning,
      provider: {
        type: 'heuristic',
        error: 'OPENROUTER_API_KEY is not configured on the local backend.'
      },
      debug: { ...baseDebug, fallback_used: true }
    };
  }

  const { response, requestBody } = await callOpenRouter(config, config.model, requestPayload);
  if (!response.ok) {
    const details = await response.text();
    return {
      reasoning: fallbackReasoning,
      provider: {
        type: 'openrouter',
        error: details || response.statusText
      },
      debug: { ...baseDebug, model_request_payload: requestBody, fallback_used: true }
    };
  }

  const payload = await response.json();
  let parsed = parseModelJson(payload.choices?.[0]?.message?.content);
  let model = config.model;
  let modelResponse = payload;

  if (!parsed && config.fallbackModel) {
    const fallbackCall = await callOpenRouter(config, config.fallbackModel, requestPayload);
    model = config.fallbackModel;
    if (fallbackCall.response.ok) {
      modelResponse = await fallbackCall.response.json();
      parsed = parseModelJson(modelResponse.choices?.[0]?.message?.content);
    }
  }

  if (!parsed) {
    return {
      reasoning: fallbackReasoning,
      provider: {
        type: 'openrouter',
        error: 'OpenRouter returned non-JSON advisor reasoning.'
      },
      debug: {
        ...baseDebug,
        model,
        model_response_json: modelResponse,
        fallback_used: true
      }
    };
  }

  const reasoning = normalizeReasoning(parsed, fallbackReasoning, context);
  return {
    reasoning,
    provider: {
      type: 'openrouter',
      error: null,
      model
    },
      debug: {
        ...baseDebug,
        model,
        model_response_json: modelResponse,
        extracted_facts: reasoning.new_facts,
        normalized_facts: reasoning.new_facts,
        covered_fields: reasoning.covered_fields,
        resolved_gap_groups: reasoning.resolved_gap_groups,
        normalized_field_values: reasoning.normalized_field_values,
        missing_fields: reasoning.missing_fields,
        selected_next_question: reasoning.next_best_question,
        follow_up_count: reasoning.follow_up_count,
        target_follow_up_questions: reasoning.target_follow_up_questions,
        max_follow_up_questions: reasoning.max_follow_up_questions,
        stage_complete: reasoning.stage_complete,
        advisor_complete: reasoning.advisor_complete,
        patch_preview: reasoning.patch_preview
      }
    };
}

function persistAdvisorState(appointment, context, reasoning) {
  if (!appointment?.draft_state) return;
  const existing = currentAdvisorState(appointment, context);
  const knownFacts = mergeFacts([
    ...(existing.known_facts || []),
    ...collectKnownFacts(context),
    ...reasoning.new_facts
  ]);
  const askedQuestions = [...(existing.asked_questions || [])];
  const askedQuestionSignatures = [...(existing.asked_question_signatures || [])];
  const shouldRecordQuestion = reasoning.next_best_question && !isQuestionAlreadyAsked(reasoning.next_best_question, askedQuestions);
  if (reasoning.next_best_question && !isQuestionAlreadyAsked(reasoning.next_best_question, askedQuestions)) {
    askedQuestions.push(reasoning.next_best_question);
  }
  if (reasoning.selected_question_signature) {
    askedQuestionSignatures.push(reasoning.selected_question_signature);
  }
  const nextStage = reasoning.advisor_complete
    ? COMPLETED_STAGE
    : reasoning.stage_complete && STAGES[reasoning.stage]?.next
      ? STAGES[reasoning.stage].next
      : reasoning.stage;
  appointment.draft_state.advisor_state = {
    scope: context.advisor_context.screen_scope,
    patient_id: context.advisor_context.patient_id,
    current_stage: nextStage,
    initial_answer_captured: Boolean(existing.initial_answer_captured || reasoning.new_facts?.length || knownFacts.length),
    follow_up_count: shouldRecordQuestion
      ? Math.min(
          Number(existing.max_follow_up_questions || DEMO_FOLLOW_UP_POLICY.max),
          Number(existing.follow_up_count || 0) + 1
        )
      : Number(existing.follow_up_count || 0),
    target_follow_up_questions: Number(existing.target_follow_up_questions || DEMO_FOLLOW_UP_POLICY.target),
    max_follow_up_questions: Number(existing.max_follow_up_questions || DEMO_FOLLOW_UP_POLICY.max),
    resolved_gap_groups: uniquePhrases([
      ...(existing.resolved_gap_groups || []),
      ...(reasoning.resolved_gap_groups || [])
    ]),
    known_facts: knownFacts,
    normalized_facts: knownFacts,
    covered_fields: reasoning.covered_fields || knownFacts.map((fact) => fact.field),
    asked_questions: askedQuestions.slice(-20),
    asked_question_signatures: askedQuestionSignatures.slice(-20),
    last_reasoning: reasoning,
    stage_complete: reasoning.stage_complete,
    advisor_complete: reasoning.advisor_complete,
    completion_ready: reasoning.completion_ready,
    final_preview_ready: reasoning.final_preview_ready,
    ui: {
      visible: context.advisor_context.screen_scope === 'inspection'
        && (Boolean(compactText(reasoning.next_best_question)) || reasoning.advisor_complete),
      screen_scope: context.advisor_context.screen_scope,
      mode: reasoning.advisor_complete ? 'completed' : 'question',
      active_question: reasoning.advisor_complete ? '' : compactText(reasoning.next_best_question),
      completion_title: reasoning.completion_title || '',
      completion_message: reasoning.completion_message || '',
      advisor_complete: Boolean(reasoning.advisor_complete),
      stage: reasoning.advisor_complete ? COMPLETED_STAGE : reasoning.stage,
      stage_label: reasoning.advisor_complete ? '' : stageLabel(reasoning.stage),
      updated_at: nowIso()
    },
    updated_at: nowIso()
  };
  if (reasoning.should_patch_draft) {
    const advisorFacts = reasoning.new_facts.map((fact) => ({
      fact_id: `advisor-${Date.now()}-${fact.field}`,
      source_type: 'advisor_reasoning',
      speaker_tag: 'unknown',
      field_key: fact.field,
      normalized_value: fact.value,
      raw_evidence: fact.raw_evidence || fact.value,
      confidence: fact.confidence
    }));
    appointment.draft_state.fact_candidates = mergeDraftFactCandidates([
      ...(appointment.draft_state.fact_candidates || []),
      ...advisorFacts
    ]);
    appointment.draft_state.draft_patches = mergeAdvisorDraftPatches(
      appointment.draft_state.draft_patches || [],
      reasoning.patch_preview || []
    );
  }
}

function mergeAdvisorDraftPatches(existingPatches, incomingPatches) {
  const merged = new Map();
  for (const patch of existingPatches || []) {
    merged.set(patch.section_key || patch.field_key, patch);
  }
  for (const patch of incomingPatches || []) {
    merged.set(patch.section_key || patch.field_key, patch);
  }
  return [...merged.values()];
}

function mergeDraftFactCandidates(facts) {
  const byKey = new Map();
  for (const fact of facts) {
    const key = `${fact.source_type || ''}:${fact.field_key || ''}:${compactText(fact.normalized_value || fact.raw_evidence)}`;
    byKey.set(key, fact);
  }
  return [...byKey.values()].slice(-80);
}

export async function analyzeAdvisor(runtime, { appointmentId, question, screenContext = {} }) {
  const context = buildAdvisorContext(runtime, { appointmentId, question, screenContext });
  const fallbackReasoning = buildFallbackReasoning(context);
  const result = await analyzeWithOpenRouter(context, fallbackReasoning);
  const reasoning = normalizeReasoning(result.reasoning, fallbackReasoning, context);
  const appointment = context.advisor_context.appointment_id
    ? getAppointmentById(runtime, context.advisor_context.appointment_id)
    : null;
  persistAdvisorState(appointment, context, reasoning);
  return {
    answer: answerFromReasoning(reasoning, context),
    interview_reasoning: reasoning,
    advisor_context: context.advisor_context,
    advisor_debug: {
      ...result.debug,
      extracted_facts: reasoning.new_facts,
      normalized_facts: reasoning.new_facts,
      covered_fields: reasoning.covered_fields,
      resolved_gap_groups: reasoning.resolved_gap_groups,
      normalized_field_values: reasoning.normalized_field_values,
      missing_fields: reasoning.missing_fields,
      selected_next_question: reasoning.next_best_question,
      follow_up_count: reasoning.follow_up_count,
      target_follow_up_questions: reasoning.target_follow_up_questions,
      max_follow_up_questions: reasoning.max_follow_up_questions,
      stage_complete: reasoning.stage_complete,
      advisor_complete: reasoning.advisor_complete,
      patch_preview: reasoning.patch_preview
    },
    provider: result.provider
  };
}
