import { loadConfigFile } from '../config.js';

const path = process.argv[2] ?? 'config/tollgate.yaml';
try {
  const config = loadConfigFile(path);
  const aliases = Object.keys(config.aliases);
  console.log(`${path}: ok (${Object.keys(config.providers).length} providers, ${aliases.length} aliases: ${aliases.join(', ')})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
