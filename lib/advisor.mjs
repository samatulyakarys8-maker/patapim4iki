import { getAppointmentById, getPatientById } from './agent.mjs';

const DEFAULT_NOTE = 'Это клиническая подсказка для врача. Финальное решение, диагноз и назначения принимает специалист.';

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function asList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item)).filter(Boolean).slice(0, 8);
}

function fieldLabel(fieldKey) {
  const labels = {
    tbmedicalfinal: 'Заключение',
    recommendations: 'Рекомендации',
    dynamics: 'Динамика развития',
    'work-plan': 'План работы',
    'planned-sessions': 'Планируемые занятия',
    'completed-sessions': 'Проведенные занятия'
  };
  return labels[fieldKey] || 'Поле формы';
}

function getOpenRouterConfig() {
  return {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
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
      confidence: chunk.confidence
    }))
    .filter((chunk) => chunk.text);
}

function draftFacts(appointment) {
  return (appointment?.draft_state?.fact_candidates || [])
    .slice(-12)
    .map((fact) => ({
      field: fact.field_key,
      value: compactText(fact.normalized_value || fact.raw_evidence),
      confidence: fact.confidence
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
    files: (tabs.files || []).map((item) => compactText(item.name)).filter(Boolean)
  };
}

function buildAdvisorContext(runtime, appointmentId, question, screenContext = {}) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) {
    throw new Error('Appointment not found for advisor analysis.');
  }
  const patient = getPatientById(runtime, appointment.patient_id);
  return {
    question: compactText(question),
    screen: screenContext?.screen_id === 'inspection' ? 'inspection' : 'unknown',
    patient: patient ? {
      patient_id: patient.patient_id,
      full_name: patient.full_name,
      birth_date: patient.birth_date,
      sex: patient.sex,
      specialty_track: patient.specialty_track,
      baseline_conclusion: patient.baseline_conclusion,
      summary: patient.summary,
      history_refs: patient.history_refs || []
    } : null,
    appointment: {
      appointment_id: appointment.appointment_id,
      status: appointment.status,
      conclusion_text: appointment.inspection_draft?.conclusion_text || '',
      supplemental: appointment.inspection_draft?.supplemental || {}
    },
    history: readonlySummary(appointment),
    transcript: recentTranscript(appointment),
    facts: draftFacts(appointment),
    form_guidance: formGuidanceFromPatches(appointment)
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
    missing_checks: ['Соберите жалобы, длительность симптомов, динамику, поведение, речь, внимание и понимание инструкции.'],
    cautions: ['Не формулировать диагноз до очной оценки и проверки ключевых признаков.']
  }];
}

function buildFallbackAnswer(context) {
  const hasTranscript = context.transcript.length > 0;
  const hasSuggestions = context.form_guidance.length > 0;
  return {
    summary: hasTranscript
      ? 'Я вижу текущий текст приема и могу подсказать следующий шаг, но LLM не подключен, поэтому использую безопасные базовые правила.'
      : 'LLM не подключен. Начните с жалоб, анамнеза и наблюдения за поведением пациента, затем добавьте транскрипт приема.',
    next_step: hasTranscript
      ? 'Уточните ведущую жалобу, длительность симптомов, динамику относительно прошлого приема и проверьте, совпадают ли наблюдения с историей пациента.'
      : 'Спросите о главной жалобе, начале симптомов, динамике, речи, внимании, понимании инструкции и поведении дома.',
    differential_hypotheses: fallbackHypotheses(context),
    questions_to_ask: [
      'Что изменилось с прошлого приема?',
      'Какие симптомы больше всего беспокоят сейчас?',
      'Как пациент понимает простую и двухэтапную инструкцию?',
      'Как долго удерживает внимание без подсказки?',
      'Есть ли изменения речи, контакта, сна, аппетита или поведения дома?'
    ],
    symptoms_to_check: [
      'Контакт и реакция на обращение',
      'Устойчивость внимания',
      'Понимание инструкции',
      'Речевая активность',
      'Память и обобщение',
      'Эмоционально-волевая сфера'
    ],
    form_guidance: hasSuggestions ? context.form_guidance : [{
      field_label: 'Заключение',
      suggestion: 'После уточнения жалоб кратко зафиксируйте ведущие наблюдения и динамику.',
      reason: 'Пока недостаточно надежных данных для автоматического предложения.'
    }],
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

function normalizeAdvisorAnswer(answer, fallback) {
  const source = answer && typeof answer === 'object' ? answer : {};
  return {
    summary: compactText(source.summary) || fallback.summary,
    next_step: compactText(source.next_step) || fallback.next_step,
    differential_hypotheses: Array.isArray(source.differential_hypotheses) && source.differential_hypotheses.length
      ? source.differential_hypotheses.slice(0, 5).map((item) => ({
          name: compactText(item.name) || 'Гипотеза для проверки',
          likelihood: ['low', 'medium', 'high'].includes(item.likelihood) ? item.likelihood : 'medium',
          supporting_signs: asList(item.supporting_signs),
          missing_checks: asList(item.missing_checks),
          cautions: asList(item.cautions)
        }))
      : fallback.differential_hypotheses,
    questions_to_ask: asList(source.questions_to_ask).length ? asList(source.questions_to_ask) : fallback.questions_to_ask,
    symptoms_to_check: asList(source.symptoms_to_check).length ? asList(source.symptoms_to_check) : fallback.symptoms_to_check,
    form_guidance: Array.isArray(source.form_guidance) && source.form_guidance.length
      ? source.form_guidance.slice(0, 6).map((item) => ({
          field_label: compactText(item.field_label) || 'Поле формы',
          suggestion: compactText(item.suggestion),
          reason: compactText(item.reason)
        })).filter((item) => item.suggestion)
      : fallback.form_guidance,
    red_flags: asList(source.red_flags).length ? asList(source.red_flags) : fallback.red_flags,
    doctor_note: compactText(source.doctor_note) || DEFAULT_NOTE
  };
}

async function analyzeWithOpenRouter(context, fallback) {
  const config = getOpenRouterConfig();
  if (!config.apiKey) {
    return {
      answer: fallback,
      provider: {
        type: 'heuristic',
        error: 'OPENROUTER_API_KEY is not configured on the local backend.'
      }
    };
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      next_step: { type: 'string' },
      differential_hypotheses: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            likelihood: { type: 'string', enum: ['low', 'medium', 'high'] },
            supporting_signs: { type: 'array', items: { type: 'string' } },
            missing_checks: { type: 'array', items: { type: 'string' } },
            cautions: { type: 'array', items: { type: 'string' } }
          },
          required: ['name', 'likelihood', 'supporting_signs', 'missing_checks', 'cautions']
        }
      },
      questions_to_ask: { type: 'array', items: { type: 'string' } },
      symptoms_to_check: { type: 'array', items: { type: 'string' } },
      form_guidance: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_label: { type: 'string' },
            suggestion: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['field_label', 'suggestion', 'reason']
        }
      },
      red_flags: { type: 'array', items: { type: 'string' } },
      doctor_note: { type: 'string' }
    },
    required: [
      'summary',
      'next_step',
      'differential_hypotheses',
      'questions_to_ask',
      'symptoms_to_check',
      'form_guidance',
      'red_flags',
      'doctor_note'
    ]
  };

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.appReferer,
      'X-Title': config.appTitle
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'damumed_advisor_response',
          strict: true,
          schema
        }
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a clinical decision support assistant for a doctor in a local Damumed sandbox.',
            'Answer in Russian. Help step by step during patient intake.',
            'Never claim a final diagnosis. Use differential hypotheses and verification steps.',
            'Do not output DOM selectors, code, JSON explanations, patches, or implementation details.',
            'Use only the supplied patient context. If evidence is weak, say what must be checked.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            doctor_question: context.question,
            patient_context: context
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    return {
      answer: fallback,
      provider: {
        type: 'openrouter',
        error: details || response.statusText
      }
    };
  }

  const payload = await response.json();
  const parsed = parseModelJson(payload.choices?.[0]?.message?.content);
  if (!parsed) {
    return {
      answer: fallback,
      provider: {
        type: 'openrouter',
        error: 'OpenRouter returned non-JSON advisor content.'
      }
    };
  }

  return {
    answer: normalizeAdvisorAnswer(parsed, fallback),
    provider: {
      type: 'openrouter',
      error: null
    }
  };
}

export async function analyzeAdvisor(runtime, { appointmentId, question, screenContext = {} }) {
  const context = buildAdvisorContext(runtime, appointmentId, question, screenContext);
  const fallback = buildFallbackAnswer(context);
  const result = await analyzeWithOpenRouter(context, fallback);
  return {
    answer: result.answer,
    provider: result.provider
  };
}
