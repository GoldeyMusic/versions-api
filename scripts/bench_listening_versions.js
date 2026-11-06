#!/usr/bin/env node
/**
 * bench_listening_versions.js — rejoue l'ÉCOUTE (lib/gemini.js) sur des
 * versions déjà en base, en téléchargeant l'audio stocké (bucket "audio").
 * Sert à tester les changements de prompt d'écoute (ex. D.2 : genre_estime)
 * sans fichier local. Rien n'est écrit en base (pas de userId → pas de cache).
 *
 * Usage (depuis ~/versions-api, clés dans .env.bench) :
 *   node scripts/bench_listening_versions.js --versions <uuid>,<uuid> [--models gemini-3.8-flash] [--locale fr]
 *
 * Nécessite : GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
const path = require('path');
const fs = require('fs');
const { loadEnvFile, parseArgs, ensureDir } = require('./_benchEnv');
loadEnvFile();
const args = parseArgs(process.argv.slice(2));

for (const k of ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[k]) { console.error(`Manque ${k} (env ou .env.bench)`); process.exit(1); }
}
if (!args.versions) { console.error('Usage : --versions <uuid>,<uuid> [--models a,b]'); process.exit(1); }

const VERSION_IDS = String(args.versions).split(',').map((v) => v.trim()).filter(Boolean);
const MODELS = String(args.models || 'gemini-3.8-flash').split(',').map((m) => m.trim()).filter(Boolean);
const LOCALE = args.locale || 'fr';
const OUT_DIR = ensureDir(path.resolve(args.out || path.join(__dirname, 'bench_out')));

const { createClient } = require('@supabase/supabase-js');
const gemini = require('../lib/gemini');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function describe(l) {
  if (!l) return null;
  return {
    chant: l.contient_chant,
    genre: l.genre_estime || '',
    genre_indices: l.genre_indices || '',
    points_forts: l.points_forts || [],
    a_travailler: l.a_travailler || [],
    impression: l.impression || '',
    potentiel: l.potentiel || '',
  };
}

(async () => {
  const { data: versions, error } = await sb
    .from('versions')
    .select('id, name, storage_path, declared_genre, inferred_genre, tracks!inner(title, vocal_type)')
    .in('id', VERSION_IDS);
  if (error) throw error;
  if (!versions?.length) { console.error('Aucune version trouvée'); process.exit(1); }
  console.log(`${versions.length} version(s) · modèles : ${MODELS.join(', ')}`);

  const results = [];
  for (const v of versions) {
    const title = v.tracks?.title || 'Titre inconnu';
    if (!v.storage_path) { console.log(`→ ${title} / ${v.name} : pas d'audio stocké, ignoré`); continue; }
    const { data: blob, error: dlErr } = await sb.storage.from('audio').download(v.storage_path);
    if (dlErr) { console.log(`→ ${title} / ${v.name} : téléchargement KO (${dlErr.message})`); continue; }
    const buf = Buffer.from(await blob.arrayBuffer());
    const mime = v.storage_path.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    const vocal = v.tracks?.vocal_type === 'instrumental_final' || v.tracks?.vocal_type === 'instrumental_pending' ? 'instrumental' : 'vocal';
    const row = { versionId: v.id, title, version: v.name, stored: { declared_genre: v.declared_genre, inferred_genre: v.inferred_genre }, runs: [] };
    for (const model of MODELS) {
      process.env.GEMINI_LISTEN_MODELS = model;
      gemini.resetUsage();
      const t0 = Date.now();
      let listening = null, err = null;
      try {
        listening = await gemini.analyzeListening(buf, mime, title, '', 'diag', vocal, LOCALE, { skipCache: true });
      } catch (e) { err = e.message; }
      const ms = Date.now() - t0;
      const d = describe(listening);
      if (err) {
        console.log(`→ ${title} / ${v.name} · ${model} : ERREUR ${err}`);
      } else {
        console.log(`→ ${title} / ${v.name} · ${model} : ${(ms / 1000).toFixed(1)} s`);
        console.log(`   genre estimé : ${d.genre || '?'}  (en base : déclaré=${v.declared_genre || '—'}, inféré=${v.inferred_genre || '—'})`);
        if (d.genre_indices) console.log(`   indices      : ${d.genre_indices}`);
        if (d.a_travailler.length) console.log(`   à travailler : ${d.a_travailler.map((x) => '\n     - ' + x).join('')}`);
        else console.log('   à travailler : (vide)');
      }
      row.runs.push({ model, ms, err, listening, d });
    }
    results.push(row);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(OUT_DIR, `listening_versions_${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ models: MODELS, results }, null, 2));
  console.log(`\nDétail : ${outPath}`);
})().catch((e) => { console.error(e); process.exit(1); });
