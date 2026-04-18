function normalizeLabel(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeCommand(input) {
  return normalizeLabel(input).replace(/ё/g, 'е');
}

const TARGET_REGISTRY = {
  'medical-records': {
    targetKey: 'medical-records',
    semanticRole: 'tab',
    candidateNames: ['медицинские записи', 'мед записи'],
    textAnchors: ['Медицинские записи'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="medicalRecords"]'],
    selector: '[data-action="switch-tab"][data-tab="medicalRecords"]',
    tabKey: 'medicalRecords',
    verify: { activeTab: 'medicalRecords', panelSelector: '.readonly-card[data-document-title="Медицинские записи"]' }
  },
  assignments: {
    targetKey: 'assignments',
    semanticRole: 'tab',
    candidateNames: ['назначения'],
    textAnchors: ['Назначения'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="assignments"]'],
    selector: '[data-action="switch-tab"][data-tab="assignments"]',
    tabKey: 'assignments',
    verify: { activeTab: 'assignments', panelSelector: '.readonly-card[data-document-title="Назначения"]' }
  },
  diaries: {
    targetKey: 'diaries',
    semanticRole: 'tab',
    candidateNames: ['дневниковые записи', 'дневник'],
    textAnchors: ['Дневниковые записи'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="diaries"]'],
    selector: '[data-action="switch-tab"][data-tab="diaries"]',
    tabKey: 'diaries',
    verify: { activeTab: 'diaries', panelSelector: '.readonly-card[data-document-title="Дневниковые записи"]' }
  },
  diagnoses: {
    targetKey: 'diagnoses',
    semanticRole: 'tab',
    candidateNames: ['диагнозы', 'диагноз'],
    textAnchors: ['Диагнозы'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="diagnoses"]'],
    selector: '[data-action="switch-tab"][data-tab="diagnoses"]',
    tabKey: 'diagnoses',
    verify: { activeTab: 'diagnoses', panelSelector: '.readonly-card[data-document-title="Диагнозы"]' }
  },
  files: {
    targetKey: 'files',
    semanticRole: 'tab',
    candidateNames: ['файлы', 'файл'],
    textAnchors: ['Файлы'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="files"]'],
    selector: '[data-action="switch-tab"][data-tab="files"]',
    tabKey: 'files',
    verify: { activeTab: 'files', panelSelector: '.readonly-card[data-document-title="Файлы"]' }
  },
  'discharge-summary': {
    targetKey: 'discharge-summary',
    semanticRole: 'tab',
    candidateNames: ['выписной эпикриз', 'эпикриз', 'выписка'],
    textAnchors: ['Выписной эпикриз'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="dischargeSummary"]'],
    selector: '[data-action="switch-tab"][data-tab="dischargeSummary"]',
    tabKey: 'dischargeSummary',
    verify: { activeTab: 'dischargeSummary', panelSelector: '.readonly-card[data-document-title="Выписной эпикриз"]' }
  },
  'audit-log': {
    targetKey: 'audit-log',
    semanticRole: 'button',
    candidateNames: ['audit', 'журнал'],
    textAnchors: ['Последние audit entries'],
    legacySelectors: ['[data-action="show-slot-audit"]'],
    selector: '[data-action="show-slot-audit"]',
    tabKey: null,
    verify: { toast: true }
  }
};

const ADVISOR_OVERLAY_STYLE_ID = 'damumed-advisor-overlay-style';
const ADVISOR_OVERLAY_ID = 'damumed-advisor-overlay';

function ensureAdvisorOverlayStyles() {
  if (document.getElementById(ADVISOR_OVERLAY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = ADVISOR_OVERLAY_STYLE_ID;
  style.textContent = `
    #${ADVISOR_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(15, 23, 42, 0.34);
      backdrop-filter: blur(2px);
      pointer-events: none;
    }
    #${ADVISOR_OVERLAY_ID}[data-visible="true"] {
      display: flex;
    }
    #${ADVISOR_OVERLAY_ID} .damumed-advisor-modal {
      width: min(700px, calc(100vw - 40px));
      border-radius: 26px;
      background: linear-gradient(180deg, rgba(255,255,255,0.985), rgba(244,251,250,0.985));
      border: 1px solid rgba(13, 148, 136, 0.18);
      box-shadow: 0 32px 90px rgba(15, 23, 42, 0.28);
      padding: 28px 30px 30px;
      text-align: center;
      pointer-events: auto;
    }
    #${ADVISOR_OVERLAY_ID} .damumed-advisor-label {
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #0f766e;
    }
    #${ADVISOR_OVERLAY_ID} .damumed-advisor-stage {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 12px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(13, 148, 136, 0.12);
      color: #0f766e;
      font-size: 12px;
      font-weight: 700;
    }
    #${ADVISOR_OVERLAY_ID} .damumed-advisor-question {
      margin: 18px 0 0;
      font-size: 28px;
      line-height: 1.4;
      font-weight: 700;
      color: #0f172a;
      white-space: pre-wrap;
    }
    #${ADVISOR_OVERLAY_ID} .damumed-advisor-completion {
      margin: 18px 0 0;
      font-size: 18px;
      line-height: 1.5;
      color: #334155;
      white-space: pre-wrap;
    }
    @media (max-width: 860px) {
      #${ADVISOR_OVERLAY_ID} {
        padding: 14px;
      }
      #${ADVISOR_OVERLAY_ID} .damumed-advisor-modal {
        width: 100%;
        padding: 22px 18px 24px;
      }
      #${ADVISOR_OVERLAY_ID} .damumed-advisor-question {
        font-size: 22px;
      }
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureAdvisorOverlay() {
  ensureAdvisorOverlayStyles();
  let overlay = document.getElementById(ADVISOR_OVERLAY_ID);
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = ADVISOR_OVERLAY_ID;
  overlay.setAttribute('data-visible', 'false');
  overlay.innerHTML = `
    <div class="damumed-advisor-modal" role="dialog" aria-live="polite" aria-label="Уточняющий вопрос советчика">
      <div class="damumed-advisor-label">Нужно уточнить</div>
      <div class="damumed-advisor-stage" hidden></div>
      <p class="damumed-advisor-question"></p>
      <p class="damumed-advisor-completion" hidden></p>
    </div>
  `;
  document.documentElement.appendChild(overlay);
  return overlay;
}

function updateAdvisorQuestionOverlay({ visible = false, mode = 'question', question = '', stageLabel = '', completionTitle = '', completionMessage = '' } = {}) {
  const overlay = ensureAdvisorOverlay();
  const labelNode = overlay.querySelector('.damumed-advisor-label');
  const stageNode = overlay.querySelector('.damumed-advisor-stage');
  const questionNode = overlay.querySelector('.damumed-advisor-question');
  const completionNode = overlay.querySelector('.damumed-advisor-completion');
  if (!visible || !String(question || '').trim()) {
    if (!(mode === 'completed' && String(completionMessage || '').trim())) {
      overlay.setAttribute('data-visible', 'false');
      labelNode.textContent = 'Нужно уточнить';
      questionNode.textContent = '';
      completionNode.hidden = true;
      completionNode.textContent = '';
      stageNode.hidden = true;
      stageNode.textContent = '';
      return { ok: true, visible: false };
    }
  }
  if (mode === 'completed') {
    labelNode.textContent = String(completionTitle || 'Сбор данных завершен').trim();
    questionNode.textContent = '';
    stageNode.hidden = true;
    stageNode.textContent = '';
    completionNode.hidden = false;
    completionNode.textContent = String(completionMessage || 'Черновик формы подготовлен. Проверьте и подтвердите заполнение.').trim();
    overlay.setAttribute('data-visible', 'true');
    return { ok: true, visible: true, mode: 'completed', completionMessage: completionNode.textContent };
  }
  labelNode.textContent = 'Нужно уточнить';
  questionNode.textContent = String(question || '').trim();
  completionNode.hidden = true;
  completionNode.textContent = '';
  if (String(stageLabel || '').trim()) {
    stageNode.hidden = false;
    stageNode.textContent = String(stageLabel || '').trim();
  } else {
    stageNode.hidden = true;
    stageNode.textContent = '';
  }
  overlay.setAttribute('data-visible', 'true');
  return { ok: true, visible: true, question: questionNode.textContent, stageLabel: stageNode.hidden ? '' : stageNode.textContent };
}

function visible(node) {
  return Boolean(node && node.offsetParent !== null);
}

function semanticText(node) {
  return normalizeLabel([
    node?.getAttribute?.('aria-label') || '',
    node?.getAttribute?.('title') || '',
    node?.getAttribute?.('placeholder') || '',
    node?.getAttribute?.('data-document-title') || '',
    node?.textContent || ''
  ].join(' '));
}

function hashText(input) {
  let hash = 0;
  const text = String(input || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `h${Math.abs(hash)}`;
}

function selectorForNode(node) {
  if (!node) return '';
  if (node.id) return `#${cssEscape(node.id)}`;
  const dataAction = node.getAttribute('data-action');
  const dataTab = node.getAttribute('data-tab');
  const dataAppointmentId = node.getAttribute('data-appointment-id');
  const dataSlotId = node.getAttribute('data-slot-id');
  const dataDocumentTitle = node.getAttribute('data-document-title');
  if (dataAction && dataTab) {
    return `[data-action="${cssEscape(dataAction)}"][data-tab="${cssEscape(dataTab)}"]`;
  }
  if (dataAction && dataAppointmentId) {
    return `[data-action="${cssEscape(dataAction)}"][data-appointment-id="${cssEscape(dataAppointmentId)}"]`;
  }
  if (dataAction && dataSlotId) {
    return `[data-action="${cssEscape(dataAction)}"][data-slot-id="${cssEscape(dataSlotId)}"]`;
  }
  if (dataAction) return `[data-action="${cssEscape(dataAction)}"]`;
  if (dataDocumentTitle) return `[data-document-title="${cssEscape(dataDocumentTitle)}"]`;
  return '';
}

function describeNode(node, role) {
  const label = node.textContent.trim().replace(/\s+/g, ' ');
  return {
    label,
    normalized_label: normalizeLabel(label),
    selector: selectorForNode(node),
    role,
    href_or_action: node.getAttribute('href') || node.getAttribute('data-action') || '',
    visible: visible(node),
    enabled: !node.disabled && node.getAttribute('aria-disabled') !== 'true'
  };
}

function visibleButtonActions() {
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .map((node) => describeNode(node, 'button'))
    .filter((item) => item.label && item.selector)
    .slice(0, 40);
}

function visibleTabs() {
  return Array.from(document.querySelectorAll('[data-action="switch-tab"][data-tab]'))
    .filter(visible)
    .map((node) => ({
      ...describeNode(node, 'tab'),
      tab_key: node.getAttribute('data-tab')
    }));
}

function visibleLinks() {
  return Array.from(document.querySelectorAll('a[href], button, [role="button"]'))
    .filter(visible)
    .map((node) => describeNode(node, node.matches('a[href]') ? 'link' : 'button'))
    .filter((item) => item.label && item.selector)
    .slice(0, 60);
}

function visibleDocuments() {
  return Array.from(document.querySelectorAll('[data-document-title]'))
    .filter(visible)
    .map((node) => ({
      label: node.getAttribute('data-document-title') || node.textContent.trim(),
      normalized_label: normalizeLabel(node.getAttribute('data-document-title') || node.textContent),
      selector: selectorForNode(node),
      role: 'document',
      href_or_action: node.getAttribute('data-document-type') || '',
      visible: true,
      enabled: true
    }));
}

function visibleSlotCards() {
  return Array.from(document.querySelectorAll('.slot-card[data-appointment-id]'))
    .filter(visible)
    .map((node) => ({
      slot_id: node.getAttribute('data-slot-id') || '',
      appointment_id: node.getAttribute('data-appointment-id') || '',
      patient_id: node.getAttribute('data-patient-id') || '',
      patient_name: node.getAttribute('data-patient-name') || '',
      normalized_patient_name: normalizeLabel(node.getAttribute('data-patient-name') || ''),
      selector: selectorForNode(node)
    }))
    .filter((item) => item.appointment_id);
}

function inspectionScreenEvidence() {
  const evidence = [];
  if (document.querySelector('section[data-screen="inspection"]')) evidence.push('inspection_section');
  if (document.querySelector('#frmInspectionResult, form[data-screen="inspection"]')) evidence.push('inspection_form');
  if (document.querySelector('#tbMedicalFinal, textarea[data-field-key="tbmedicalfinal"]')) evidence.push('conclusion_field');
  if (document.querySelector('#btnSaveInspectionResult, button[data-action="save-inspection"]')) evidence.push('save_button');
  if (document.querySelector('[data-patient-id][data-patient-name]')) evidence.push('patient_context');
  return evidence;
}

function scheduleScreenEvidence() {
  const evidence = [];
  if (document.querySelector('section[data-screen="schedule"]')) evidence.push('schedule_section');
  if (document.querySelector('#schedule')) evidence.push('schedule_root');
  if (document.querySelector('.slot-card[data-appointment-id]')) evidence.push('slot_cards');
  if (document.querySelector('#dpCalendarDate, input[data-field-key="calendar-date"]')) evidence.push('date_control');
  if (document.querySelector('#cmbGridSchedules, select[data-field-key="grid-schedule"]')) evidence.push('provider_control');
  return evidence;
}

function inferScreenState() {
  const inspectionEvidence = inspectionScreenEvidence();
  const scheduleEvidence = scheduleScreenEvidence();
  if (inspectionEvidence.length >= 2) {
    return {
      screen_id: 'inspection',
      confidence: Math.min(1, 0.45 + inspectionEvidence.length * 0.12),
      evidence: inspectionEvidence,
      active_regions: ['patient_context', 'inspection_form']
    };
  }
  if (scheduleEvidence.length >= 2) {
    return {
      screen_id: 'schedule',
      confidence: Math.min(1, 0.45 + scheduleEvidence.length * 0.12),
      evidence: scheduleEvidence,
      active_regions: ['schedule_controls', 'schedule_slots']
    };
  }
  return {
    screen_id: document.querySelector('[data-screen]')?.getAttribute('data-screen') || 'unknown',
    confidence: 0.2,
    evidence: [],
    active_regions: []
  };
}

function inferScreenId() {
  return inferScreenState().screen_id;
}

function selectedAppointmentId() {
  if (inferScreenId() !== 'inspection') return null;
  const match = window.location.hash.match(/inspection\/([^/]+)/);
  if (match) return match[1];
  return document.querySelector('[data-appointment-id]')?.getAttribute('data-appointment-id') || null;
}

function patientScopedScreenId() {
  const screenId = inferScreenId();
  if (screenId === 'schedule') return null;
  return screenId;
}

function selectedPatientId() {
  const screenId = patientScopedScreenId();
  if (!screenId) return null;
  return document.querySelector(`[data-screen="${cssEscape(screenId)}"][data-patient-id]`)?.getAttribute('data-patient-id')
    || document.querySelector('[data-patient-id]')?.getAttribute('data-patient-id')
    || null;
}

function selectedPatientName() {
  const screenId = patientScopedScreenId();
  if (!screenId) return null;
  return document.querySelector(`[data-screen="${cssEscape(screenId)}"][data-patient-name]`)?.getAttribute('data-patient-name')
    || document.querySelector('[data-patient-name]')?.getAttribute('data-patient-name')
    || null;
}

function activeTabKey() {
  const activeTab = document.querySelector('[data-action="switch-tab"].active');
  if (activeTab) return activeTab.getAttribute('data-tab') || null;
  if (document.querySelector('#frmInspectionResult, form[data-screen="inspection"]')) return 'inspection';
  const visibleCard = Array.from(document.querySelectorAll('.readonly-card[data-document-title]')).find(visible);
  const title = normalizeLabel(visibleCard?.getAttribute('data-document-title') || '');
  if (title.includes('выписной эпикриз')) return 'dischargeSummary';
  if (title.includes('медицинские записи')) return 'medicalRecords';
  if (title.includes('дневниковые записи')) return 'diaries';
  if (title.includes('диагнозы')) return 'diagnoses';
  if (title.includes('файлы')) return 'files';
  if (title.includes('назначения')) return 'assignments';
  return null;
}

function valueForNode(node) {
  if (!node) return null;
  if (node.matches('input[type="checkbox"]')) return node.checked;
  if ('value' in node) return node.value;
  return node.textContent.trim();
}

function clearHighlights() {
  document.querySelectorAll('.field-highlight, .active-highlight').forEach((node) => {
    node.classList.remove('field-highlight', 'active-highlight');
  });
}

function resolve(selector) {
  return document.querySelector(selector);
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function queryVisibleNodes(selectors = []) {
  for (const selector of selectors) {
    if (!selector) continue;
    const matched = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (matched.length) return matched;
  }
  return [];
}

function semanticScore(node, terms = [], containerHints = []) {
  const haystack = semanticText(node);
  let score = 0;
  for (const term of terms.map(normalizeLabel).filter(Boolean)) {
    if (haystack === term) score += 4;
    else if (haystack.includes(term)) score += 2;
  }
  for (const hint of containerHints.map(normalizeLabel).filter(Boolean)) {
    const containerText = normalizeLabel(node.closest('[data-screen], .inspection-wrap, .tab-list, .controls, .modal, .readonly-card')?.textContent || '');
    if (containerText.includes(hint)) score += 1;
  }
  return score;
}

function findSemanticNode({
  role = 'button',
  candidateNames = [],
  labelCandidates = [],
  textAnchors = [],
  containerHints = [],
  legacySelectors = []
} = {}) {
  const searchTerms = [...candidateNames, ...labelCandidates, ...textAnchors];
  const selectorMap = {
    tab: ['[data-action="switch-tab"]', '[role="tab"]', 'button'],
    button: ['button', '[role="button"]', 'a[href]'],
    link: ['a[href]', 'button', '[role="button"]'],
    form: ['#frmInspectionResult', 'form[data-screen="inspection"]', 'form'],
    field: ['input', 'textarea', 'select']
  };
  const candidates = queryVisibleNodes(selectorMap[role] || selectorMap.button)
    .map((node) => ({ node, score: semanticScore(node, searchTerms, containerHints) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length) return candidates[0].node;
  return queryVisibleNodes(legacySelectors)[0] || null;
}

function sectionKeyFromSelector(selector) {
  const match = String(selector || '').match(/data-section-key=["']([^"']+)["']/);
  return match?.[1] || null;
}

function ensureInspectionTabVisible() {
  if (document.querySelector('#frmInspectionResult, form[data-screen="inspection"]')) return true;
  const tabButton = findSemanticNode({
    role: 'tab',
    candidateNames: ['назначение', 'прием', 'приём', 'осмотр'],
    legacySelectors: ['[data-action="switch-tab"][data-tab="inspection"]']
  });
  if (!tabButton) return false;
  tabButton.click();
  return Boolean(document.querySelector('#frmInspectionResult, form[data-screen="inspection"]'));
}

function resolveCheckboxGroup(operation) {
  const direct = resolve(operation.selector);
  if (direct) return direct;
  const sectionKey = operation.section_key || sectionKeyFromSelector(operation.selector);
  if (!sectionKey) return null;
  return document.querySelector(`[data-section-key="${cssEscape(sectionKey)}"]`);
}

function dispatchValueChange(node) {
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function commandTokens(command) {
  return normalizeCommand(command)
    .split(/[^a-zа-яәғқңөұүһі0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .filter((token) => ![
      'открой',
      'перейди',
      'пациент',
      'пациента',
      'первичный',
      'прием',
      'приём',
      'осмотр',
      'эпикриз',
      'выписной',
      'медицинские',
      'записи'
    ].includes(token));
}

function bestVisibleSlotCard(command) {
  const cards = Array.from(document.querySelectorAll('.slot-card[data-appointment-id]')).filter(visible);
  if (!cards.length) return null;
  const tokens = commandTokens(command);
  if (!tokens.length) return cards[0];
  const scored = cards
    .map((card) => {
      const haystack = normalizeCommand(`${card.getAttribute('data-patient-name') || ''} ${card.textContent || ''}`);
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { card, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].card : cards[0];
}

async function openAppointmentFromVisibleSchedule(command) {
  if (inferScreenId() === 'inspection' && document.querySelector('#frmInspectionResult, form[data-screen="inspection"]')) {
    return {
      ok: true,
      skipped: true,
      selector: '#frmInspectionResult',
      reason: 'Appointment is already open'
    };
  }
  const card = bestVisibleSlotCard(command);
  if (!card) {
    return { ok: false, reason: 'No visible appointment card found on schedule' };
  }
  const button = card.querySelector('[data-action="open-inspection"]')
    || Array.from(card.querySelectorAll('button, [role="button"], a[href]'))
      .find((node) => semanticScore(node, ['исполнить', 'открыть'], []) > 0);
  if (!button) {
    return { ok: false, selector: selectorForNode(card), reason: 'Appointment card has no open button' };
  }
  const before = window.location.hash;
  button.click();
  const loaded = await waitForSelector('#frmInspectionResult, form[data-screen="inspection"]', 7000);
  return {
    ok: Boolean(loaded),
    selector: selectorForNode(button),
    before,
    after: window.location.hash,
    patient: card.getAttribute('data-patient-name') || '',
    reason: loaded ? 'Opened appointment from visible schedule DOM' : 'Appointment form did not load after click'
  };
}

async function switchVisibleTab(tabKey, label) {
  const selector = `[data-action="switch-tab"][data-tab="${cssEscape(tabKey)}"]`;
  const tab = findSemanticNode({
    role: 'tab',
    candidateNames: [label || '', tabKey || ''],
    legacySelectors: [selector]
  }) || await waitForSelector(selector, 5000);
  if (!tab) return { ok: false, selector, reason: `Tab not found: ${label || tabKey}` };
  tab.click();
  await wait(120);
  return { ok: true, selector, label: label || tab.textContent.trim(), reason: 'Switched visible tab' };
}

async function verifyActionPlan(actionPlan) {
  const intent = actionPlan?.intent;
  const target = actionPlan?.actionTarget;
  if (intent === 'open_tab') {
    const registryItem = TARGET_REGISTRY[target];
    const activeTab = activeTabKey();
    const panelLoaded = registryItem?.verify?.panelSelector ? Boolean(document.querySelector(registryItem.verify.panelSelector)) : true;
    const ok = registryItem?.verify?.activeTab
      ? activeTab === registryItem.verify.activeTab && panelLoaded
      : Boolean(document.querySelector(registryItem?.selector || ''));
    return {
      ok,
      expected: registryItem?.verify || null,
      actual: { screen_id: inferScreenId(), activeTab, panelLoaded },
      reason: ok ? 'target_tab_active' : (activeTab !== registryItem?.verify?.activeTab ? 'target_tab_not_active' : 'target_tab_panel_not_loaded')
    };
  }
  if (intent === 'open_patient' || intent === 'open_primary_visit') {
    const patientId = selectedPatientId();
    const patientName = selectedPatientName();
    const expectedName = actionPlan?.matchedPatient?.full_name || actionPlan?.patientQuery || '';
    const expectedTokens = commandTokens(expectedName);
    const normalizedPatientName = normalizeCommand(patientName || '');
    const nameMatches = expectedTokens.length
      ? expectedTokens.every((token) => normalizedPatientName.includes(normalizeCommand(token)))
      : Boolean(normalizedPatientName);
    const idMatches = actionPlan?.matchedPatient?.patient_id ? actionPlan.matchedPatient.patient_id === patientId : true;
    const inspectionLoaded = Boolean(document.querySelector('#frmInspectionResult'));
    const ok = inferScreenId() === 'inspection' && inspectionLoaded && idMatches && nameMatches;
    return {
      ok,
      expected: { patient_id: actionPlan?.matchedPatient?.patient_id || null, patient_name: expectedName },
      actual: { screen_id: inferScreenId(), selected_patient_id: patientId, selected_patient_name: patientName, selected_appointment_id: selectedAppointmentId(), inspectionLoaded },
      reason: ok ? 'patient_opened' : (inspectionLoaded ? 'patient_not_opened' : 'inspection_not_loaded')
    };
  }
  if (intent === 'save_record' || intent === 'complete_service') {
    const screenId = inferScreenId();
    const statusText = document.querySelector('.status-pill')?.textContent?.trim() || '';
    const ok = screenId === 'schedule' || /выполнено/i.test(statusText);
    return {
      ok,
      expected: 'completed_or_schedule',
      actual: { screen_id: screenId, statusText },
      reason: ok ? 'record_saved_or_completed' : 'record_not_completed'
    };
  }
  if (intent === 'return_to_schedule') {
    const ok = inferScreenId() === 'schedule' && Boolean(document.querySelector('#schedule')) && visibleSlotCards().length > 0;
    return {
      ok,
      expected: 'schedule',
      actual: { screen_id: inferScreenId(), hash: window.location.hash, visibleSlots: visibleSlotCards().length },
      reason: ok ? 'schedule_opened' : 'schedule_not_opened'
    };
  }
  return {
    ok: true,
    expected: null,
    actual: { screen_id: inferScreenId() },
    reason: 'no_specific_verification'
  };
}

async function executeActionPlan(actionPlan = {}) {
  const results = [];
  if (actionPlan.intent === 'open_tab' && !(actionPlan.operations || []).length) {
    const target = TARGET_REGISTRY[actionPlan.actionTarget];
    if (!target) {
      return {
        ok: false,
        actionPlan,
        results,
        verification: { ok: false, reason: `Unknown target: ${actionPlan.actionTarget}` },
        failed: { reason: 'target_not_registered' }
      };
    }
    if (inferScreenId() === 'schedule') {
      const openResult = await openAppointmentFromVisibleSchedule(actionPlan.patientQuery || '');
      results.push(openResult);
      if (!openResult.ok) return { ok: false, actionPlan, results, verification: { ok: false, reason: openResult.reason }, failed: openResult };
    }
    results.push(await switchVisibleTab(target.tabKey, actionPlan.actionTarget));
  } else if (actionPlan.intent === 'save_record' || actionPlan.intent === 'complete_service') {
    return {
      ok: false,
      actionPlan,
      results,
      verification: { ok: false, reason: actionPlan.requires_confirmation ? 'confirmation_required' : 'save_blocked' },
      failed: { reason: actionPlan.requires_confirmation ? 'confirmation_required' : 'save_blocked' }
    };
  } else if (!(actionPlan.operations || []).length) {
    return {
      ok: false,
      actionPlan,
      results,
      verification: { ok: false, reason: 'action_plan_has_no_operations' },
      failed: { reason: 'action_plan_has_no_operations' }
    };
  } else {
    for (const operation of (actionPlan.operations || [])) {
      const result = await applyOperation(operation);
      results.push(result);
      if (!result.ok) {
        return { ok: false, actionPlan, results, verification: { ok: false, reason: result.reason || 'operation_failed' }, failed: result };
      }
    }
  }
  const verification = await verifyActionPlan(actionPlan);
  return {
    ok: results.every((result) => result.ok) && verification.ok,
    actionPlan,
    results,
    verification,
    failed: verification.ok ? null : verification
  };
}

async function executeAgentCommand(command) {
  const normalized = normalizeCommand(command);
  const results = [];

  if (/вернись|назад|расписани|график/.test(normalized) && inferScreenId() === 'inspection') {
    const before = window.location.hash;
    window.location.hash = '#/schedule';
    const schedule = await waitForSelector('#schedule', 7000);
    return {
      ok: Boolean(schedule),
      mode: 'direct-dom-command',
      command,
      results: [{ ok: Boolean(schedule), selector: 'window.location.hash', before, after: window.location.hash }]
    };
  }

  const tabTargets = [
    { pattern: /эпикриз|выписк/, tabKey: 'dischargeSummary', label: 'Выписной эпикриз' },
    { pattern: /медицинск.*запис|мед.*запис/, tabKey: 'medicalRecords', label: 'Медицинские записи' },
    { pattern: /диагноз/, tabKey: 'diagnoses', label: 'Диагнозы' },
    { pattern: /дневник/, tabKey: 'diaries', label: 'Дневниковые записи' },
    { pattern: /файл/, tabKey: 'files', label: 'Файлы' },
    { pattern: /назначен|назначение/, tabKey: 'inspection', label: 'Назначение' }
  ];
  const target = tabTargets.find((item) => item.pattern.test(normalized));
  if (target) {
    const openResult = await openAppointmentFromVisibleSchedule(command);
    results.push(openResult);
    if (!openResult.ok) return { ok: false, mode: 'direct-dom-command', command, results, failed: openResult };
    const tabResult = await switchVisibleTab(target.tabKey, target.label);
    results.push(tabResult);
    return {
      ok: tabResult.ok,
      mode: 'direct-dom-command',
      command,
      results,
      failed: tabResult.ok ? null : tabResult
    };
  }

  if (/открой|перейди|первичн|пациент|прием|осмотр/.test(normalized)) {
    const openResult = await openAppointmentFromVisibleSchedule(command);
    results.push(openResult);
    return {
      ok: openResult.ok,
      mode: 'direct-dom-command',
      command,
      results,
      failed: openResult.ok ? null : openResult
    };
  }

  if (/сохрани.*закрой|заверши/.test(normalized)) {
    return { ok: false, mode: 'direct-dom-command', command, results: [], failed: { reason: 'confirmation_required' } };
  }

  if (/сохрани/.test(normalized)) {
    return { ok: false, mode: 'direct-dom-command', command, results: [], failed: { reason: 'confirmation_required' } };
  }

  if (/отмет.*процедур.*выполн|выполнен/.test(normalized)) {
    return { ok: false, mode: 'direct-dom-command', command, results: [], failed: { reason: 'confirmation_required' } };
  }

  return {
    ok: false,
    mode: 'direct-dom-command',
    command,
    results: [],
    failed: { reason: 'Unsupported direct DOM command' }
  };
}

function highlightOperations(domOperations) {
  clearHighlights();
  for (const operation of domOperations) {
    const node = resolve(operation.selector);
    if (node) {
      node.classList.add(node.matches('.slot-card') ? 'active-highlight' : 'field-highlight');
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForSelector(selector, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const node = document.querySelector(selector);
    if (node) return node;
    await wait(60);
  }
  return null;
}

async function applyOperation(operation) {
  if (operation.type === 'set-value' || operation.type === 'set-checkbox-group') {
    ensureInspectionTabVisible();
  }

  if (operation.type === 'navigate-to-schedule') {
    const before = window.location.hash;
    window.location.hash = '#/schedule';
    if (operation.wait_for_selector) {
      await waitForSelector(operation.wait_for_selector);
    } else {
      await wait(80);
    }
    return { ok: true, selector: 'window.location.hash', before, after: window.location.hash, operation };
  }

  if (operation.type === 'navigate-hash') {
    const before = window.location.hash;
    window.location.hash = operation.hash;
    if (operation.wait_for_selector) {
      const arrived = await waitForSelector(operation.wait_for_selector);
      if (!arrived) {
        return { ok: false, selector: 'window.location.hash', before, after: window.location.hash, reason: `Selector not reached after navigation: ${operation.wait_for_selector}`, operation };
      }
    } else {
      await wait(100);
    }
    return { ok: true, selector: 'window.location.hash', before, after: window.location.hash, operation };
  }

  if (operation.type === 'open-appointment-tab') {
    const before = window.location.hash;
    window.location.hash = operation.hash;
    const inspection = await waitForSelector(operation.wait_for_selector || '#frmInspectionResult', 7000);
    if (!inspection) {
      return {
        ok: false,
        selector: 'window.location.hash',
        before,
        after: window.location.hash,
        reason: `Inspection screen did not load: ${operation.wait_for_selector || '#frmInspectionResult'}`,
        operation
      };
    }
    const tabSelector = operation.selector || `[data-action="switch-tab"][data-tab="${cssEscape(operation.tab_key)}"]`;
    const tabNode = await waitForSelector(tabSelector, 4000);
    if (!tabNode) {
      return {
        ok: false,
        selector: tabSelector,
        reason: `Tab not found after opening appointment: ${operation.tab_key || operation.label || 'unknown'}`,
        operation
      };
    }
    tabNode.click();
    await wait(100);
    return {
      ok: true,
      selector: tabSelector,
      before,
      after: window.location.hash,
      operation
    };
  }

  if (operation.type === 'open-link-by-label' || operation.type === 'open-document-by-title') {
    const label = normalizeLabel(operation.label || operation.title || operation.value);
    const candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"], [data-document-title]')).filter(visible);
    const target = candidates.find((candidate) => normalizeLabel(candidate.textContent || candidate.getAttribute('data-document-title')).includes(label));
    if (!target) return { ok: false, reason: `Visible DOM target not found for label: ${operation.label || operation.title}` };
    target.click?.();
    target.classList.add('field-highlight');
    return { ok: true, selector: selectorForNode(target), matched_label: target.textContent.trim(), operation };
  }

  const node = operation.wait_for_selector
    ? await waitForSelector(operation.wait_for_selector)
    : (operation.selector ? resolve(operation.selector) : null);
  if (!node) {
    if (operation.type === 'set-checkbox-group') {
      const group = resolveCheckboxGroup(operation);
      if (group) return applyCheckboxGroup(operation, group);
    }
    if (operation.optional) return { ok: true, skipped: true, selector: operation.selector };
    return { ok: false, reason: `Selector not found: ${operation.selector}` };
  }

  if (operation.type === 'highlight') {
    node.classList.add('field-highlight');
    return { ok: true, selector: operation.selector, operation };
  }

  if (operation.type === 'set-value') {
    const before = valueForNode(node);
    node.value = operation.value;
    dispatchValueChange(node);
    return { ok: true, selector: operation.selector, before, after: valueForNode(node), value: operation.value, operation };
  }

  if (operation.type === 'set-checkbox-group') {
    return applyCheckboxGroup(operation, node);
  }

  if (operation.type === 'switch-tab') {
    const target = operation.selector
      ? node
      : document.querySelector(`[data-action="switch-tab"][data-tab="${cssEscape(operation.tab_key)}"]`);
    if (!target) return { ok: false, reason: `Tab not found: ${operation.tab_key || operation.selector}` };
    target.click();
    return { ok: true, selector: operation.selector || selectorForNode(target), operation };
  }

  if (operation.type === 'verify-visible') {
    return { ok: visible(node), selector: operation.selector, text: node.textContent.trim(), operation };
  }

  if (operation.type === 'click') {
    node.click();
    return { ok: true, selector: operation.selector, operation };
  }

  return { ok: false, reason: `Unsupported operation: ${operation.type}` };
}

function applyCheckboxGroup(operation, node) {
  const selected = new Set(operation.values || []);
  const checkboxes = Array.from(node.querySelectorAll('input[type="checkbox"]'));
  const available = checkboxes.map((checkbox) => checkbox.dataset.optionKey);
  let checkedCount = 0;
  checkboxes.forEach((checkbox) => {
    const shouldCheck = selected.has(checkbox.dataset.optionKey);
    checkbox.checked = shouldCheck;
    if (shouldCheck) checkedCount += 1;
    dispatchValueChange(checkbox);
  });
  node.classList.add('field-highlight');
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const missing = [...selected].filter((key) => !available.includes(key));
  return {
    ok: missing.length === 0,
    selector: operation.selector,
    requested: [...selected],
    available,
    checkedCount,
    missing,
    reason: missing.length ? `Checkbox option not found: ${missing.join(', ')}` : undefined
  };
}

function fieldValueBySelectors(selectors = [], fallbackTerms = []) {
  const node = queryVisibleNodes(selectors)[0]
    || findSemanticNode({ role: 'field', candidateNames: fallbackTerms, labelCandidates: fallbackTerms, legacySelectors: selectors });
  return node ? valueForNode(node) : '';
}

function serializeInspectionPayload() {
  if (inferScreenId() !== 'inspection') {
    return { ok: false, error: 'inspection_not_open' };
  }
  const appointmentId = selectedAppointmentId();
  const sections = Array.from(document.querySelectorAll('[data-section-key]')).map((sectionNode) => {
    const sectionKey = sectionNode.getAttribute('data-section-key') || '';
    const checkboxes = Array.from(sectionNode.querySelectorAll('input[type="checkbox"]'));
    if (checkboxes.length) {
      return {
        section_key: sectionKey,
        kind: 'checkbox-group',
        selected_option_keys: checkboxes.filter((node) => node.checked).map((node) => node.dataset.optionKey).filter(Boolean)
      };
    }
    return {
      section_key: sectionKey,
      kind: 'text',
      text: sectionNode.querySelector('textarea')?.value || ''
    };
  });
  const payload = {
    appointment_id: appointmentId,
    execute_date: String(fieldValueBySelectors(['#dtpServiceExecuteDate', 'input[data-field-key="dtpserviceexecutedate"]'], ['дата выполнения']) || ''),
    execute_time: String(fieldValueBySelectors(['#dtpServiceExecuteTime', 'input[data-field-key="dtpserviceexecutetime"]'], ['время выполнения']) || ''),
    duration_min: Number(fieldValueBySelectors(['#ntbDurationMinute', 'input[data-field-key="ntbdurationminute"]'], ['длительность']) || 30),
    medical_post_id: String(fieldValueBySelectors(['#cmbExecuteMedicalPost', 'select[data-field-key="cmbexecutemedicalpost"]'], ['медицинский пост']) || ''),
    service_classifier_id: String(fieldValueBySelectors(['#cmbPerformerService', 'select[data-field-key="cmbperformerservice"]'], ['услуга классификатора']) || ''),
    service_price_item_id: String(fieldValueBySelectors(['#cmbPerformerServiceMo', 'select[data-field-key="cmbperformerservicemo"]'], ['услуга из прейскуранта']) || ''),
    medical_form_id: String(fieldValueBySelectors(['#cmbMedicalForm', 'select[data-field-key="cmbmedicalform"]'], ['форма']) || ''),
    medical_equipment_id: String(fieldValueBySelectors(['#cmbMedicalEquipment', 'select[data-field-key="cmbmedicalequipment"]'], ['медицинское оборудование']) || ''),
    conclusion_text: String(fieldValueBySelectors(['#tbMedicalFinal', 'textarea[data-field-key="tbmedicalfinal"]'], ['заключение']) || ''),
    medical_record_sections: sections,
    supplemental: {
      specialist_name: String(fieldValueBySelectors(['#supp-specialist'], ['фио специалиста']) || ''),
      completion_date: String(fieldValueBySelectors(['#supp-completionDate'], ['дата окончания осмотра']) || ''),
      work_plan: String(fieldValueBySelectors(['#supp-workPlan'], ['план работы']) || ''),
      planned_sessions: String(fieldValueBySelectors(['#supp-plannedSessions'], ['планируемых занятий']) || ''),
      completed_sessions: String(fieldValueBySelectors(['#supp-completedSessions'], ['проведенных занятий']) || ''),
      dynamics: String(fieldValueBySelectors(['#supp-dynamics'], ['динамика развития']) || ''),
      recommendations: String(fieldValueBySelectors(['#supp-recommendations'], ['рекомендации']) || '')
    }
  };
  return {
    ok: true,
    payload,
    screen_snapshot_hash: hashText(JSON.stringify({
      appointment_id: appointmentId,
      active_tab: activeTabKey(),
      payload
    }))
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ ok: true, screen_id: inferScreenId() });
    return true;
  }

  if (message.type === 'get-screen-context') {
    const screenState = inferScreenState();
    sendResponse({
      screen_id: screenState.screen_id,
      screen_type: screenState.screen_id,
      url: window.location.href,
      visible_tabs: visibleTabs(),
      visible_actions: visibleButtonActions(),
      visible_links: visibleLinks(),
      visible_documents: visibleDocuments(),
      visible_slot_cards: visibleSlotCards(),
      selected_patient_id: selectedPatientId(),
      selected_patient_name: selectedPatientName(),
      selected_appointment_id: selectedAppointmentId(),
      screen_confidence: screenState.confidence,
      screen_evidence: screenState.evidence,
      active_semantic_regions: screenState.active_regions,
      form_snapshot_hash: serializeInspectionPayload().ok ? serializeInspectionPayload().screen_snapshot_hash : '',
      dom_version: 'sandbox-v1'
    });
    return true;
  }

  if (message.type === 'serialize-inspection-form') {
    sendResponse(serializeInspectionPayload());
    return true;
  }

  if (message.type === 'highlight-preview') {
    highlightOperations(message.domOperations || []);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'update-advisor-question-overlay') {
    sendResponse(updateAdvisorQuestionOverlay(message.payload || {}));
    return true;
  }

  if (message.type === 'refresh-inspection-page-data') {
    window.dispatchEvent(new CustomEvent('damumed-assistant-refresh', {
      detail: { reason: message.reason || 'assistant' }
    }));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'apply-preview') {
    (async () => {
      clearHighlights();
      const results = [];
      for (const operation of (message.domOperations || [])) {
        const result = await applyOperation(operation);
        results.push(result);
        if (!result.ok) {
          sendResponse({ ok: false, results, failed: result });
          return;
        }
      }
      sendResponse({ ok: true, results, failed: null });
    })();
    return true;
  }

  if (message.type === 'execute-agent-command') {
    (async () => {
      clearHighlights();
      const result = await executeAgentCommand(message.command || '');
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'execute-action-plan') {
    (async () => {
      clearHighlights();
      const result = await executeActionPlan(message.actionPlan || {});
      sendResponse(result);
    })();
    return true;
  }
});
