import {
  parseVoiceCommand,
  resolvePatientQuery
} from './command-router.mjs';
import {
  buildVoiceLexicon,
  loadVoiceLexiconFromDisk
} from './voice-lexicon.mjs';

function normalizeText(input) {
  return String(input || '').toLowerCase().trim();
}

function normalizeSearchText(input) {
  return normalizeText(input)
    .replace(/[.,:;!?()"«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelOf(item) {
  return typeof item === 'string' ? item : item?.label || '';
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function voiceLexiconForRuntime(runtime = null) {
  if (runtime?.voiceLexicon) return runtime.voiceLexicon;
  if (runtime?.patients) {
    runtime.voiceLexicon = buildVoiceLexicon({ patients: runtime.patients });
    return runtime.voiceLexicon;
  }
  return loadVoiceLexiconFromDisk();
}

export function getDeepgramRealtimeConfig(apiKey = process.env.DEEPGRAM_API_KEY || '') {
  const lexicon = loadVoiceLexiconFromDisk();
  const keyterms = lexicon.keyterms || [];
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    language: process.env.DEEPGRAM_LANGUAGE || 'multi',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: process.env.DEEPGRAM_ENDPOINTING || '300',
    utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS || '1000',
    vad_events: 'true',
    diarize: 'true'
  });
  for (const keyterm of keyterms) {
    params.append('keyterm', keyterm);
  }
  return {
    provider: 'deepgram',
    apiKeyConfigured: Boolean(apiKey),
    apiKey,
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    language: process.env.DEEPGRAM_LANGUAGE || 'multi',
    url: `wss://api.deepgram.com/v1/listen?${params.toString()}`,
    keyterms
  };
}

function speakerWeight(fieldKey, speakerTag) {
  const doctorFields = new Set(['tbmedicalfinal', 'recommendations', 'dynamics', 'work-plan']);
  const caregiverFields = new Set(['dynamics', 'planned-sessions', 'completed-sessions']);
  const patientFields = new Set(['tbmedicalfinal']);

  if (speakerTag === 'doctor' && doctorFields.has(fieldKey)) return 0.12;
  if (speakerTag === 'caregiver' && caregiverFields.has(fieldKey)) return 0.1;
  if (speakerTag === 'patient' && patientFields.has(fieldKey)) return 0.08;
  if (speakerTag === 'unknown') return -0.08;
  return 0;
}

function makeIntent(type, screenId, targetEntity, argumentsPayload = {}) {
  return {
    intent_id: makeId(type),
    type,
    screen_id: screenId,
    target_entity: targetEntity,
    arguments: argumentsPayload,
    requires_preview: true,
    safe_to_apply: true
  };
}

export function inferScreenId(screenContext) {
  if (screenContext?.screen_id) return screenContext.screen_id;
  if (screenContext?.visible_actions?.some((action) => /сохранить/i.test(labelOf(action)))) return 'inspection';
  return 'schedule';
}

export function getAppointmentById(runtime, appointmentId) {
  return runtime.appointments[appointmentId] || null;
}

export function getPatientById(runtime, patientId) {
  return runtime.patients.find((patient) => patient.patient_id === patientId) || null;
}

export function searchPatients(runtime, query) {
  const normalized = normalizeText(query);
  if (!normalized) return runtime.patients;
  return runtime.patients.filter((patient) => {
    return normalizeText(patient.full_name).includes(normalized) || String(patient.iin_or_local_id).includes(normalized);
  });
}

function buildSectionPatch(section, values, provenance = 'transcript_chunk', confidence = 0.78) {
  return {
    patch_id: makeId(section.section_key),
    section_key: section.section_key,
    field_key: section.section_key,
    title: section.title,
    value_type: section.kind,
    value: section.kind === 'checkbox-group' ? values : compactText(values),
    provenance,
    confidence,
    status: 'suggested'
  };
}

function buildFieldPatch(fieldKey, value, provenance, confidence) {
  return {
    patch_id: makeId(fieldKey),
    field_key: fieldKey,
    value_type: 'text',
    value: compactText(value),
    provenance,
    confidence,
    status: 'suggested'
  };
}

function optionMatch(optionLabel, text) {
  const raw = normalizeText(optionLabel)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return raw && normalizeText(text).includes(raw);
}

function findSection(appointment, pattern) {
  return appointment.inspection_draft.medical_record_sections.find((section) => pattern.test(normalizeText(section.title)));
}

function inferStructuredSectionPatches(appointment, text, speakerTag) {
  const lower = normalizeText(text);
  const sections = appointment.inspection_draft.medical_record_sections;
  const patches = [];

  for (const section of sections) {
    if (section.kind !== 'checkbox-group') continue;
    const matchedOptions = section.options.filter((option) => optionMatch(option.label, lower));
    if (matchedOptions.length) {
      patches.push(buildSectionPatch(section, matchedOptions.map((option) => option.option_key), 'transcript_chunk', 0.72 + speakerWeight(section.section_key, speakerTag)));
    }
  }

  const contactSection = findSection(appointment, /контакт|қарым/);
  if (contactSection) {
    if (/не вступает в контакт|контакт не устанавливает/.test(lower)) {
      const option = contactSection.options.find((item) => /не вступает/i.test(item.label));
      if (option) patches.push(buildSectionPatch(contactSection, [option.option_key], 'transcript_chunk', 0.86));
    } else if (/контакт с трудом|не сразу вступает|контакт затруднен/.test(lower)) {
      const option = contactSection.options.find((item) => /не сразу|с трудом/i.test(item.label));
      if (option) patches.push(buildSectionPatch(contactSection, [option.option_key], 'transcript_chunk', 0.84));
    } else if (/контакт установлен|устанавливает контакт|идет на контакт/.test(lower)) {
      const option = contactSection.options.find((item) => /устанавливает контакт/i.test(item.label));
      if (option) patches.push(buildSectionPatch(contactSection, [option.option_key], 'transcript_chunk', 0.86));
    }
  }

  const attentionSection = findSection(appointment, /внимани|зейін/);
  if (attentionSection) {
    if (/низк.*концентрац|не удерживает внимание/.test(lower)) {
      const option = attentionSection.options.find((item) => /низкая концентрация/i.test(item.label));
      if (option) patches.push(buildSectionPatch(attentionSection, [option.option_key], 'transcript_chunk', 0.84));
    } else if (/внимание неустойчив|поверхностн|быстро устает/.test(lower)) {
      const option = attentionSection.options.find((item) => /недостаточно устойчив/i.test(item.label));
      if (option) patches.push(buildSectionPatch(attentionSection, [option.option_key], 'transcript_chunk', 0.84));
    } else if (/внимание устойчив|достаточно устойчив/.test(lower)) {
      const option = attentionSection.options.find((item) => /достаточно устойчив/i.test(item.label));
      if (option) patches.push(buildSectionPatch(attentionSection, [option.option_key], 'transcript_chunk', 0.84));
    }
  }

  const memorySection = findSection(appointment, /памят|есте/);
  if (memorySection) {
    if (/память сниж|забывчив/.test(lower)) {
      const option = memorySection.options.find((item) => /снижена/i.test(item.label));
      if (option) patches.push(buildSectionPatch(memorySection, [option.option_key], 'transcript_chunk', 0.82));
    } else if (/память в норме|возрастной норм/.test(lower)) {
      const option = memorySection.options.find((item) => /возрастной нормы/i.test(item.label));
      if (option) patches.push(buildSectionPatch(memorySection, [option.option_key], 'transcript_chunk', 0.82));
    }
  }

  const speechSection = findSection(appointment, /речевая|сөйлеу/);
  if (speechSection) {
    if (/речь отсутствует/.test(lower)) {
      const option = speechSection.options.find((item) => /отсутствует/i.test(item.label));
      if (option) patches.push(buildSectionPatch(speechSection, [option.option_key], 'transcript_chunk', 0.82));
    } else if (/речь наруш|нарушена речь/.test(lower)) {
      const option = speechSection.options.find((item) => /нарушена/i.test(item.label));
      if (option) patches.push(buildSectionPatch(speechSection, [option.option_key], 'transcript_chunk', 0.82));
    } else if (/речь в норме/.test(lower)) {
      const option = speechSection.options.find((item) => /норма/i.test(item.label));
      if (option) patches.push(buildSectionPatch(speechSection, [option.option_key], 'transcript_chunk', 0.82));
    }
  }

  const deduped = new Map();
  for (const patch of patches) {
    const key = patch.section_key || patch.field_key;
    const current = deduped.get(key);
    if (!current || current.confidence <= patch.confidence) {
      deduped.set(key, patch);
    }
  }
  return [...deduped.values()];
}

function inferFactCandidates(appointment, text, speakerTag) {
  const lower = normalizeText(text);
  const facts = [];

  if (/рекомен|совет|домашн|продолжить занятия|продолжить индивидуальные/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-recommendations'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'recommendations',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.76 + speakerWeight('recommendations', speakerTag)
    });
  }

  if (/динами|улучш|лучше|положительная|отрицательная/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-dynamics'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'dynamics',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.74 + speakerWeight('dynamics', speakerTag)
    });
  }

  if (/план|продолжить занятия|работать над|коррекц|трениров/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-work-plan'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'work-plan',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.72 + speakerWeight('work-plan', speakerTag)
    });
  }

  const plannedMatch = lower.match(/план(?:ируется|ируем|иру).*?(\d+)\s*(занят|сеанс)/i) || lower.match(/(\d+)\s*(занят|сеанс).{0,20}план/i);
  if (plannedMatch) {
    facts.push({
      fact_id: makeId('fact-planned-sessions'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'planned-sessions',
      normalized_value: plannedMatch[1],
      raw_evidence: text,
      confidence: 0.8
    });
  }

  const completedMatch = lower.match(/провед(?:ено|енных|ено занятий).*?(\d+)/i) || lower.match(/(\d+)\s*(занят|сеанс).{0,20}провед/i);
  if (completedMatch) {
    facts.push({
      fact_id: makeId('fact-completed-sessions'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'completed-sessions',
      normalized_value: completedMatch[1],
      raw_evidence: text,
      confidence: 0.8
    });
  }

  if (/заключ|уровень|наруш|состояние|контакт|внимание|память|мышлен|речь/.test(lower)) {
    facts.push({
      fact_id: makeId('fact-conclusion'),
      source_type: 'transcript_chunk',
      speaker_tag: speakerTag,
      field_key: 'tbmedicalfinal',
      normalized_value: compactText(text),
      raw_evidence: text,
      confidence: 0.78 + speakerWeight('tbmedicalfinal', speakerTag)
    });
  }

  return facts;
}

function factToPatch(fact) {
  return {
    patch_id: makeId(fact.field_key),
    field_key: fact.field_key,
    value_type: 'text',
    value: fact.normalized_value,
    provenance: fact.source_type,
    confidence: fact.confidence,
    status: 'suggested'
  };
}

function sectionPatchFromModel(appointment, modelPatch) {
  const section = appointment.inspection_draft.medical_record_sections.find((item) => item.section_key === modelPatch.section_key || item.section_key === modelPatch.field_key);
  if (!section || section.kind !== 'checkbox-group') return null;
  const allowed = new Set(section.options.map((option) => option.option_key));
  const values = Array.isArray(modelPatch.value)
    ? modelPatch.value.filter((value) => allowed.has(value))
    : [];
  if (!values.length) return null;
  return {
    patch_id: makeId(section.section_key),
    field_key: section.section_key,
    section_key: section.section_key,
    title: section.title,
    value_type: 'checkbox-group',
    value: values,
    provenance: 'openrouter_parser',
    confidence: Number(modelPatch.confidence || 0.76),
    status: 'suggested'
  };
}

function textPatchFromModel(modelPatch, allowedTextFields) {
  if (!allowedTextFields.has(modelPatch.field_key)) return null;
  const value = compactText(modelPatch.value);
  if (!value) return null;
  return {
    patch_id: makeId(modelPatch.field_key),
    field_key: modelPatch.field_key,
    value_type: 'text',
    value,
    provenance: 'openrouter_parser',
    confidence: Number(modelPatch.confidence || 0.78),
    status: 'suggested'
  };
}

function buildAllowedFieldContext(appointment) {
  const textFields = [
    { field_key: 'tbmedicalfinal', label: 'Заключение' },
    { field_key: 'recommendations', label: 'Рекомендации' },
    { field_key: 'dynamics', label: 'Динамика развития' },
    { field_key: 'work-plan', label: 'План работы' },
    { field_key: 'planned-sessions', label: 'Количество планируемых занятий' },
    { field_key: 'completed-sessions', label: 'Количество проведенных занятий' }
  ];
  const checkboxSections = appointment.inspection_draft.medical_record_sections
    .filter((section) => section.kind === 'checkbox-group')
    .map((section) => ({
      section_key: section.section_key,
      title: section.title,
      options: section.options.map((option) => ({
        option_key: option.option_key,
        label: option.label
      }))
    }));
  return { textFields, checkboxSections };
}

function parseModelJson(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeActionTarget(target) {
  const normalized = normalizeSearchText(target).replace(/_/g, '-');
  const aliases = {
    medicalrecords: 'medical-records',
    'medical-records': 'medical-records',
    records: 'medical-records',
    assignments: 'assignments',
    procedures: 'assignments',
    diaries: 'diaries',
    diagnoses: 'diagnoses',
    files: 'files',
    auditlog: 'audit-log',
    'audit-log': 'audit-log',
    dischargesummary: 'discharge-summary',
    'discharge-summary': 'discharge-summary',
    epicrisis: 'discharge-summary',
    save: 'save',
    'save-and-close': 'save-and-close',
    completed: 'completed',
    'procedure-schedule': 'procedure-schedule',
    patient: 'patient'
  };
  return aliases[normalized.replace(/-/g, '')] || aliases[normalized] || normalized || null;
}

function commandResultFromModel(command, parsed, fallbackReason = null) {
  const allowedIntents = new Set(['open_tab', 'open_patient', 'go_to_section', 'generate_schedule', 'complete_service', 'save_record', 'return_to_schedule', 'unknown']);
  const intent = allowedIntents.has(parsed?.intent) ? parsed.intent : 'unknown';
  const normalizedIntent = intent === 'go_to_section' ? 'open_tab' : intent;
  const actionTarget = normalizeActionTarget(parsed?.actionTarget || parsed?.target || '');
  const patientQuery = compactText(parsed?.patientQuery || '');
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence || 0.62)));
  return {
    intent: normalizedIntent,
    patientQuery: patientQuery || null,
    matchedPatient: null,
    confidence,
    actionTarget,
    needsLlmFallback: normalizedIntent === 'unknown',
    fallbackReason: normalizedIntent === 'unknown' ? (fallbackReason || 'llm_intent_not_found') : null,
    debug: {
      transcript: String(command || ''),
      normalizedTranscript: normalizeSearchText(command),
      parsedCommand: normalizedIntent,
      extractedPatientQuery: patientQuery || null,
      matchedSynonym: parsed?.reason || 'openrouter_command_parser',
      provider: 'openrouter_command_parser'
    }
  };
}

async function inferOpenRouterCommand(runtime, { command, screenContext = {}, deterministicResult = null }) {
  const config = getOpenRouterConfig();
  if (!config.apiKey || !compactText(command)) return null;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: {
        type: 'string',
        enum: ['open_tab', 'open_patient', 'go_to_section', 'generate_schedule', 'complete_service', 'save_record', 'return_to_schedule', 'unknown']
      },
      patientQuery: { type: 'string' },
      actionTarget: {
        type: 'string',
        enum: ['medical-records', 'assignments', 'diaries', 'diagnoses', 'files', 'audit-log', 'discharge-summary', 'patient', 'procedure-schedule', 'completed', 'save', 'save-and-close', 'schedule', '']
      },
      confidence: { type: 'number' },
      reason: { type: 'string' }
    },
    required: ['intent', 'patientQuery', 'actionTarget', 'confidence', 'reason']
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
      temperature: 0.05,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'damumed_voice_command',
          strict: true,
          schema
        }
      },
      messages: [
        {
          role: 'system',
          content: [
            'You parse Russian/Kazakh doctor voice commands for a Damumed-like Chrome extension.',
            'Return JSON only. Never return DOM selectors, JavaScript, HTML, or prose.',
            'Choose one intent. For tab navigation use open_tab and one allowed actionTarget.',
            'For patient opening, use open_patient and put only the patient name/query in patientQuery.',
            'If the doctor says epikriz/vypiska, use actionTarget discharge-summary.',
            'If command is not a UI/navigation/save/schedule command, use unknown.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            transcript: command,
            current_screen: screenContext?.screen_id || 'unknown',
            visible_tabs: (screenContext?.visible_tabs || []).map((tab) => tab.label || tab.tab_key),
            visible_actions: (screenContext?.visible_actions || []).map((action) => action.label),
            selected_patient_name: screenContext?.selected_patient_name || null,
            patients: runtime.patients.map((patient) => ({
              patient_id: patient.patient_id,
              full_name: patient.full_name,
              iin_or_local_id: patient.iin_or_local_id
            })),
            deterministic_result: deterministicResult
          })
        }
      ]
    })
  });

  if (!response.ok) return null;
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || '';
  const parsed = parseModelJson(content);
  if (!parsed) return null;
  return commandResultFromModel(command, parsed);
}

async function inferOpenRouterPatches(appointment, patient, text, speakerTag) {
  const config = getOpenRouterConfig();
  if (!config.apiKey) {
    return { patches: [], facts: [], provider: 'heuristic', error: null };
  }

  const allowed = buildAllowedFieldContext(appointment);
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_key: { type: 'string' },
            normalized_value: { type: 'string' },
            raw_evidence: { type: 'string' },
            confidence: { type: 'number' }
          },
          required: ['field_key', 'normalized_value', 'raw_evidence', 'confidence']
        }
      },
      patches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field_key: { type: 'string' },
            section_key: { type: 'string' },
            value_type: { type: 'string', enum: ['text', 'checkbox-group'] },
            value: {
              anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ]
            },
            confidence: { type: 'number' }
          },
            required: ['field_key', 'section_key', 'value_type', 'value', 'confidence']
        }
      }
    },
    required: ['facts', 'patches']
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
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'damumed_transcript_patches',
          strict: true,
          schema
        }
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a medical form extraction layer for a local Damumed sandbox.',
            'Return JSON only. Never return DOM selectors, HTML, code, markdown, or unknown fields.',
            'Use only allowed field_key, section_key, and option_key values from the provided schema.',
            'For text fields set section_key to an empty string. For checkbox groups set section_key to the selected section_key.',
            'If a fact is uncertain, omit it or lower confidence. Do not invent patient data.',
            'Keep source language as Russian/Kazakh when present.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Extract transcript facts into safe draft patches for preview only.',
            patient: {
              patient_id: patient?.patient_id,
              full_name: patient?.full_name,
              birth_date: patient?.birth_date,
              specialty_track: patient?.specialty_track
            },
            speaker_tag: speakerTag,
            transcript: text,
            allowed_fields: allowed.textFields,
            allowed_checkbox_sections: allowed.checkboxSections
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    return { patches: [], facts: [], provider: 'openrouter', error: details || response.statusText };
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || '';
  const parsed = parseModelJson(content);
  if (!parsed) {
    return { patches: [], facts: [], provider: 'openrouter', error: 'OpenRouter returned non-JSON content.' };
  }

  const allowedTextFields = new Set(allowed.textFields.map((field) => field.field_key));
  const patches = [];
  for (const modelPatch of parsed.patches || []) {
    const patch = modelPatch.value_type === 'checkbox-group'
      ? sectionPatchFromModel(appointment, modelPatch)
      : textPatchFromModel(modelPatch, allowedTextFields);
    if (patch) patches.push(patch);
  }

  const facts = (parsed.facts || [])
    .filter((fact) => allowedTextFields.has(fact.field_key) || appointment.inspection_draft.medical_record_sections.some((section) => section.section_key === fact.field_key))
    .map((fact) => ({
      fact_id: makeId(`fact-${fact.field_key}`),
      source_type: 'openrouter_parser',
      speaker_tag: speakerTag,
      field_key: fact.field_key,
      normalized_value: compactText(fact.normalized_value),
      raw_evidence: compactText(fact.raw_evidence),
      confidence: Number(fact.confidence || 0.76)
    }));

  return { patches, facts, provider: 'openrouter', error: null };
}

function mergeDraftPatches(existingPatches, incomingPatches) {
  const merged = new Map();
  for (const patch of existingPatches) {
    merged.set(patch.section_key || patch.field_key, clone(patch));
  }
  for (const patch of incomingPatches) {
    const key = patch.section_key || patch.field_key;
    const previous = merged.get(key);
    if (!previous || previous.confidence <= patch.confidence) {
      merged.set(key, clone(patch));
    }
  }
  return [...merged.values()];
}

function buildPreviewFromDraftState(runtime, appointmentId) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  const patches = appointment.draft_state.draft_patches || [];
  return {
    intent: makeIntent('preview_changes', 'inspection', appointmentId, {}),
    patches,
    domOperations: patchesToDomOperations(patches),
    explanation: patches.length
      ? 'Черновик подготовлен из накопленного транскрипта. Можно применить его в форму.'
      : 'Черновик пока пустой: явных полей из транскрипта не найдено.',
    hints: buildHints(runtime, { screen_id: 'inspection', selected_appointment_id: appointmentId })
  };
}

function findVisibleTarget(screenContext, labelPattern) {
  const targets = [
    ...(screenContext?.visible_tabs || []),
    ...(screenContext?.visible_links || []),
    ...(screenContext?.visible_actions || []),
    ...(screenContext?.visible_documents || [])
  ];
  return targets.find((target) => labelPattern.test(normalizeSearchText(target.label || target.normalized_label)));
}

function activeScheduleSlot(runtime, appointmentId = null) {
  const currentDay = runtime.scheduleDays.find((day) => day.date === runtime.currentDate) || runtime.scheduleDays[0];
  if (!currentDay) return null;
  if (appointmentId) {
    return currentDay.slots.find((slot) => slot.appointment_id === appointmentId) || null;
  }
  return currentDay.slots.find((slot) => slot.status === 'scheduled') || currentDay.slots[0] || null;
}

function findPatientFromCommand(runtime, command) {
  const normalized = normalizeSearchText(command);
  const scored = runtime.patients
    .map((patient) => {
      const name = normalizeSearchText(patient.full_name);
      const tokens = name.split(' ').filter((token) => token.length >= 3);
      const score = tokens.filter((token) => normalized.includes(token)).length;
      return { patient, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.patient || null;
}

function findSlotForPatient(runtime, patientId) {
  const currentDay = runtime.scheduleDays.find((day) => day.date === runtime.currentDate) || runtime.scheduleDays[0];
  return currentDay?.slots.find((slot) => slot.patient_id === patientId)
    || runtime.scheduleDays.flatMap((day) => day.slots).find((slot) => slot.patient_id === patientId)
    || null;
}

function makeNavigationPreview({ runtime, screenContext, type, targetEntity = null, operations = [], explanation, fallbackMessage = null }) {
  const screenId = inferScreenId(screenContext);
  return {
    intent: {
      ...makeIntent(type, screenId, targetEntity, {}),
      confidence: fallbackMessage ? 0.42 : 0.88,
      requires_confirmation: false
    },
    patches: [],
    domOperations: operations,
    explanation: fallbackMessage || explanation,
    dom_proof: operations.map((operation) => ({
      operation: operation.type,
      selector: operation.selector || '',
      label: operation.label || operation.title || '',
      reason: operation.reason || ''
    })),
    hints: buildHints(runtime, screenContext)
  };
}

function switchTabPreview(runtime, screenContext, intentType, tabKey, label, fallbackPattern) {
  const visibleTarget = findVisibleTarget(screenContext, fallbackPattern);
  const selector = visibleTarget?.selector || `[data-action="switch-tab"][data-tab="${tabKey}"]`;
  return makeNavigationPreview({
    runtime,
    screenContext,
    type: intentType,
    operations: [{
      type: 'switch-tab',
      tab_key: tabKey,
      selector,
      label,
      reason: `Voice navigation target: ${label}`
    }],
    explanation: `DOM найден: "${label}". Агент переключит вкладку через selector ${selector}.`
  });
}

function scheduleToInspectionPreview(runtime, screenContext, { slot, type, label, tabKey = null }) {
  const patient = getPatientById(runtime, slot.patient_id);
  const operations = tabKey
    ? [{
        type: 'open-appointment-tab',
        appointment_id: slot.appointment_id,
        hash: `#/inspection/${slot.appointment_id}`,
        tab_key: tabKey,
        selector: `[data-action="switch-tab"][data-tab="${tabKey}"]`,
        wait_for_selector: '#frmInspectionResult',
        label,
        reason: `Open appointment and switch to ${label}`
      }]
    : [{
        type: 'navigate-hash',
        hash: `#/inspection/${slot.appointment_id}`,
        wait_for_selector: '#frmInspectionResult',
        reason: 'Open appointment via route hash'
      }];

  return makeNavigationPreview({
    runtime,
    screenContext,
    type,
    targetEntity: slot.appointment_id,
    operations,
    explanation: tabKey
      ? `Открою запись пациента ${patient?.full_name || slot.patient_id} и перейду в раздел "${label}".`
      : `Открою запись пациента ${patient?.full_name || slot.patient_id}.`
  });
}

const TAB_TARGETS = {
  'medical-records': { intent: 'open_medical_records', tabKey: 'medicalRecords', label: 'Медицинские записи' },
  assignments: { intent: 'open_assignments', tabKey: 'assignments', label: 'Назначения' },
  diaries: { intent: 'open_diaries', tabKey: 'diaries', label: 'Дневниковые записи' },
  diagnoses: { intent: 'open_diagnoses', tabKey: 'diagnoses', label: 'Диагнозы' },
  files: { intent: 'open_files', tabKey: 'files', label: 'Файлы' },
  'discharge-summary': { intent: 'open_discharge_summary', tabKey: 'dischargeSummary', label: 'Выписной эпикриз' }
};

function attachCommandResult(preview, commandResult, extras = {}) {
  const actionPlan = {
    intent: commandResult.intent,
    actionTarget: commandResult.actionTarget,
    patientQuery: commandResult.patientQuery,
    matchedPatient: commandResult.matchedPatient || extras.matchedPatient || null,
    operations: preview.domOperations || [],
    ...extras.actionPlan
  };
  return {
    ...preview,
    commandResult: {
      ...commandResult,
      matchedPatient: commandResult.matchedPatient || extras.matchedPatient || null,
      matchCandidates: extras.matchCandidates || []
    },
    actionPlan
  };
}

function noOpCommandPreview(runtime, screenContext, commandResult, explanation) {
  return attachCommandResult({
    intent: {
      ...makeIntent(commandResult.intent || 'unknown', inferScreenId(screenContext), null, {}),
      confidence: commandResult.confidence || 0,
      requires_confirmation: true
    },
    patches: [],
    domOperations: [],
    explanation,
    dom_proof: [],
    hints: buildHints(runtime, screenContext)
  }, commandResult);
}

function confidenceThresholdFor(commandResult) {
  if (commandResult.intent === 'open_patient') return 0.84;
  if (commandResult.intent === 'save_record' || commandResult.intent === 'complete_service') return 0.9;
  if (commandResult.intent === 'generate_schedule') return 0.8;
  if (commandResult.intent === 'open_tab' || commandResult.intent === 'return_to_schedule') return 0.78;
  return 0.6;
}

function confidenceGate(runtime, screenContext, commandResult) {
  const threshold = confidenceThresholdFor(commandResult);
  if ((commandResult.confidence || 0) >= threshold) return null;
  return noOpCommandPreview(runtime, screenContext, {
    ...commandResult,
    needsLlmFallback: commandResult.intent === 'unknown',
    fallbackReason: 'low_confidence',
    confidenceThreshold: threshold
  }, `Команда заблокирована: confidence ${commandResult.confidence || 0} ниже порога ${threshold}.`);
}

function previewFromCommandRouter({ command, runtime, screenContext, commandResult = null }) {
  const lexicon = voiceLexiconForRuntime(runtime);
  commandResult ||= parseVoiceCommand(command, { lexicon });
  const screenId = inferScreenId(screenContext);
  if (commandResult.intent === 'unknown') return null;
  const blockedByConfidence = confidenceGate(runtime, screenContext, commandResult);
  if (blockedByConfidence && commandResult.intent !== 'open_patient') return blockedByConfidence;

  if (commandResult.intent === 'open_tab') {
    const target = TAB_TARGETS[commandResult.actionTarget];
    if (!target) {
      return noOpCommandPreview(runtime, screenContext, {
        ...commandResult,
        needsLlmFallback: true,
        fallbackReason: 'unsupported_tab_target'
      }, `Target "${commandResult.actionTarget}" is not registered.`);
    }
    if (screenId === 'schedule') {
      const slot = activeScheduleSlot(runtime);
      if (!slot) {
        return noOpCommandPreview(runtime, screenContext, {
          ...commandResult,
          needsLlmFallback: true,
          fallbackReason: 'appointment_not_found'
        }, 'Не нашел запись пациента для открытия вкладки.');
      }
      return attachCommandResult(scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: target.intent,
        label: target.label,
        tabKey: target.tabKey
      }), commandResult);
    }
    return attachCommandResult(
      switchTabPreview(runtime, screenContext, target.intent, target.tabKey, target.label, new RegExp(target.label, 'i')),
      commandResult
    );
  }

  if (commandResult.intent === 'return_to_schedule') {
    return attachCommandResult(makeNavigationPreview({
      runtime,
      screenContext,
      type: 'return_to_schedule',
      operations: [{ type: 'navigate-to-schedule', wait_for_selector: '#schedule', reason: 'Voice command returned to schedule' }],
      explanation: 'Вернусь в расписание через DOM route.'
    }), commandResult);
  }

  if (commandResult.intent === 'open_patient') {
    if (!commandResult.patientQuery) return null;
    const resolution = resolvePatientQuery(commandResult.patientQuery, runtime.patients, { lexicon, screenContext, runtime });
    const resolvedCommand = {
      ...commandResult,
      matchedPatient: resolution.matchedPatient,
      confidence: resolution.confidence,
      needsLlmFallback: resolution.status !== 'matched',
      fallbackReason: resolution.status === 'matched' ? null : `patient_${resolution.status}`
    };
    const patientConfidenceBlock = confidenceGate(runtime, screenContext, resolvedCommand);
    if (patientConfidenceBlock && resolution.status === 'matched') return patientConfidenceBlock;
    if (resolution.status !== 'matched') {
      return attachCommandResult(
        noOpCommandPreview(runtime, screenContext, resolvedCommand, `Пациент не выбран: ${resolution.status}.`),
        resolvedCommand,
        { matchCandidates: resolution.candidates }
      );
    }
    const slot = findSlotForPatient(runtime, resolution.matchedPatient.patient_id);
    if (!slot) {
      return attachCommandResult(
        noOpCommandPreview(runtime, screenContext, {
          ...resolvedCommand,
          needsLlmFallback: true,
          fallbackReason: 'patient_slot_not_found'
        }, 'Пациент найден, но запись в расписании не найдена.'),
        resolvedCommand,
        { matchedPatient: resolution.matchedPatient, matchCandidates: resolution.candidates }
      );
    }
    return attachCommandResult(scheduleToInspectionPreview(runtime, screenContext, {
      slot,
      type: 'open_patient',
      label: 'Назначение'
    }), resolvedCommand, {
      matchedPatient: resolution.matchedPatient,
      matchCandidates: resolution.candidates
    });
  }

  if (commandResult.intent === 'save_record') {
    const appointment = getAppointmentById(runtime, screenContext?.selected_appointment_id);
    if (!appointment) {
      return noOpCommandPreview(runtime, screenContext, {
        ...commandResult,
        needsLlmFallback: false,
        fallbackReason: 'appointment_not_open'
      }, 'Сохранение доступно только на открытой форме назначения.');
    }
    const selector = commandResult.actionTarget === 'save-and-close' ? '#btnSaveAndCloseInspectionResult' : '#btnSaveInspectionResult';
    const label = commandResult.actionTarget === 'save-and-close' ? 'Сохранить и закрыть' : 'Сохранить';
    return attachCommandResult(makeNavigationPreview({
      runtime,
      screenContext,
      type: 'save_record',
      targetEntity: appointment.appointment_id,
      operations: [{ type: 'click', selector, label, reason: 'Deterministic save command' }],
      explanation: `Подготовлен click по кнопке "${label}".`
    }), commandResult);
  }

  if (commandResult.intent === 'generate_schedule' || commandResult.intent === 'complete_service') {
    return attachCommandResult(makeNavigationPreview({
      runtime,
      screenContext,
      type: commandResult.intent,
      targetEntity: screenContext?.selected_appointment_id || null,
      operations: [],
      explanation: commandResult.intent === 'generate_schedule'
        ? 'Команда распознана как формирование расписания процедур.'
        : 'Команда распознана как отметка процедуры выполненной.'
    }), commandResult);
  }

  return null;
}

export function patchesToDomOperations(patches) {
  const operations = [];
  for (const patch of patches) {
    switch (patch.field_key) {
      case 'dtpserviceexecutedate':
        operations.push({ type: 'set-value', selector: '#dtpServiceExecuteDate', value: patch.value });
        break;
      case 'dtpserviceexecutetime':
        operations.push({ type: 'set-value', selector: '#dtpServiceExecuteTime', value: patch.value });
        break;
      case 'ntbdurationminute':
        operations.push({ type: 'set-value', selector: '#ntbDurationMinute', value: String(patch.value) });
        break;
      case 'cmbmedicalform':
        operations.push({ type: 'set-value', selector: '#cmbMedicalForm', value: patch.value });
        break;
      case 'cmbperformerservice':
        operations.push({ type: 'set-value', selector: '#cmbPerformerService', value: patch.value });
        break;
      case 'cmbperformerservicemo':
        operations.push({ type: 'set-value', selector: '#cmbPerformerServiceMo', value: patch.value });
        break;
      case 'tbmedicalfinal':
        operations.push({ type: 'set-value', selector: '#tbMedicalFinal', value: patch.value });
        break;
      case 'work-plan':
        operations.push({ type: 'set-value', selector: '#supp-workPlan', value: patch.value });
        break;
      case 'planned-sessions':
        operations.push({ type: 'set-value', selector: '#supp-plannedSessions', value: patch.value });
        break;
      case 'completed-sessions':
        operations.push({ type: 'set-value', selector: '#supp-completedSessions', value: patch.value });
        break;
      case 'dynamics':
        operations.push({ type: 'set-value', selector: '#supp-dynamics', value: patch.value });
        break;
      case 'recommendations':
        operations.push({ type: 'set-value', selector: '#supp-recommendations', value: patch.value });
        break;
      default:
        if (patch.value_type === 'checkbox-group') {
          operations.push({
            type: 'set-checkbox-group',
            section_key: patch.section_key,
            selector: `[data-section-key="${patch.section_key}"]`,
            values: patch.value
          });
        }
    }
  }
  return operations;
}

export function buildHints(runtime, screenContext) {
  const screenId = inferScreenId(screenContext);
  if (screenId === 'schedule') {
    const currentDay = runtime.scheduleDays.find((day) => day.date === runtime.currentDate) || runtime.scheduleDays[0];
    const nextScheduled = currentDay?.slots.find((slot) => slot.status === 'scheduled');
    const patient = nextScheduled ? getPatientById(runtime, nextScheduled.patient_id) : null;
    return [
      {
        hint_id: 'hint-schedule-next-patient',
        screen_id: 'schedule',
        patient_id: patient?.patient_id || null,
        intent_type: 'open_patient_selector',
        severity: 'info',
        provenance: 'scheduler',
        message: nextScheduled
          ? `Следующий пациент на ${nextScheduled.start_time}: ${patient?.full_name}. Можно сказать: "Открой первичный прием ${patient?.full_name}".`
          : 'На текущий день нет активных записей.',
        suggested_patches: nextScheduled ? [{ slot_id: nextScheduled.slot_id, appointment_id: nextScheduled.appointment_id }] : []
      },
      {
        hint_id: 'hint-schedule-nine-days',
        screen_id: 'schedule',
        patient_id: null,
        intent_type: 'change_schedule_day',
        severity: 'info',
        provenance: 'scheduler',
        message: `Доступно ${runtime.scheduleDays.length} рабочих дней. Можно переключать график по дням.`,
        suggested_patches: []
      }
    ];
  }

  const appointment = getAppointmentById(runtime, screenContext?.selected_appointment_id);
  if (!appointment) return [];

  const missing = [];
  if (!appointment.inspection_draft.conclusion_text) missing.push('Заключение');
  if (!appointment.inspection_draft.supplemental?.recommendations) missing.push('Рекомендации');
  if (!appointment.inspection_draft.supplemental?.dynamics) missing.push('Динамика');

  const draftPatchCount = appointment.draft_state?.draft_patches?.length || 0;
  const appliedFieldKeys = new Set((appointment.draft_state?.draft_patches || [])
    .filter((patch) => patch.status === 'applied' || appointment.draft_state?.applied_patch_ids?.includes(patch.patch_id))
    .map((patch) => patch.field_key));
  const requiredLooksComplete = Boolean(
    appointment.inspection_draft.conclusion_text
      || appliedFieldKeys.has('tbmedicalfinal')
      || draftPatchCount
  ) && missing.length <= 2;
  const completed = appointment.status === 'completed';
  return [
    {
      hint_id: 'hint-inspection-listening',
      screen_id: 'inspection',
      patient_id: appointment.patient_id,
      intent_type: 'preview_changes',
      severity: draftPatchCount ? 'info' : 'warning',
      provenance: 'draft_state',
      message: draftPatchCount
        ? `В черновике уже ${draftPatchCount} предложенных обновлений. Можно применить их в форму.`
        : 'Форма пока медицински пустая. Запустите запись или вставьте транскрипт, чтобы собрать черновик.',
      suggested_patches: appointment.draft_state?.draft_patches || []
    },
    {
      hint_id: 'hint-inspection-missing',
      screen_id: 'inspection',
      patient_id: appointment.patient_id,
      intent_type: 'show_hint',
      severity: missing.length ? 'warning' : 'success',
      provenance: 'form_validation',
      message: missing.length ? `Пока не заполнены ключевые поля: ${missing.join(', ')}.` : 'Ключевые поля формы заполнены. Можно сохранять.',
      suggested_patches: []
    },
    {
      hint_id: 'hint-inspection-next-step',
      screen_id: 'inspection',
      patient_id: appointment.patient_id,
      intent_type: completed ? 'generate_procedure_schedule' : 'save_and_close',
      severity: completed || requiredLooksComplete ? 'success' : 'info',
      provenance: 'workflow_state',
      message: completed
        ? 'Запись сохранена. Осмотр заполнен. Сформировать расписание процедур для пациента?'
        : (requiredLooksComplete
          ? 'Осмотр заполнен. Сохранить и закрыть?'
          : 'Форма назначения открыта. Можно начать запись приема или перейти в медицинские записи голосом.'),
      suggested_patches: []
    }
  ];
}

export function previewCommand({ command, runtime, screenContext }) {
  const normalized = normalizeText(command);
  const screenId = inferScreenId(screenContext);

  if (!command) {
    return {
      intent: makeIntent('show_hint', screenId, null, {}),
      patches: [],
      domOperations: [],
      hints: buildHints(runtime, screenContext),
      explanation: 'Команда пустая, показываю подсказки.'
    };
  }

  const routedPreview = previewFromCommandRouter({ command, runtime, screenContext });
  if (routedPreview) return routedPreview;

  if (screenId === 'schedule') {
    const patient = findPatientFromCommand(runtime, command);
    const slot = patient ? findSlotForPatient(runtime, patient.patient_id) : activeScheduleSlot(runtime);

    if (/выпис|эпикриз/.test(normalized)) {
      if (!slot) {
        return makeNavigationPreview({
          runtime,
          screenContext,
          type: 'open_discharge_summary',
          fallbackMessage: 'Не нашел пациента для открытия выписного эпикриза.'
        });
      }
      return scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: 'open_discharge_summary',
        label: 'Выписной эпикриз',
        tabKey: 'dischargeSummary'
      });
    }

    if (/медицинск.*запис|мед.*запис/.test(normalized)) {
      if (!slot) {
        return makeNavigationPreview({
          runtime,
          screenContext,
          type: 'open_medical_records',
          fallbackMessage: 'Не нашел пациента для открытия медицинских записей.'
        });
      }
      return scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: 'open_medical_records',
        label: 'Медицинские записи',
        tabKey: 'medicalRecords'
      });
    }

    if (/диагноз/.test(normalized)) {
      if (!slot) {
        return makeNavigationPreview({
          runtime,
          screenContext,
          type: 'open_diagnoses',
          fallbackMessage: 'Не нашел пациента для открытия диагноза.'
        });
      }
      return scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: 'open_diagnoses',
        label: 'Диагнозы',
        tabKey: 'diagnoses'
      });
    }

    if (/дневник/.test(normalized)) {
      if (!slot) {
        return makeNavigationPreview({
          runtime,
          screenContext,
          type: 'open_diaries',
          fallbackMessage: 'Не нашел пациента для открытия дневниковых записей.'
        });
      }
      return scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: 'open_diaries',
        label: 'Дневниковые записи',
        tabKey: 'diaries'
      });
    }

    if (/файл/.test(normalized)) {
      if (!slot) {
        return makeNavigationPreview({
          runtime,
          screenContext,
          type: 'open_files',
          fallbackMessage: 'Не нашел пациента для открытия файлов.'
        });
      }
      return scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: 'open_files',
        label: 'Файлы',
        tabKey: 'files'
      });
    }

    if (/открой|перейди|первичн|пациент|при[её]м|осмотр/.test(normalized)) {
      if (!slot) {
        return makeNavigationPreview({
          runtime,
          screenContext,
          type: 'open_patient',
          fallbackMessage: 'Не нашел подходящего пациента или запись в текущем расписании.'
        });
      }
      return scheduleToInspectionPreview(runtime, screenContext, {
        slot,
        type: /первичн|осмотр|при[её]м/.test(normalized) ? 'open_primary_visit' : 'open_patient',
        label: 'Назначение'
      });
    }

    if (/next|следующ|келесі/.test(normalized)) {
      return {
        intent: makeIntent('change_schedule_day', 'schedule', null, { direction: 'next' }),
        patches: [],
        domOperations: [{ type: 'click', selector: '#btnNextDay' }],
        hints: buildHints(runtime, screenContext),
        explanation: 'Подготовлен переход на следующий рабочий день.'
      };
    }
    if (/prev|предыдущ|алдыңғы/.test(normalized)) {
      return {
        intent: makeIntent('change_schedule_day', 'schedule', null, { direction: 'prev' }),
        patches: [],
        domOperations: [{ type: 'click', selector: '#btnPrevDay' }],
        hints: buildHints(runtime, screenContext),
        explanation: 'Подготовлен переход на предыдущий рабочий день.'
      };
    }
  }

  const appointment = getAppointmentById(runtime, screenContext?.selected_appointment_id);
  if (!appointment) {
    return {
      intent: makeIntent('show_hint', screenId, null, {}),
      patches: [],
      domOperations: [],
      hints: buildHints(runtime, screenContext),
      explanation: 'Активная запись не найдена.'
    };
  }

  if (/расписани|график|назад/.test(normalized)) {
    return makeNavigationPreview({
      runtime,
      screenContext,
      type: 'return_to_schedule',
      operations: [{ type: 'navigate-to-schedule', selector: 'window.location.hash', reason: 'Return to schedule screen' }],
      explanation: 'Вернусь в расписание через изменение route hash.'
    });
  }

  if (/примен|заполни форму|внеси в форму|перенеси черновик/.test(normalized)) {
    return {
      ...buildPreviewFromDraftState(runtime, appointment.appointment_id),
      intent: {
        ...makeIntent('apply_current_draft', 'inspection', appointment.appointment_id, {}),
        confidence: 0.9,
        requires_confirmation: false
      },
      explanation: 'Врач попросил применить черновик. Подготовлены безопасные DOM-операции для заполнения формы.'
    };
  }

  if (/выпис|эпикриз/.test(normalized)) {
    return switchTabPreview(runtime, screenContext, 'open_discharge_summary', 'dischargeSummary', 'Выписной эпикриз', /выпис|эпикриз/);
  }

  if (/медицинск.*запис|мед.*запис/.test(normalized)) {
    return switchTabPreview(runtime, screenContext, 'open_medical_records', 'medicalRecords', 'Медицинские записи', /медицинск.*запис|мед.*запис/);
  }

  if (/диагноз/.test(normalized)) {
    return switchTabPreview(runtime, screenContext, 'open_diagnoses', 'diagnoses', 'Диагнозы', /диагноз/);
  }

  if (/дневник/.test(normalized)) {
    return switchTabPreview(runtime, screenContext, 'open_diaries', 'diaries', 'Дневниковые записи', /дневник/);
  }

  if (/файл/.test(normalized)) {
    return switchTabPreview(runtime, screenContext, 'open_files', 'files', 'Файлы', /файл/);
  }

  if (/назначени|первичн|осмотр|при[её]м/.test(normalized)) {
    return switchTabPreview(runtime, screenContext, 'open_primary_visit', 'inspection', 'Назначение', /назначени|первичн|осмотр|при[её]м/);
  }

  if (/сохранить и закрыть|сохрани и закрой/.test(normalized)) {
    return makeNavigationPreview({
      runtime,
      screenContext,
      type: 'save_and_close',
      targetEntity: appointment.appointment_id,
      operations: [{ type: 'click', selector: '#btnSaveAndCloseInspectionResult', label: 'Сохранить и закрыть', reason: 'Explicit doctor save command' }],
      explanation: 'Команда сохранения явная. Подготовлен click по кнопке "Сохранить и закрыть".'
    });
  }

  if (/сохранить|сохрани/.test(normalized)) {
    return makeNavigationPreview({
      runtime,
      screenContext,
      type: 'save_record',
      targetEntity: appointment.appointment_id,
      operations: [{ type: 'click', selector: '#btnSaveInspectionResult', label: 'Сохранить', reason: 'Explicit doctor save command' }],
      explanation: 'Команда сохранения явная. Подготовлен click по кнопке "Сохранить".'
    });
  }

  return buildPreviewFromDraftState(runtime, appointment.appointment_id);
}

export async function observeAgent(runtime, { screenContext = {}, transcriptDelta = '', command = '' }) {
  const sourceText = compactText(command || transcriptDelta);
  let preview = previewCommand({ command: sourceText, runtime, screenContext });
  const shouldTryLlm = sourceText && (!preview.commandResult || preview.commandResult.needsLlmFallback || preview.commandResult.intent === 'unknown');
  if (shouldTryLlm) {
    const llmCommandResult = await inferOpenRouterCommand(runtime, {
      command: sourceText,
      screenContext,
      deterministicResult: preview.commandResult || preview.intent || null
    }).catch(() => null);
    if (llmCommandResult && llmCommandResult.intent !== 'unknown') {
      const llmPreview = previewFromCommandRouter({
        command: sourceText,
        runtime,
        screenContext,
        commandResult: {
          ...llmCommandResult,
          needsLlmFallback: false,
          fallbackReason: null
        }
      });
      if (llmPreview) preview = llmPreview;
    }
  }
  return {
    commandResult: preview.commandResult || null,
    agent_state: {
      screen_id: inferScreenId(screenContext),
      selected_patient_id: screenContext.selected_patient_id || null,
      selected_appointment_id: screenContext.selected_appointment_id || null,
      workflow_step: inferWorkflowStep(runtime, screenContext)
    },
    intents: preview.intent ? [preview.intent] : [],
    draft_patches: preview.patches || [],
    dom_operations: preview.domOperations || [],
    actionPlan: preview.actionPlan || null,
    dom_proof: preview.dom_proof || [],
    hints: preview.hints || buildHints(runtime, screenContext),
    preview
  };
}

export function executeIntentPreview(runtime, { intent, command, screenContext = {} }) {
  const sourceText = command || intent?.source_text || intent?.type || '';
  return previewCommand({ command: sourceText, runtime, screenContext });
}

function inferWorkflowStep(runtime, screenContext = {}) {
  const screenId = inferScreenId(screenContext);
  const appointment = getAppointmentById(runtime, screenContext.selected_appointment_id);
  if (screenId === 'schedule') return 'schedule_open';
  if (!appointment) return 'inspection_open';
  if (appointment.status === 'completed') return 'completed';
  if (appointment.draft_state?.draft_status === 'applied') return 'draft_applied';
  if (appointment.draft_state?.draft_status === 'ready_for_apply') return 'draft_ready';
  if (appointment.draft_state?.draft_status === 'listening') return 'listening';
  return 'inspection_open';
}

function addBusinessDaysFrom(startDate, count) {
  const days = [];
  const cursor = new Date(`${startDate}T09:00:00`);
  cursor.setDate(cursor.getDate() + 1);
  while (days.length < count) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      days.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function buildProcedureSchedulePreview(runtime, { appointmentId }) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found for procedure schedule');
  const patient = getPatientById(runtime, appointment.patient_id);
  const startDate = appointment.inspection_draft?.execute_date || runtime.currentDate;
  const businessDays = addBusinessDaysFrom(startDate, 9);
  const draft = {
    draft_id: makeId('procedure-schedule'),
    patient_id: appointment.patient_id,
    appointment_id: appointmentId,
    generated_from: 'completed_inspection',
    status: 'suggested',
    days: businessDays.map((date, index) => ({
      date,
      procedure_name: index === 8 ? 'Повторная оценка психолога' : 'Психологическая коррекция',
      recommended_duration_min: index === 8 ? 45 : 30,
      specialist_type: 'Медицинская психология',
      note: index === 8
        ? 'Контроль динамики после курса'
        : `Занятие ${index + 1}/9 для ${patient?.full_name || 'пациента'}`
    }))
  };
  runtime.procedureScheduleDrafts[draft.draft_id] = draft;
  return clone(draft);
}

export function acceptProcedureSchedule(runtime, draftId) {
  const draft = runtime.procedureScheduleDrafts[draftId];
  if (!draft) throw new Error('Procedure schedule draft not found');
  draft.status = 'accepted';
  draft.accepted_at = nowIso();
  return clone(draft);
}

export function inferSpeakerTag(rawSpeaker, text) {
  if (rawSpeaker && rawSpeaker !== 'auto') return rawSpeaker;
  const normalized = normalizeText(text);
  if (/режим доктора патапим|режим доктора патапима|доктор патапим/i.test(normalized)) return 'doctor';
  if (/я пациент|я пациентка|меня зовут|у меня/i.test(normalized)) return 'patient';
  if (/врач:|doctor:|специалист:/i.test(text)) return 'doctor';
  if (/мама:|папа:|родитель:|parent:|caregiver:/i.test(text)) return 'caregiver';
  if (/пациент:|ребенок:|patient:/i.test(text)) return 'patient';
  if (/жалуется|болит|не хочу|устал|хочу/i.test(normalized)) return 'patient';
  if (/рекомендую|назначаю|продолжить|наблюдается/i.test(normalized)) return 'doctor';
  return 'unknown';
}

export function inferPatapimSpeakerRole({ speakerId, text, currentMap = {} }) {
  const normalized = normalizeText(text);
  const key = String(speakerId ?? 'unknown');
  if (currentMap[key]) return currentMap[key];
  if (/режим доктора патапим|режим доктора патапима|доктор патапим/.test(normalized)) return 'doctor';
  if (/я пациент|я пациентка|я больной|я больная|у меня|мне больно|болит|я устал|я устала/.test(normalized)) return 'patient';
  if (/открой|перейди|сохрани|назначаю|рекомендую|продолжить|осмотр|заключение/.test(normalized)) return 'doctor';
  return 'unknown';
}

export function startSpeechSession(runtime, appointmentId, provider = 'browser-web-speech') {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found for speech session');
  const session = {
    session_id: makeId('session'),
    appointment_id: appointmentId,
    status: 'listening',
    started_at: nowIso(),
    provider
  };
  runtime.speechSessions[session.session_id] = session;
  appointment.draft_state.draft_status = 'listening';
  appointment.draft_state.updated_at = nowIso();
  return session;
}

export async function ingestTranscript(runtime, { appointmentId, sessionId, text, speakerTag }) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) {
    throw new Error('Appointment not found for transcript ingestion');
  }

  const patient = getPatientById(runtime, appointment.patient_id);
  const inferredSpeaker = inferSpeakerTag(speakerTag, text);
  const activeSessionId = sessionId || `session-${appointmentId}`;
  const chunk = {
    chunk_id: makeId('chunk'),
    session_id: activeSessionId,
    start_ms: Date.now(),
    end_ms: Date.now() + 2500,
    text,
    speaker_tag: inferredSpeaker,
    confidence: inferredSpeaker === 'unknown' ? 0.55 : 0.86
  };

  const factCandidates = inferFactCandidates(appointment, text, inferredSpeaker);
  const structuredPatches = inferStructuredSectionPatches(appointment, text, inferredSpeaker);
  const fieldPatches = factCandidates.map(factToPatch);
  const openRouterResult = await inferOpenRouterPatches(appointment, patient, text, inferredSpeaker);
  const incomingPatches = [...fieldPatches, ...structuredPatches, ...openRouterResult.patches];
  const allFactCandidates = [...factCandidates, ...openRouterResult.facts];

  appointment.draft_state.transcript_chunks.push(chunk);
  appointment.draft_state.fact_candidates.push(...allFactCandidates);
  appointment.draft_state.draft_patches = mergeDraftPatches(appointment.draft_state.draft_patches, incomingPatches);
  appointment.draft_state.draft_status = appointment.draft_state.draft_patches.length ? 'ready_for_apply' : 'listening';
  appointment.draft_state.updated_at = nowIso();
  appointment.draft_state.last_preview = buildPreviewFromDraftState(runtime, appointmentId);

  runtime.transcriptSessions[activeSessionId] ||= [];
  runtime.transcriptSessions[activeSessionId].push(chunk);

  return {
    chunk,
    factCandidates: allFactCandidates,
    draftPatches: appointment.draft_state.draft_patches,
    domOperations: appointment.draft_state.last_preview.domOperations,
    parser: {
      provider: openRouterResult.provider,
      used_openrouter: openRouterResult.provider === 'openrouter' && !openRouterResult.error,
      error: openRouterResult.error
    },
    hints: buildHints(runtime, { screen_id: 'inspection', selected_appointment_id: appointmentId }),
    draftState: clone(appointment.draft_state)
  };
}

export function stopSpeechSession(runtime, sessionId) {
  const session = runtime.speechSessions[sessionId];
  if (!session) throw new Error('Speech session not found');
  session.status = 'stopped';
  session.stopped_at = nowIso();
  const appointment = getAppointmentById(runtime, session.appointment_id);
  if (appointment && appointment.draft_state.draft_status === 'listening') {
    appointment.draft_state.draft_status = appointment.draft_state.draft_patches.length ? 'ready_for_apply' : 'idle';
    appointment.draft_state.updated_at = nowIso();
  }
  return session;
}

export function getDraftState(runtime, appointmentId) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  return clone(appointment.draft_state);
}

export function buildApplyPreview(runtime, appointmentId) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  const preview = buildPreviewFromDraftState(runtime, appointmentId);
  appointment.draft_state.last_preview = clone(preview);
  appointment.draft_state.updated_at = nowIso();
  return preview;
}

export function markPreviewApplied(runtime, appointmentId, patchIds = []) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) throw new Error('Appointment not found');
  const ids = patchIds.length ? patchIds : (appointment.draft_state.draft_patches || []).map((patch) => patch.patch_id);
  appointment.draft_state.applied_patch_ids = [...new Set([...(appointment.draft_state.applied_patch_ids || []), ...ids])];
  appointment.draft_state.draft_status = 'applied';
  appointment.draft_state.updated_at = nowIso();
  appointment.draft_state.draft_patches = appointment.draft_state.draft_patches.map((patch) => (
    ids.includes(patch.patch_id) ? { ...patch, status: 'applied' } : patch
  ));
  return clone(appointment.draft_state);
}

export function createAuditEntry({ actorType, actionType, screenId, entityRefs, payload, result }) {
  return {
    entry_id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    actor_type: actorType,
    action_type: actionType,
    screen_id: screenId,
    entity_refs: entityRefs,
    payload,
    result
  };
}

export function applyInspectionSave(runtime, appointmentId, payload) {
  const appointment = getAppointmentById(runtime, appointmentId);
  if (!appointment) {
    throw new Error('Appointment not found');
  }

  appointment.inspection_draft = {
    ...appointment.inspection_draft,
    ...payload,
    supplemental: {
      ...appointment.inspection_draft.supplemental,
      ...(payload.supplemental || {})
    }
  };
  appointment.status = 'completed';
  appointment.executed_at = `${payload.execute_date}T${payload.execute_time}:00`;
  appointment.draft_state.draft_status = 'applied';
  appointment.draft_state.updated_at = nowIso();

  for (const day of runtime.scheduleDays) {
    for (const slot of day.slots) {
      if (slot.appointment_id === appointmentId) {
        slot.status = 'completed';
      }
    }
  }

  return appointment;
}
