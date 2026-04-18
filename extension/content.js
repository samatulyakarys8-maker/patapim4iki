function normalizeLabel(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeCommand(input) {
  return normalizeLabel(input).replace(/ё/g, 'е');
}

const TARGET_REGISTRY = {
  'medical-records': {
    selector: '[data-action="switch-tab"][data-tab="medicalRecords"]',
    tabKey: 'medicalRecords',
    verify: { activeTab: 'medicalRecords' }
  },
  assignments: {
    selector: '[data-action="switch-tab"][data-tab="assignments"]',
    tabKey: 'assignments',
    verify: { activeTab: 'assignments' }
  },
  diaries: {
    selector: '[data-action="switch-tab"][data-tab="diaries"]',
    tabKey: 'diaries',
    verify: { activeTab: 'diaries' }
  },
  diagnoses: {
    selector: '[data-action="switch-tab"][data-tab="diagnoses"]',
    tabKey: 'diagnoses',
    verify: { activeTab: 'diagnoses' }
  },
  files: {
    selector: '[data-action="switch-tab"][data-tab="files"]',
    tabKey: 'files',
    verify: { activeTab: 'files' }
  },
  'discharge-summary': {
    selector: '[data-action="switch-tab"][data-tab="dischargeSummary"]',
    tabKey: 'dischargeSummary',
    verify: { activeTab: 'dischargeSummary' }
  },
  'audit-log': {
    selector: '[data-action="show-slot-audit"]',
    tabKey: null,
    verify: { toast: true }
  }
};

function visible(node) {
  return Boolean(node && node.offsetParent !== null);
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

function inferScreenId() {
  if (document.querySelector('#frmInspectionResult')) return 'inspection';
  if (document.querySelector('#schedule')) return 'schedule';
  return document.querySelector('[data-screen]')?.getAttribute('data-screen') || 'unknown';
}

function selectedAppointmentId() {
  if (inferScreenId() !== 'inspection') return null;
  const match = window.location.hash.match(/inspection\/([^/]+)/);
  if (match) return match[1];
  return document.querySelector('[data-appointment-id]')?.getAttribute('data-appointment-id') || null;
}

function selectedPatientId() {
  if (inferScreenId() !== 'inspection') return null;
  return document.querySelector('[data-screen="inspection"][data-patient-id]')?.getAttribute('data-patient-id')
    || document.querySelector('[data-patient-id]')?.getAttribute('data-patient-id')
    || null;
}

function selectedPatientName() {
  if (inferScreenId() !== 'inspection') return null;
  return document.querySelector('[data-screen="inspection"][data-patient-name]')?.getAttribute('data-patient-name')
    || document.querySelector('[data-patient-name]')?.getAttribute('data-patient-name')
    || null;
}

function activeTabKey() {
  return document.querySelector('[data-action="switch-tab"].active')?.getAttribute('data-tab') || null;
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

function sectionKeyFromSelector(selector) {
  const match = String(selector || '').match(/data-section-key=["']([^"']+)["']/);
  return match?.[1] || null;
}

function ensureInspectionTabVisible() {
  if (document.querySelector('#frmInspectionResult')) return true;
  const tabButton = document.querySelector('[data-action="switch-tab"][data-tab="inspection"]');
  if (!tabButton) return false;
  tabButton.click();
  return Boolean(document.querySelector('#frmInspectionResult'));
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
  if (inferScreenId() === 'inspection' && document.querySelector('#frmInspectionResult')) {
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
  const button = card.querySelector('[data-action="open-inspection"]');
  if (!button) {
    return { ok: false, selector: selectorForNode(card), reason: 'Appointment card has no open button' };
  }
  const before = window.location.hash;
  button.click();
  const loaded = await waitForSelector('#frmInspectionResult', 7000);
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
  const tab = await waitForSelector(selector, 5000);
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
    const ok = registryItem?.verify?.activeTab ? activeTab === registryItem.verify.activeTab : Boolean(document.querySelector(registryItem?.selector || ''));
    return {
      ok,
      expected: registryItem?.verify || null,
      actual: { screen_id: inferScreenId(), activeTab },
      reason: ok ? 'target_tab_active' : 'target_tab_not_active'
    };
  }
  if (intent === 'open_patient') {
    const patientName = selectedPatientName();
    const expectedName = actionPlan?.matchedPatient?.full_name || actionPlan?.patientQuery || '';
    const expectedTokens = commandTokens(expectedName);
    const normalizedPatientName = normalizeCommand(patientName || '');
    const ok = inferScreenId() === 'inspection' && (
      !expectedTokens.length || expectedTokens.some((token) => normalizedPatientName.includes(normalizeCommand(token)))
    );
    return {
      ok,
      expected: expectedName,
      actual: { screen_id: inferScreenId(), selected_patient_name: patientName, selected_appointment_id: selectedAppointmentId() },
      reason: ok ? 'patient_opened' : 'patient_not_opened'
    };
  }
  if (intent === 'save_record' || intent === 'complete_service') {
    const ok = inferScreenId() === 'schedule' || Boolean(document.querySelector('.status-pill.completed'));
    return {
      ok,
      expected: 'completed_or_schedule',
      actual: { screen_id: inferScreenId(), statusText: document.querySelector('.status-pill')?.textContent?.trim() || '' },
      reason: ok ? 'record_saved_or_completed' : 'record_not_completed'
    };
  }
  if (intent === 'return_to_schedule') {
    const ok = inferScreenId() === 'schedule';
    return {
      ok,
      expected: 'schedule',
      actual: { screen_id: inferScreenId(), hash: window.location.hash },
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
  } else if (actionPlan.intent === 'save_record') {
    const selector = actionPlan.actionTarget === 'save-and-close' ? '#btnSaveAndCloseInspectionResult' : '#btnSaveInspectionResult';
    const button = document.querySelector(selector);
    if (!button) {
      return { ok: false, actionPlan, results, verification: { ok: false, reason: 'save_button_not_found' }, failed: { selector, reason: 'save_button_not_found' } };
    }
    button.click();
    await wait(350);
    results.push({ ok: true, selector, reason: 'save_button_clicked' });
  } else if (actionPlan.intent === 'complete_service') {
    const button = document.querySelector('#btnSaveAndCloseInspectionResult') || document.querySelector('#btnSaveInspectionResult');
    if (!button) {
      return { ok: false, actionPlan, results, verification: { ok: false, reason: 'complete_button_not_found' }, failed: { reason: 'complete_button_not_found' } };
    }
    button.click();
    await wait(350);
    results.push({ ok: true, selector: selectorForNode(button), reason: 'complete_service_clicked' });
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
    const button = document.querySelector('#btnSaveAndCloseInspectionResult');
    if (!button) return { ok: false, mode: 'direct-dom-command', command, results: [], failed: { reason: 'Save and close button not found' } };
    button.click();
    return { ok: true, mode: 'direct-dom-command', command, results: [{ ok: true, selector: '#btnSaveAndCloseInspectionResult' }] };
  }

  if (/сохрани/.test(normalized)) {
    const button = document.querySelector('#btnSaveInspectionResult');
    if (!button) return { ok: false, mode: 'direct-dom-command', command, results: [], failed: { reason: 'Save button not found' } };
    button.click();
    return { ok: true, mode: 'direct-dom-command', command, results: [{ ok: true, selector: '#btnSaveInspectionResult' }] };
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ ok: true, screen_id: inferScreenId() });
    return true;
  }

  if (message.type === 'get-screen-context') {
    sendResponse({
      screen_id: inferScreenId(),
      screen_type: inferScreenId(),
      url: window.location.href,
      visible_tabs: visibleTabs(),
      visible_actions: visibleButtonActions(),
      visible_links: visibleLinks(),
      visible_documents: visibleDocuments(),
      selected_patient_id: selectedPatientId(),
      selected_patient_name: selectedPatientName(),
      selected_appointment_id: selectedAppointmentId(),
      dom_version: 'sandbox-v1'
    });
    return true;
  }

  if (message.type === 'highlight-preview') {
    highlightOperations(message.domOperations || []);
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
