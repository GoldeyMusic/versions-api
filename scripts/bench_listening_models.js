/**
 * bench_listening_models.js — banc d'essai des modèles Gemini pour l'ÉCOUTE.
 *
 * Fait écouter les MÊMES fichiers audio par plusieurs modèles Gemini et
 * compare les écoutes : chant détecté, points forts / à travailler, moments
 * cités (timecodes), longueur, coût estimé. Le genre n'est pas un champ de
 * l'écoute (il est inféré plus tard par Claude) : lire "impression" et
 * "par_categorie" à la main pour juger la finesse.
 *
 * Usage (depuis ~/versions-api, GEMINI_API_KEY dans .env.bench ou l'env) :
 *   node scripts/bench_listening_models.js --dir ~/Desktop/benchmark-mai --models gemini-2.5-flash,gemini-2.5-pro
 *   Options : --vocal vocal|instrumental (défaut vocal), --locale fr|en, --out scripts/bench_out
 *
 * Les fichiers acceptés : .wav .mp3 .flac .aiff .m4a (≤ 12 min comme en prod).
 * Chaque écoute coûte ~0,001 € (Flash) à ~0,03 € (Pro) ; rien n'est écrit en
 * base (pas de userId → le cache gemini_listening_cache n'est pas consulté
 * ni alimenté).
 */
const fs = require('fs');
const path = require('path');
const { loadEnvFile, parseArgs, ensureDir, stamp } = require('./_benchEnv');

loadEnvFile();
const args = parseArgs();
if (!process.env.GEMINI_API_KEY) { console.error('Manque GEMINI_API_KEY (env ou .env.bench)'); process.exit(1); }
if (!args.dir) { console.error('Usage : --dir <dossier audio> --models a,b'); process.exit(1); }

const DIR = path.resolve(String(args.dir).replace(/^~/, process.env.HOME || ''));
const MODELS = String(args.models || 'gemini-2.5-flash,gemini-2.5-pro').split(',').map((m) => m.trim()).filter(Boolean);
const VOCAL = args.vocal || 'vocal';
const LOCALE = args.locale || 'fr';
const OUT_DIR = ensureDir(path.resolve(args.out || path.join(__dirname, 'bench_out')));
const MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.m4a': 'audio/mp4' };

const gemini = require('../lib/gemini');

function describe(l) {
  if (!l) return null;
  const text = JSON.stringify(l);
  const timecodes = (text.match(/\b\d{1,2}:\d{2}\b/g) || []).length;
  return {
    chant: l.contient_chant,
    points_forts: (l.points_forts || []).length,
    a_travailler: (l.a_travailler || []).length,
    categories: Object.keys(l.par_categorie || {}).length,
    timecodes,
    chars: text.length,
    impression: (l.impression || '').slice(0, 220),
    potentiel: (l.potentiel || '').slice(0, 160),
  };
}

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => MIME[path.extname(f).toLowerCase()]).sort();
  if (!files.length) { console.error(`Aucun fichier audio dans ${DIR}`); process.exit(1); }
  console.log(`${files.length} fichier(s) · modèles : ${MODELS.join(', ')}`);
  const results = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DIR, f));
    const mime = MIME[path.extname(f).toLowerCase()];
    const title = path.basename(f, path.extname(f));
    const row = { file: f, runs: [] };
    for (const model of MODELS) {
      process.env.GEMINI_LISTEN_MODELS = model;
      gemini.resetUsage();
      const t0 = Date.now();
      let listening = null, err = null;
      try {
        listening = await gemini.analyzeListening(buf, mime, title, '', 'diag', VOCAL, LOCALE, {});
      } catch (e) { err = e.message; }
      const ms = Date.now() - t0;
      const usage = gemini.getUsage();
      const d = describe(listening);
      console.log(`→ ${f} · ${model} : ${err ? 'ERREUR ' + err : `${(ms / 1000).toFixed(1)} s · chant=${d.chant} · ${d.points_forts} PF / ${d.a_travailler} AT · ${d.timecodes} timecodes · ${usage.totalTokenCount} tok`}`);
      row.runs.push({ model, ms, usage, listening, err, d });
    }
    results.push(row);
  }
  const ts = stamp();
  fs.writeFileSync(path.join(OUT_DIR, `listening_${ts}.json`), JSON.stringify({ models: MODELS, results }, null, 2));
  const lines = [`# Banc d'essai écoute — ${ts}`, '', `Modèles : ${MODELS.join(', ')} · ${results.length} fichiers`, ''];
  lines.push(`| Fichier | Modèle | Durée (s) | Chant | Points forts | À travailler | Timecodes | Tokens |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of results) for (const x of r.runs) {
    lines.push(`| ${r.file} | ${x.model} | ${(x.ms / 1000).toFixed(1)} | ${x.err ? 'ERR' : x.d.chant} | ${x.err ? '' : x.d.points_forts} | ${x.err ? '' : x.d.a_travailler} | ${x.err ? '' : x.d.timecodes} | ${x.usage.totalTokenCount || ''} |`);
  }
  lines.push('', '## Impressions (lecture qualitative)', '');
  for (const r of results) {
    lines.push(`### ${r.file}`, '');
    for (const x of r.runs) lines.push(`- **${x.model}** : ${x.err || x.d.impression}`, `  - potentiel : ${x.err ? '' : x.d.potentiel}`);
    lines.push('');
  }
  const mdPath = path.join(OUT_DIR, `listening_${ts}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`\nRapport : ${mdPath}`);
})().catch((e) => { console.error(e); process.exit(1); });
