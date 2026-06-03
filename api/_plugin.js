// ─────────────────────────────────────────────────────────────────
// Endpoint plugin DAW Versions — Phase 2.A
//
// Reçoit les valeurs de metering live du plugin + une question utilisateur,
// renvoie une réponse Claude (Haiku par défaut, Sonnet sur demande).
//
// AUTH : shared secret via header `X-Plugin-Secret` (env PLUGIN_DEV_SECRET).
//        Sera remplacé en Phase 2.B par un vrai JWT user issu d'un flow
//        device-code → page web versions.studio/plugin-auth.
//
// Pas de RAG, pas de fiche, pas de crédit tracking pour le MVP — tout ça
// arrive en Phase 2.B/3.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();

// ─── Auth shared-secret (MVP) ────────────────────────────────────
function requirePluginAuth(req, res, next) {
  const expected = process.env.PLUGIN_DEV_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'plugin_secret_not_configured' });
  }
  const got = req.get('X-Plugin-Secret');
  if (!got || got !== expected) {
    return res.status(401).json({ error: 'invalid_plugin_secret' });
  }
  next();
}

// ─── Formatage des valeurs metering pour le prompt ───────────────
function formatMetering(m) {
  if (!m) return '(pas de metering disponible)';
  const parts = [];
  if (m.lufs) {
    const f = (v) => (typeof v === 'number' ? v.toFixed(1) : 'n/a');
    parts.push(
      `LUFS Momentary ${f(m.lufs.momentary)}  Short-term ${f(m.lufs.shortTerm)}  Integrated ${f(m.lufs.integrated)} LU`
    );
  }
  if (m.truePeak) {
    const f = (v) => (typeof v === 'number' ? v.toFixed(1) : 'n/a');
    parts.push(`True Peak L ${f(m.truePeak.L)}  R ${f(m.truePeak.R)} dBTP`);
  }
  if (m.rms) {
    const f = (v) => (typeof v === 'number' ? v.toFixed(1) : 'n/a');
    parts.push(`RMS L ${f(m.rms.L)}  R ${f(m.rms.R)} dB`);
  }
  if (typeof m.crest === 'number') {
    parts.push(`Crest ${m.crest.toFixed(1)} dB`);
  }
  return parts.join('  ·  ');
}

function formatContext(ctx) {
  if (!ctx) return '';
  const parts = [];
  // Profil utilisateur — adapte le ton et le vocabulaire
  if (ctx.userName)       parts.push(`Utilisateur : ${ctx.userName}`);
  if (ctx.userLevel)      parts.push(`Niveau d'expérience : ${ctx.userLevel}`);
  if (ctx.userMonitors)   parts.push(`Monitors / enceintes : ${ctx.userMonitors}`);
  if (ctx.userHeadphones) parts.push(`Casques : ${ctx.userHeadphones}`);
  if (ctx.userGenres)     parts.push(`Genres habituels du producteur : ${ctx.userGenres}`);
  // Contexte de session
  if (ctx.daw)            parts.push(`DAW : ${ctx.daw}`);
  if (ctx.genre)          parts.push(`Genre du projet en cours : ${ctx.genre}`);
  if (ctx.intent)         parts.push(`Intention : ${ctx.intent}`);
  if (ctx.instrumentType) parts.push(`Type de canal analysé : ${ctx.instrumentType}`);

  let block = parts.length > 0 ? `Contexte :\n${parts.join('\n')}\n\n` : '';

  // Liste plugins de l'utilisateur — change le ton des recommandations :
  // privilégie ce qu'il possède déjà au lieu de pousser des plugins payants
  // qu'il n'a pas. C'est l'angle d'attaque "ton arsenal", très important pour
  // ne pas passer pour une régie publicitaire.
  if (Array.isArray(ctx.userPlugins) && ctx.userPlugins.length > 0) {
    // Tronque pour ne pas exploser le contexte Claude — top 200 plugins
    // suffit largement pour couvrir l'arsenal d'un mixeur normal.
    const list = ctx.userPlugins.slice(0, 200).join(', ');
    block += `Plugins installés sur la machine de l'utilisateur (privilégie ceux-ci dans tes recommandations, propose une alternative gratuite si rien ne convient parmi cette liste) :\n${list}\n\n`;
  }

  return block;
}

// ─── POST /api/plugin/feedback ───────────────────────────────────
router.post('/feedback', requirePluginAuth, async (req, res) => {
  try {
    const { metering, context, question, model } = req.body || {};

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question_required' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'question_too_long' });
    }

    const meteringText = formatMetering(metering);
    const contextText = formatContext(context);

    const systemPrompt =
      `Tu es l'assistant Versions, ingénieur du son expert (20+ ans), intégré dans un plugin DAW.\n\n` +
      `L'utilisateur travaille SUR SON MIX en cours dans sa DAW. Tu reçois en live les mesures de metering du plugin :\n` +
      `${meteringText}\n\n` +
      `${contextText}` +
      `RÈGLES DE FORMATAGE (strict) :\n` +
      `- Tu réponds dans un mini-chat à l'intérieur du plugin (zone limitée à ~6-8 lignes).\n` +
      `- Sois ULTRA concis : 3 à 5 phrases courtes max.\n` +
      `- Direct, actionnable. Pas de salutation, pas de remerciement, pas de simulation de relation.\n` +
      `- Pas de markdown, pas de listes à puces, pas de titres, pas de gras.\n` +
      `- Donne des valeurs précises (Hz, dB, ratio, ms, LU) quand c'est utile.\n` +
      `- Si tu mentionnes un plugin payant, propose une alternative gratuite.\n` +
      `- Si la question est ambiguë ou hors-sujet du metering, demande UNE précision en 1 phrase plutôt que de deviner.\n` +
      `- Ancre toujours ta réponse sur les valeurs de metering ci-dessus quand elles sont pertinentes.`;

    const messages = [{ role: 'user', content: question.trim() }];

    // Default Haiku — économique, suffisant pour Q&A courtes sur du metering.
    // L'app peut demander Sonnet via { "model": "sonnet" } si besoin (réponse
    // plus nuancée mais 5× plus chère).
    const modelToUse = model === 'sonnet'
      ? 'claude-sonnet-4-6'
      : 'claude-haiku-4-5-20251001';

    const reply = await chat(messages, systemPrompt, {
      maxTokens: 400,
      model: modelToUse,
    });

    return res.json({ reply, model: modelToUse });
  } catch (err) {
    console.error('[plugin/feedback] error:', err && err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Healthcheck non gated (pour que le plugin puisse pinger sans secret au boot)
router.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'versions-plugin', phase: '2.A' });
});

module.exports = router;
