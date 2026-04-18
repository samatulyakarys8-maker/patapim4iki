export function shouldCreateBackendSpeechSession(screenId) {
  return screenId === 'inspection';
}

export function transcriptRouteForScreen(screenId) {
  return screenId === 'inspection' ? 'ingest' : 'observe';
}

export function agentGreeting() {
  return 'На связи Патапим. Чем вам помочь?';
}
