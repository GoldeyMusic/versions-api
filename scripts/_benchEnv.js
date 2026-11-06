/**
 * _benchEnv.js — helpers partagés par les scripts de banc d'essai.
 *
 * - loadEnvFile() : charge `.env.bench` (racine du repo, gitignoré via `.env.*`)
 *   dans process.env SANS écraser les variables déjà posées. Format KEY=VALUE,
 *   lignes vides et `#` ignorés. Les clés restent sur le Mac, jamais en repo.
 * - parseArgs()   : `--models a,b --limit 10 --versions id1,id2 --out dir`.
 * - ensureDir()   : mkdir -p.
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(file = path.join(__dirname, '..', '.env.bench')) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
  return true;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[k] = true; }
      else { out[k] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

module.exports = { loadEnvFile, parseArgs, ensureDir, stamp };
