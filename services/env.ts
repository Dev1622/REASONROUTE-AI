import fs from 'fs';
import path from 'path';

let loaded = false;

export function ensureLocalEnvLoaded() {
  if (loaded) return;
  loaded = true;

  const candidates = ['.env.local', '.env'];
  for (const fileName of candidates) {
    const fullPath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(fullPath)) continue;
    const raw = fs.readFileSync(fullPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

