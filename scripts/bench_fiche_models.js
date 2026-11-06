/**
 * bench_fiche_models.js — banc d'essai des modèles Claude pour la FICHE.
 *
 * Rejoue generateFiche() sur des analyses DÉJÀ en base (écoute Gemini,
 * mesures DSP/Fadr, intention, genre, upload_type tels qu'ils ont été
 * utilisés à l'époque) avec plusieurs modèles, et sort un comparatif.
 * Aucune écoute Gemini ni Fadr n'est relancée : seul Claude (et l'embedding
 * OpenAI du RAG, négligeable) est facturé. ~0,05–0,15 € par titre et par
 * modèle. Rien n'est écrit en base.
 *
 * Usage (depuis ~/versions-api, clés dans .env.bench ou l'environnement) :
 *   node scripts/bench_fiche_models.js --models claude-sonnet-4-6,claude-sonnet-5-5,claude-opus-5-5 --limit 10
 *   node scripts/bench_fiche_models.js --models claude-sonnet-5-5 --versions <uuid>,<uuid>
 *   node scripts/bench_fiche_models.js --models claude-opus-5-5 --limit 10 --email berdugo.david@gmail.com
 *   Options : --no-rag (sans extraits PureMix), --out scripts/bench_out
 *
 * Env requis : ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *              SUPABASE_ANON_KEY + OPENAI_API_KEY (RAG ; absents → RAG ignoré).
 *
 * Sortie : scripts/bench_out/fiche_<timestamp>.md (tableau lisible) +
 *          fiche_<timestamp>.json (toutes les fiches, pour relecture).
 *
 * Ce qu'on compare par titre et par modèle :
 *   - globalScore, verdict (readiness), nb d'items high/med/low, nature artistic
 *   - score moyen par catégorie, écart au globalScore de la fiche de référence
 *     (celle en base, produite par le modèle de l'époque)
 *   - tokens in/out, durée, coût estimé
 * La lecture qualitative (cohérence, respect du genre, lisibilité du summary)
 * reste à faire à la main dans le .md.
 */
const fs = require('fs');
const path = require('path');
const { loadEnvFile, parseArgs, ensureDir, stamp } = require('./_benchEnv');

loadEnvFile();
const args = parseArgs();

const MODELS = String(args.models || 'claude-sonnet-4-6,claude-sonnet-5-5').split(',').map((m) => m.trim()).filter(Boolean);
const LIMIT = Math.max(1, Math.min(50, parseInt(args.limit || '10', 10) || 10));
const VERSION_IDS = args.versions ? String(args.versions).split(',').map((v) => v.trim()).filter(Boolean) : null;
const EMAIL = args.email ? String(args.email).trim().toLowerCase() : null;
// Le RAG (lib/rag.js) lit SUPABASE_ANON_KEY (pas la service role) + OPENAI_API_KEY.
const USE_RAG = !args['no-rag'] && !!process.env.OPENAI_API_KEY && !!process.env.SUPABASE_ANON_KEY;
if (!args['no-rag'] && !USE_RAG) console.warn('RAG désactivé : il faut OPENAI_API_KEY et SUPABASE_ANON_KEY dans .env.bench');
const OUT_DIR = ensureDir(path.resolve(args.out || path.join(__dirname, 'bench_out')));

for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[k]) { console.error(`Manque ${k} (env ou .env.bench)`); process.exit(1); }
}

const { createClient } = require('@supabase/supabase-js');
const claude = require('../lib/claude');
const rag = require('../lib/rag');
const { computeCosts } = require('../lib/costTracker');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function loadVersions() {
  let userFilter = null;
  if (EMAIL) {
    const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    const u = (data.users || []).find((x) => (x.email || '').toLowerCase() === EMAIL);
    if (!u) throw new Error(`Utilisateur introuvable : ${EMAIL}`);
    userFilter = u.id;
  }
  let q = sb.from('versions')
    .select('id, name, created_at, analysis_result, upload_type, version_intent, declared_genre, genre_inferred_by_ai, track_id, tracks!inner(id, title, user_id, artistic_intent, vocal_type)')
    .not('analysis_result', 'is', null)
    .order('created_at', { ascending: false });
  if (VERSION_IDS) q = q.in('id', VERSION_IDS);
  else q = q.limit(LIMIT * 3);
  if (userFilter) q = q.eq('tracks.user_id', userFilter);
  const { data, error } = await q;
  if (error) throw error;
  const usable = (data || []).filter((v) => v.analysis_result && v.analysis_result.listening && v.analysis_result.fiche);
  return VERSION_IDS ? usable : usable.slice(0, LIMIT);
}

function mergedMetrics(ar) {
  const fadrMetrics = ar.fadrMetrics || null, dspMetrics = ar.dspMetrics || null;
  const stemsMetrics = ar.stemsMetrics || null, stereoMetrics = ar.stereoMetrics || null;
  const hasAny = fadrMetrics || dspMetrics || stemsMetrics || stereoMetrics;
  if (!hasAny) return null;
  return {
    ...(fadrMetrics || {}),
    ...(dspMetrics ? {
      lufs: dspMetrics.lufs ?? (fadrMetrics?.lufs ?? null),
      lra: dspMetrics.lra ?? null,
      truePeak: dspMetrics.truePeak ?? null,
    } : {}),
    stemsMeasured: stemsMetrics || null,
    stereo: stereoMetrics || null,
  };
}

function summarize(fiche) {
  if (!fiche) return null;
  const cats = [];
  let high = 0, med = 0, low = 0, artistic = 0, n = 0;
  for (const el of fiche.elements || []) {
    const items = el.items || [];
    const scores = items.map((it) => Number(it.score)).filter(Number.isFinite);
    cats.push({ cat: el.cat, n: items.length, avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null });
    for (const it of items) {
      n++;
      if (it.priority === 'high') high++; else if (it.priority === 'med') med++; else low++;
      if (it.nature === 'artistic') artistic++;
    }
  }
  return {
    globalScore: fiche.globalScore ?? null,
    summary: fiche.summary || '',
    items: n, high, med, low, artistic, cats,
  };
}

async function runOne(v, model) {
  const ar = v.analysis_result;
  const listening = ar.listening;
  const title = v.tracks?.title || 'Titre inconnu';
  const daw = ar.fiche?.daw || 'Logic Pro';
  const mode = ar.fiche?.mode === 'ref' ? 'ref' : 'diag';
  const intent = v.version_intent || v.tracks?.artistic_intent || ar.intent_used || null;
  const declaredGenre = v.declared_genre || null;
  const genreUnknown = !declaredGenre;
  const uploadType = v.upload_type || 'mix';
  let pmContext = '';
  if (USE_RAG) {
    try {
      const chunks = await rag.retrievePureMixContext(listening);
      pmContext = rag.formatContextForPrompt(chunks);
    } catch (e) { console.warn('  rag KO:', e.message); }
  }
  process.env.CLAUDE_FICHE_MODEL = model;
  claude.resetUsage();
  const t0 = Date.now();
  let fiche = null, err = null;
  try {
    fiche = await claude.generateFiche(mode, daw, title, '', listening, pmContext, null, intent, null, mergedMetrics(ar), declaredGenre, genreUnknown, uploadType);
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  const usage = claude.getUsage();
  const cost = computeCosts({ claudeUsage: usage, fadrCalled: false, geminiUsage: {} });
  return { model, ms, usage, claude_eur: cost.claude_eur, fiche, err, summary: summarize(fiche) };
}

function fmtRow(cells) { return `| ${cells.join(' | ')} |`; }

(async () => {
  console.log(`Modèles : ${MODELS.join(', ')} · RAG : ${USE_RAG ? 'oui' : 'non'}`);
  const versions = await loadVersions();
  if (!versions.length) { console.error('Aucune version exploitable (analysis_result avec listening + fiche).'); process.exit(1); }
  console.log(`${versions.length} titre(s) :`);
  versions.forEach((v) => console.log(`  - ${v.tracks?.title} / ${v.name} (${v.id})`));

  const results = [];
  for (const v of versions) {
    const ref = summarize(v.analysis_result.fiche);
    const row = { versionId: v.id, title: v.tracks?.title, version: v.name, created_at: v.created_at, reference: ref, runs: [] };
    for (const model of MODELS) {
      process.stdout.write(`→ ${v.tracks?.title} / ${v.name} · ${model} … `);
      const r = await runOne(v, model);
      console.log(r.err ? `ERREUR ${r.err}` : `score ${r.summary?.globalScore} · ${(r.ms / 1000).toFixed(1)} s · ${r.usage.input_tokens}/${r.usage.output_tokens} tok · ${r.claude_eur.toFixed(3)} €`);
      row.runs.push(r);
    }
    results.push(row);
  }

  const ts = stamp();
  const jsonPath = path.join(OUT_DIR, `fiche_${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ models: MODELS, useRag: USE_RAG, results }, null, 2));

  const lines = [];
  lines.push(`# Banc d'essai fiche — ${ts}`, '', `Modèles : ${MODELS.join(', ')} · RAG : ${USE_RAG ? 'oui' : 'non'} · ${results.length} titres`, '');
  lines.push('## Scores globaux', '');
  lines.push(fmtRow(['Titre', 'Réf. en base', ...MODELS]));
  lines.push(fmtRow(['---', '---', ...MODELS.map(() => '---')]));
  for (const r of results) {
    lines.push(fmtRow([`${r.title} / ${r.version}`, r.reference?.globalScore ?? '—', ...r.runs.map((x) => x.err ? 'ERR' : `${x.summary.globalScore} (${x.summary.high}H/${x.summary.med}M/${x.summary.low}L)`)]));
  }
  lines.push('', '## Coût et latence (moyennes par modèle)', '');
  lines.push(fmtRow(['Modèle', 'Durée moy. (s)', 'Tokens in', 'Tokens out', 'Coût moy. (€)', 'Erreurs']));
  lines.push(fmtRow(['---', '---', '---', '---', '---', '---']));
  for (const m of MODELS) {
    const runs = results.flatMap((r) => r.runs.filter((x) => x.model === m));
    const ok = runs.filter((x) => !x.err);
    const avg = (f) => ok.length ? (ok.reduce((a, x) => a + f(x), 0) / ok.length) : 0;
    lines.push(fmtRow([m, (avg((x) => x.ms) / 1000).toFixed(1), Math.round(avg((x) => x.usage.input_tokens)), Math.round(avg((x) => x.usage.output_tokens)), avg((x) => x.claude_eur).toFixed(3), String(runs.length - ok.length)]));
  }
  lines.push('', '## Écart au score de référence (moyenne des |Δ|, plus bas = plus proche de la fiche existante)', '');
  for (const m of MODELS) {
    const d = results.map((r) => { const x = r.runs.find((y) => y.model === m); return (x && !x.err && r.reference?.globalScore != null) ? Math.abs(x.summary.globalScore - r.reference.globalScore) : null; }).filter((v) => v != null);
    lines.push(`- ${m} : ${d.length ? (d.reduce((a, b) => a + b, 0) / d.length).toFixed(1) : '—'} points`);
  }
  lines.push('', '## Summaries (lecture qualitative)', '');
  for (const r of results) {
    lines.push(`### ${r.title} / ${r.version}`, '');
    lines.push(`- Référence (${r.reference?.globalScore}) : ${r.reference?.summary || ''}`);
    for (const x of r.runs) lines.push(`- ${x.model} (${x.err ? 'ERR' : x.summary.globalScore}) : ${x.err || x.summary.summary}`);
    lines.push('');
  }
  const mdPath = path.join(OUT_DIR, `fiche_${ts}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`\nRapport : ${mdPath}\nDétail  : ${jsonPath}`);
})().catch((e) => { console.error(e); process.exit(1); });
