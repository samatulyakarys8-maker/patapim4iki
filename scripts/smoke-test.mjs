import assert from 'node:assert/strict';
import { buildArtifacts, seedRuntimeState } from '../lib/dataset.mjs';

const artifacts = buildArtifacts();
const runtime = seedRuntimeState(artifacts);

assert.ok(artifacts.screen_inventory.some((screen) => screen.screen_id === 'schedule'));
assert.ok(artifacts.screen_inventory.some((screen) => screen.screen_id === 'inspection'));
assert.ok(artifacts.field_map.some((field) => field.dom_id === 'tbMedicalFinal'));
assert.ok(artifacts.locator_registry.some((locator) => locator.preferred_selector === '#frmInspectionResult'));
assert.equal(runtime.scheduleDays.length, 9);
assert.ok(Object.values(runtime.appointments).some((appointment) => appointment.status === 'completed'));

console.log('Smoke test passed');
