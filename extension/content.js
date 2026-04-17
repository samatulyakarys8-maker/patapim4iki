function visibleButtonActions() {
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((node) => node.offsetParent !== null)
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function inferScreenId() {
  if (document.querySelector('#frmInspectionResult')) return 'inspection';
  if (document.querySelector('#schedule')) return 'schedule';
  return document.querySelector('[data-screen]')?.getAttribute('data-screen') || 'unknown';
}

function selectedAppointmentId() {
  const match = window.location.hash.match(/inspection\/([^/]+)/);
  if (match) return match[1];
  return document.querySelector('[data-appointment-id]')?.getAttribute('data-appointment-id') || null;
}

function selectedPatientId() {
  return document.querySelector('[data-patient-id]')?.getAttribute('data-patient-id') || null;
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

function applyOperation(operation) {
  if (operation.type === 'set-value' || operation.type === 'set-checkbox-group') {
    ensureInspectionTabVisible();
  }

  const node = resolve(operation.selector);
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
    return { ok: true };
  }

  if (operation.type === 'set-value') {
    node.value = operation.value;
    dispatchValueChange(node);
    return { ok: true, selector: operation.selector, value: operation.value };
  }

  if (operation.type === 'set-checkbox-group') {
    return applyCheckboxGroup(operation, node);
  }

  if (operation.type === 'click') {
    node.click();
    return { ok: true, selector: operation.selector };
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
      visible_tabs: Array.from(document.querySelectorAll('[data-tab]')).map((node) => node.dataset.tab),
      visible_actions: visibleButtonActions(),
      selected_patient_id: selectedPatientId(),
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
    clearHighlights();
    const results = (message.domOperations || []).map(applyOperation);
    const failed = results.find((result) => !result.ok);
    sendResponse({ ok: !failed, results, failed });
    return true;
  }
});
