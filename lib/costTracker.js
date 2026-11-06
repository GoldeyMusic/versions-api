/**
 * costTracker.js — calcul du coût d'une analyse + insertion en base.
 *
 * Utilisé à la fin de runDiagnosticPhase (api/analyze.js). Lit les
 * accumulators de gemini.js et claude.js (tokens captés en cours
 * d'analyse), additionne avec les forfaits Fadr/infra, et insère
 * une ligne dans la table Supabase `analysis_cost_logs`.
 *
 * Les tarifs ci-dessous sont des CONSTANTES — David peut les
 * ajuster ici quand il aura ses vrais chiffres de facturation.
 * Tarifs en EUR par 1M tokens (conversion approximative depuis
 * les tarifs USD officiels au 1 USD ≈ 0,92 EUR).
 *
 * Ne plante pas le pipeline si l'insertion échoue : on log
 * l'erreur et on continue (le coût manqué = bug à investiguer
 * mais l'analyse de l'utilisateur reste réussie).
 */

const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────
// TARIFS (€ par 1M tokens). Ajuste-les ici si nécessaire.
// Sources :
//   Gemini : https://ai.google.dev/pricing (octobre 2025)
//   Claude : https://www.anthropic.com/pricing (Sonnet 4.6)
//
// Conversion USD → EUR à 0.92.
// ─────────────────────────────────────────────────────────────

// Gemini 2.5 Flash (modèle prioritaire dans gemini.js — fallback Pro)
// $0.075 / 1M input audio, $0.30 / 1M output → en EUR
const GEMINI_FLASH_IN_EUR_PER_1M = 0.069;
const GEMINI_FLASH_OUT_EUR_PER_1M = 0.276;

// Gemini 2.5 Pro (fallback) — plus cher
// $1.25 / 1M input audio, $5.00 / 1M output
const GEMINI_PRO_IN_EUR_PER_1M = 1.15;
const GEMINI_PRO_OUT_EUR_PER_1M = 4.60;

// Claude Sonnet 4.6 — $3 / 1M input, $15 / 1M output
const CLAUDE_SONNET_IN_EUR_PER_1M = 2.76;
const CLAUDE_SONNET_OUT_EUR_PER_1M = 13.80;

// Tarifs par modèle (USD/M tokens × 0.92), pour que le coût logué reste juste
// quand CLAUDE_FICHE_MODEL change (audit 2026-11-05). Grilles publiques
// relevées le 2026-11-05 — à recaler sur docs.claude.com avant bascule prod.
// Clé = préfixe d'identifiant (startsWith), premier match gagnant.
const CLAUDE_RATES = [
  { prefix: 'claude-opus-5',   in: 3.68, out: 18.40 },  // 4 $ / 20 $
  { prefix: 'claude-sonnet-5', in: 1.84, out: 9.20 },   // 2 $ / 10 $
  { prefix: 'claude-haiku-5',  in: 0.92, out: 4.60 },   // hypothèse = Haiku 4.5
  { prefix: 'claude-haiku-4',  in: 0.92, out: 4.60 },   // 1 $ / 5 $
  { prefix: 'claude-sonnet-4', in: CLAUDE_SONNET_IN_EUR_PER_1M, out: CLAUDE_SONNET_OUT_EUR_PER_1M },
];
function claudeRates(model) {
  const m = String(model || '').toLowerCase();
  const hit = CLAUDE_RATES.find((r) => m.startsWith(r.prefix));
  return hit || { in: CLAUDE_SONNET_IN_EUR_PER_1M, out: CLAUDE_SONNET_OUT_EUR_PER_1M };
}

// Prompt caching Anthropic (Sonnet 4.6) :
//   - cache_creation_input_tokens : 1.25× tarif input plein
//   - cache_read_input_tokens     : 0.10× tarif input plein
// (cf. https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
const CLAUDE_CACHE_WRITE_MULT = 1.25;
const CLAUDE_CACHE_READ_MULT = 0.10;

// OpenAI text-embedding-3-small — $0.02 / 1M tokens, conversion ×0.92.
// Utilisé par lib/rag.js pour embedder la requête utilisateur avant
// match Supabase. Quasi négligeable mais on l'inclut pour l'honnêteté.
const OPENAI_EMBED_EUR_PER_1M = 0.0184;

// ─────────────────────────────────────────────────────────────
// FADR — abo Fadr Plus à $10/mois inclut $10 de crédits API.
// Endpoint payant : "Create Stem Task" facturé à $0.05 / minute
// d'audio (cf. fadr.com/docs/api-billing). Donc ~200 minutes
// par mois incluses, puis $0.05/min facturés au-delà.
//
// On logge ici le COÛT MARGINAL HONNÊTE par analyse (durée × tarif).
// Le coût du fcfa fixe ($10/mois) est à part : il est consommé
// par les premières analyses, et ce qui dépasse les 200 min
// est facturé au-delà du seuil. L'admin dashboard agrège la
// consommation mensuelle pour visualiser la franchise restante.
//
// Conversion USD → EUR à 0.92 → $0.05/min ≈ 0.046 €/min.
// ─────────────────────────────────────────────────────────────
const FADR_EUR_PER_MINUTE = 0.046;

// INFRA — Vercel + Supabase sont aussi des forfaits fixes, pas
// des coûts marginaux purs (sauf egress Supabase au-delà du quota
// gratuit, mais on a déjà optimisé l'egress en avril 2026 et on
// est très en dessous du seuil). On met 0 pour ne pas polluer
// le coût marginal par analyse.
const INFRA_COST_EUR = 0;

// Marge de sécurité ajoutée au total (en %), pour absorber les
// imprécisions d'estimation (audio token count Gemini, surcoûts retry, …).
// 0 = pas de marge, 0.10 = +10 %.
const SAFETY_MARGIN_PCT = 0.05;

// ─────────────────────────────────────────────────────────────
// computeCosts — calcule le breakdown € pour une analyse.
//
// Args :
//   geminiUsage      = { promptTokenCount, candidatesTokenCount, model? }
//   claudeUsage      = { input_tokens, output_tokens, model? }
//   fadrCalled       = bool (true si Fadr a tourné, false si KO/skip)
//   audioDurationSec = durée audio en secondes (pour calcul Fadr)
//
// Return : { gemini_eur, claude_eur, fadr_eur, infra_eur, total_eur }
// ─────────────────────────────────────────────────────────────
function computeCosts({ geminiUsage = {}, claudeUsage = {}, fadrCalled = true, audioDurationSec = 0 }) {
  const gIn = Number(geminiUsage.promptTokenCount || 0);
  const gOut = Number(geminiUsage.candidatesTokenCount || 0);
  // Si on a utilisé un modèle Pro plutôt que Flash, on calcule au tarif Pro.
  const isPro = (geminiUsage.model || '').toLowerCase().includes('pro');
  const gInRate = isPro ? GEMINI_PRO_IN_EUR_PER_1M : GEMINI_FLASH_IN_EUR_PER_1M;
  const gOutRate = isPro ? GEMINI_PRO_OUT_EUR_PER_1M : GEMINI_FLASH_OUT_EUR_PER_1M;
  const gemini_eur = (gIn * gInRate + gOut * gOutRate) / 1_000_000;

  const cIn = Number(claudeUsage.input_tokens || 0);
  const cOut = Number(claudeUsage.output_tokens || 0);
  const cr = claudeRates(claudeUsage.model);
  const claude_eur = (cIn * cr.in + cOut * cr.out) / 1_000_000;

  // Fadr : durée audio × tarif/minute (0 si pas appelé ou si durée inconnue)
  const durationMin = Math.max(0, Number(audioDurationSec || 0)) / 60;
  const fadr_eur = fadrCalled && durationMin > 0
    ? durationMin * FADR_EUR_PER_MINUTE
    : 0;
  const infra_eur = INFRA_COST_EUR;

  const subtotal = gemini_eur + claude_eur + fadr_eur + infra_eur;
  const total_eur = subtotal * (1 + SAFETY_MARGIN_PCT);

  return {
    gemini_eur: round4(gemini_eur),
    claude_eur: round4(claude_eur),
    fadr_eur: round4(fadr_eur),
    infra_eur: round4(infra_eur),
    total_eur: round4(total_eur),
  };
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────
// Supabase client (service_role) — lazy init.
// ─────────────────────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[costTracker] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — logging disabled');
    return null;
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// ─────────────────────────────────────────────────────────────
// logAnalysisCost — INSERT une ligne dans analysis_cost_logs.
//
// Args :
//   userId           : uuid du user (peut être null pour analyses anonymes)
//   jobId            : id éphémère du job côté backend (string)
//   audioDurationSec : durée du fichier audio (number)
//   geminiUsage      : { promptTokenCount, candidatesTokenCount, model? }
//   claudeUsage      : { input_tokens, output_tokens, model? }
//   fadrCalled       : bool
//
// Return : la ligne insérée, ou null si erreur (loggée).
// Ne throw JAMAIS — ne doit pas casser le pipeline d'analyse.
// ─────────────────────────────────────────────────────────────
async function logAnalysisCost({
  userId = null,
  jobId = null,
  audioDurationSec = null,
  geminiUsage = {},
  claudeUsage = {},
  fadrCalled = true,
  timings = null, // { fadr_ms, listening_ms, rag_ms, fiche_ms, evolution_ms, total_ms } — migration 058
}) {
  try {
    const sb = getSupabase();
    if (!sb) return null;

    const costs = computeCosts({ geminiUsage, claudeUsage, fadrCalled, audioDurationSec });

    const row = {
      user_id: userId || null,
      job_id: jobId || null,
      audio_duration_sec: audioDurationSec || null,
      gemini_in_tokens: Number(geminiUsage.promptTokenCount || 0),
      gemini_out_tokens: Number(geminiUsage.candidatesTokenCount || 0),
      claude_in_tokens: Number(claudeUsage.input_tokens || 0),
      claude_out_tokens: Number(claudeUsage.output_tokens || 0),
      gemini_eur: costs.gemini_eur,
      claude_eur: costs.claude_eur,
      fadr_eur: costs.fadr_eur,
      infra_eur: costs.infra_eur,
      total_eur: costs.total_eur,
      gemini_model: geminiUsage.model || null,
      claude_model: claudeUsage.model || null,
      fadr_called: !!fadrCalled,
      timings: timings && Object.keys(timings).length ? timings : null,
    };

    const { data, error } = await sb
      .from('analysis_cost_logs')
      .insert(row)
      .select()
      .single();

    if (error) {
      console.error('[costTracker] insert error:', error.message);
      return null;
    }
    console.log(`[costTracker] logged: ${costs.total_eur} € (gemini ${costs.gemini_eur} + claude ${costs.claude_eur} + fadr ${costs.fadr_eur} + infra ${costs.infra_eur})`);
    return data;
  } catch (err) {
    console.error('[costTracker] unexpected error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// computeChatCost — calcule le coût d'UN tour de chat.
//
// Args :
//   claudeUsage = {
//     input_tokens,                   // tokens facturés au tarif input plein
//     cache_creation_input_tokens,    // tokens écrits en cache (×1.25)
//     cache_read_input_tokens,        // tokens lus depuis le cache (×0.10)
//     output_tokens,
//   }
//   embedTokens = nombre de tokens passés à OpenAI pour le RAG (0 si pas de RAG)
//
// Return : { claude_eur, embedding_eur, total_eur }
// ─────────────────────────────────────────────────────────────
function computeChatCost({ claudeUsage = {}, embedTokens = 0 }) {
  const cIn = Number(claudeUsage.input_tokens || 0);
  const cCacheWrite = Number(claudeUsage.cache_creation_input_tokens || 0);
  const cCacheRead = Number(claudeUsage.cache_read_input_tokens || 0);
  const cOut = Number(claudeUsage.output_tokens || 0);

  const inputEur = cIn * CLAUDE_SONNET_IN_EUR_PER_1M;
  const cacheWriteEur = cCacheWrite * CLAUDE_SONNET_IN_EUR_PER_1M * CLAUDE_CACHE_WRITE_MULT;
  const cacheReadEur = cCacheRead * CLAUDE_SONNET_IN_EUR_PER_1M * CLAUDE_CACHE_READ_MULT;
  const outputEur = cOut * CLAUDE_SONNET_OUT_EUR_PER_1M;
  const claude_eur = (inputEur + cacheWriteEur + cacheReadEur + outputEur) / 1_000_000;

  const embedding_eur = (Number(embedTokens) || 0) * OPENAI_EMBED_EUR_PER_1M / 1_000_000;

  const subtotal = claude_eur + embedding_eur;
  const total_eur = subtotal * (1 + SAFETY_MARGIN_PCT);

  return {
    claude_eur: round4(claude_eur),
    embedding_eur: round4(embedding_eur),
    total_eur: round4(total_eur),
  };
}

// ─────────────────────────────────────────────────────────────
// logChatCost — INSERT une ligne dans chat_cost_logs.
//
// Args :
//   userId        : uuid du user (peut être null)
//   versionId     : uuid de la version dont la fiche est consultée (peut être null)
//   messageCount  : nb de messages dans l'historique (côté client) au moment de l'appel
//   ragUsed       : bool — true si on a injecté du contexte PureMix
//   locale        : 'fr' | 'en'
//   claudeUsage   : objet usage retourné par l'API Anthropic
//   embedTokens   : tokens consommés par l'embed OpenAI (0 si pas de RAG)
//   claudeModel   : string (constante MODEL côté lib/claude.js)
//
// Return : la ligne insérée, ou null si erreur (loggée).
// Ne throw JAMAIS — un loggage raté ne doit pas casser l'UX du chat.
// ─────────────────────────────────────────────────────────────
async function logChatCost({
  userId = null,
  versionId = null,
  messageCount = 0,
  ragUsed = false,
  locale = null,
  claudeUsage = {},
  embedTokens = 0,
  claudeModel = null,
}) {
  try {
    const sb = getSupabase();
    if (!sb) return null;

    const costs = computeChatCost({ claudeUsage, embedTokens });

    const row = {
      user_id: userId || null,
      version_id: versionId || null,
      message_count: Number(messageCount) || 0,
      rag_used: !!ragUsed,
      locale: locale || null,
      claude_in_tokens: Number(claudeUsage.input_tokens || 0),
      claude_cache_creation_tokens: Number(claudeUsage.cache_creation_input_tokens || 0),
      claude_cache_read_tokens: Number(claudeUsage.cache_read_input_tokens || 0),
      claude_out_tokens: Number(claudeUsage.output_tokens || 0),
      claude_eur: costs.claude_eur,
      embedding_eur: costs.embedding_eur,
      total_eur: costs.total_eur,
      claude_model: claudeModel || null,
    };

    const { data, error } = await sb
      .from('chat_cost_logs')
      .insert(row)
      .select()
      .single();

    if (error) {
      console.error('[costTracker] chat insert error:', error.message);
      return null;
    }
    console.log(
      `[costTracker] chat logged: ${costs.total_eur} € ` +
      `(in ${row.claude_in_tokens} | cache_w ${row.claude_cache_creation_tokens} | ` +
      `cache_r ${row.claude_cache_read_tokens} | out ${row.claude_out_tokens})`
    );
    return data;
  } catch (err) {
    console.error('[costTracker] chat unexpected error:', err.message);
    return null;
  }
}

module.exports = { computeCosts, logAnalysisCost, computeChatCost, logChatCost };
