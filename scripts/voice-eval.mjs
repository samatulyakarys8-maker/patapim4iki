import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifacts, seedRuntimeState } from '../lib/dataset.mjs';
import {
  extractPatientQuery,
  parseVoiceCommand,
  resolvePatientQuery
} from '../lib/command-router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/voice_eval_cases.json'), 'utf8'));

const runtime = seedRuntimeState(buildArtifacts());
const lexicon = runtime.voiceLexicon;

let commandCorrect = 0;
for (const item of cases.commands) {
  const parsed = parseVoiceCommand(item.text, { lexicon });
  assert.equal(parsed.intent, item.intent, `intent mismatch for: ${item.text}`);
  assert.equal(parsed.actionTarget, item.actionTarget, `target mismatch for: ${item.text}`);
  commandCorrect += 1;
}

let patientCorrect = 0;
for (const item of cases.patients) {
  const parsed = parseVoiceCommand(item.text, { lexicon });
  const query = parsed.patientQuery || extractPatientQuery(item.text);
  const resolved = resolvePatientQuery(query, runtime.patients, { lexicon });
  assert.equal(resolved.status, 'matched', `patient not matched for: ${item.text}`);
  assert.equal(resolved.matchedPatient.patient_id, item.patientId, `patient mismatch for: ${item.text}`);
  patientCorrect += 1;
}

for (const item of cases.ambiguous) {
  const parsed = parseVoiceCommand(item.text, { lexicon });
  const query = parsed.patientQuery || extractPatientQuery(item.text);
  const resolved = resolvePatientQuery(query, runtime.patients, { lexicon });
  assert.equal(resolved.status, item.status, `ambiguity mismatch for: ${item.text}`);
}

for (const text of cases.falseTriggers) {
  const parsed = parseVoiceCommand(text, { lexicon });
  assert.equal(parsed.intent, 'unknown', `false trigger should stay unknown: ${text}`);
}

console.log(JSON.stringify({
  ok: true,
  commandAccuracy: `${commandCorrect}/${cases.commands.length}`,
  patientTop1Accuracy: `${patientCorrect}/${cases.patients.length}`,
  ambiguousCases: cases.ambiguous.length,
  falseTriggers: cases.falseTriggers.length
}, null, 2));
