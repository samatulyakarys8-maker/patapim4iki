import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArtifacts } from '../lib/dataset.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.resolve(__dirname, '../data/generated');

const artifacts = await writeArtifacts(outputDir);
console.log(`Generated source-of-truth artifacts in ${outputDir}`);
console.log(`Screens: ${artifacts.screen_inventory.length}`);
console.log(`Fields: ${artifacts.field_map.length}`);
console.log(`Locators: ${artifacts.locator_registry.length}`);
