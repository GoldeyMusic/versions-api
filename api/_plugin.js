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
  // Crest > 40 dB = artefact (RMS effondré pendant un silence), jamais
  // musical — on l'omet plutôt que de faire dérailler les conseils.
  if (typeof m.crest === 'number' && m.crest > 0 && m.crest <= 40) {
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
    block += `PLUGINS INSTALLÉS (liste exhaustive scannée sur la machine de l'utilisateur — SEULE source de vérité sur ce qu'il possède) :\n${list}\n\n` +
      `NOTE FIABILITÉ : certains fabricants (notamment UAD/Universal Audio) installent TOUTES leurs déclinaisons même non achetées — leur présence dans la liste ne garantit pas que l'utilisateur les possède. Si tu recommandes un plugin UAD, privilégie d'abord un équivalent non-UAD de la liste ; sinon précise en quelques mots qu'il nécessite une licence UAD active.\n\n`;
  }

  // Console View — les AUTRES instances Versions du même projet (une par
  // piste/groupe). Permet le conseil INTER-PISTES : équilibres, masquage
  // probable, dynamique relative. `playing:false` = la piste n'a pas joué
  // depuis > 3 s → pas de chiffres (périmés), on le dit à Claude.
  if (Array.isArray(ctx.console) && ctx.console.length > 0) {
    const f = (v) => (typeof v === 'number' ? v.toFixed(1) : 'n/a');
    const lines = ctx.console.slice(0, 32).map((t) => {
      const name = t.channelType || 'Unknown';
      if (!t.playing || !t.lufs) {
        return `- ${name} : à l'arrêt (aucune mesure récente)`;
      }
      // Crest omis s'il est implausible (0 = sanitizé côté plugin pendant
      // les silences ; > 40 dB = artefact de mesure, jamais musical)
      const crestTxt = (typeof t.crest === 'number' && t.crest > 0 && t.crest <= 40)
        ? `, crest ${f(t.crest)} dB`
        : '';
      return `- ${name} : LUFS short-term ${f(t.lufs.shortTerm)}, integrated ${f(t.lufs.integrated)}${crestTxt}`;
    });
    block +=
      `CONSOLE (instances Versions sur les AUTRES pistes du même projet, mesures live) :\n` +
      `${lines.join('\n')}\n\n`;
  }

  return block;
}

// ─── Spectres réduits (Console View étape 2) ─────────────────────
// 24 bandes log 30 Hz → 16 kHz — bornes f_b = 30 × (16000/30)^(b/24).
// MÊME réduction côté plugin (InstanceHub::kNumBands + rebuildBandMapping
// dans PluginProcessor.cpp) — garder les deux synchro.
const BAND_LABELS = [
  '30-39', '39-51', '51-66', '66-85', '85-111', '111-144', '144-187',
  '187-243', '243-316', '316-411', '411-533', '533-693', '693-900',
  '900-1.2k', '1.2k-1.5k', '1.5k-2k', '2k-2.6k', '2.6k-3.3k', '3.3k-4.3k',
  '4.3k-5.6k', '5.6k-7.3k', '7.3k-9.5k', '9.5k-12.3k', '12.3k-16k',
];

function formatSpectra(metering, ctx) {
  const fmtBands = (arr) =>
    arr.slice(0, BAND_LABELS.length).map((v) => Math.round(v)).join(' ');
  const lines = [];

  if (metering && Array.isArray(metering.spectrum) && metering.spectrum.length > 0) {
    const name = (ctx && ctx.instrumentType) || 'piste courante';
    lines.push(`- ${name} (PISTE COURANTE) : ${fmtBands(metering.spectrum)}`);
  }
  if (ctx && Array.isArray(ctx.console)) {
    for (const t of ctx.console.slice(0, 32)) {
      if (t.playing && Array.isArray(t.spectrum) && t.spectrum.length > 0) {
        lines.push(`- ${t.channelType || 'Unknown'} : ${fmtBands(t.spectrum)}`);
      }
    }
  }
  if (lines.length === 0) return '';

  return (
    `SPECTRES (signature tonale de chaque piste QUAND ELLE SONNE — les silences ne diluent pas la mesure ; dB par bande, échelle dBFS commune, directement comparables) :\n` +
    `Bandes (Hz) : ${BAND_LABELS.join(' | ')}\n` +
    `${lines.join('\n')}\n\n`
  );
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

    // Diagnostic Console View : visible dans les logs Railway. Permet de
    // vérifier en 10 s si le plugin envoie bien context.console (sinon =
    // vieux binaire en mémoire dans Logic).
    const consoleInfo = Array.isArray(context && context.console)
      ? `${context.console.length} pistes (${context.console.filter((t) => t.playing).length} en lecture)`
      : 'ABSENT';
    console.log(`[plugin/feedback] console: ${consoleInfo} · canal: ${(context && context.instrumentType) || '?'}`);

    const meteringText = formatMetering(metering);
    const contextText = formatContext(context);
    const spectraText = formatSpectra(metering, context);

    const systemPrompt =
      `Tu es l'assistant Versions, ingénieur du son expert (20+ ans), intégré dans un plugin DAW.\n\n` +
      `L'utilisateur travaille SUR SON MIX en cours dans sa DAW. Tu reçois en live les mesures de metering du plugin :\n` +
      `${meteringText}\n\n` +
      `${contextText}` +
      `${spectraText}` +
      ((context && context.chatLang === 'fr')
        ? `LANGUE : réponds TOUJOURS en français, quelle que soit la langue de la question.\n\n`
        : (context && context.chatLang === 'en')
        ? `LANGUAGE: ALWAYS answer in English, whatever language the question is in.\n\n`
        : `LANGUE : réponds dans la langue de la question.\n\n`) +
      `RÈGLES DE FORMATAGE (strict) :\n` +
      `- Tu réponds dans un mini-chat à l'intérieur du plugin (zone limitée à ~6-8 lignes).\n` +
      `- Sois ULTRA concis : 3 à 5 phrases courtes max.\n` +
      `- Direct, actionnable. Pas de salutation, pas de remerciement, pas de simulation de relation.\n` +
      `- Pas de markdown, pas de listes à puces, pas de titres, pas de gras.\n` +
      `- Donne des valeurs précises (Hz, dB, ratio, ms, LU) quand c'est utile.\n` +
      `- Si la question est ambiguë ou hors-sujet du metering, demande UNE précision en 1 phrase plutôt que de deviner.\n` +
      `- Ancre toujours ta réponse sur les valeurs de metering ci-dessus quand elles sont pertinentes.\n\n` +
      `RÈGLES CONSOLE — CONSEIL INTER-PISTES (si un bloc CONSOLE est fourni) :\n` +
      `- Le bloc CONSOLE liste les autres pistes du projet équipées d'une instance Versions, avec leurs mesures live. La piste analysée (celle du chat) est "${(context && context.instrumentType) || 'inconnue'}".\n` +
      `- Tu peux et DOIS t'en servir pour raisonner inter-pistes quand c'est pertinent : équilibres de niveaux entre pistes (deltas LUFS short-term), dynamique relative (crest), risques de masquage PROBABLES entre registres voisins (ex. basse vs batterie dans le bas du spectre).\n` +
      `- Les deltas LUFS entre pistes suivent les mêmes règles de polarité que ci-dessous : vérifie le sens avant d'écrire un chiffre. Et calcule le delta EXACTEMENT (|a − b|) — si tu n'es pas sûr du calcul, formule sans chiffre.\n` +
      `- RELATION MASTER ↔ PISTES : le master est la SOMME des pistes. Une piste individuelle est NORMALEMENT plus basse que le master — ce n'est ni une "marge", ni un retard à combler, ni un signe de piste "sous-traitée". Ne compare JAMAIS une piste au master comme si elle devait s'en rapprocher. Les comparaisons utiles sont : piste vs piste (équilibres relatifs), et la hiérarchie attendue pour le genre (ex. en Pop, lead vocal et drums devant, basse en soutien).\n` +
      `- SPECTRES — POLARITÉ (même règle que les LUFS) : les valeurs sont des dB NÉGATIFS. -12 dB est PLUS FORT que -47 dB. Avant d'écrire qu'une piste "domine" ou "s'efface" dans une zone, vérifie bande par bande : la plus forte est celle dont la valeur est la plus PROCHE DE ZÉRO.\n` +
      `- MASQUAGE (si un bloc SPECTRES est fourni, appuie-toi DESSUS, pas sur des suppositions) : une piste A masque une piste B dans une zone quand l'énergie de A y est COMPARABLE (±6 dB) OU SUPÉRIEURE à celle de B, alors que cette zone est VITALE pour B. Zone vitale = là où le spectre de B est proche de son propre maximum (à ~10 dB), et cohérente avec son rôle (ex. 50-120 Hz pour le kick, 80-250 Hz pour la basse, 1-4 kHz pour la voix). Qu'une basse domine le bas du spectre face à des pistes qui n'y ont que de l'énergie résiduelle, c'est la hiérarchie NORMALE d'un mix, pas du masquage. Deux cas à AFFIRMER en citant la zone en Hz : (a) niveaux proches dans les mêmes bandes = les deux pistes se brouillent mutuellement ; (b) A largement au-dessus de B (15 dB ou plus) dans une zone vitale de B = B est NOYÉE — attention, le spectre est une moyenne : une source transitoire (kick) a une énergie moyenne basse même quand elle perce très bien, surtout si un sidechain alterne les deux ; ne conclus pas au masquage d'un élément transitoire sur un simple delta moyen sans le signaler. RECOUPEMENT OBLIGATOIRE avec les LUFS : si le "masquant" est globalement PLUS FAIBLE que sa victime en LUFS short-term, c'est presque toujours un artefact de moyenne (sidechain, jeu clairsemé) et PAS un masquage réel — c'est le masquage le plus grave, pas une "bonne séparation". Propose alors une action chiffrée : baisser A, EQ (-2/-3 dB sur la zone), filtre coupe-bas, ou sidechain. Ne récite JAMAIS les listes de valeurs des spectres — sers-t'en pour conclure.\n` +
      `- MASQUAGE TEMPOREL : les spectres disent OÙ les pistes ont de l'énergie, pas QUAND. Deux pistes qui se chevauchent spectralement mais jouent en alternance (sidechain, arrangement) ne se masquent pas vraiment. Si l'utilisateur indique qu'un sidechain ou l'arrangement sépare déjà deux pistes dans le temps, le chevauchement mesuré SURESTIME le masquage réel — dis-le et concentre-toi sur ce qui se passe quand elles jouent ensemble.\n` +
      `- Sans bloc SPECTRES, tu n'as que les niveaux : masquage au conditionnel uniquement ("risque de", "vérifie si") avec un test concret.\n` +
      `- Une piste "à l'arrêt" n'a aucune mesure récente : ne cite JAMAIS de chiffre pour elle, et si la comparaison la concerne, dis à l'utilisateur de lancer la lecture pour comparer.\n` +
      `- Si la question ne concerne que la piste courante, n'étale pas la console : un conseil inter-pistes seulement s'il apporte quelque chose.\n\n` +
      `RÈGLES PLUGINS — ANTI-HALLUCINATION (strict, jamais d'exception) :\n` +
      `- Tu ne peux citer un plugin par son nom QUE dans 2 cas : (a) il figure MOT POUR MOT dans la liste "PLUGINS INSTALLÉS" ci-dessus, (b) c'est un plugin stock du DAW déclaré (ex. Logic Pro : Channel EQ, Compressor, Limiter, Multipressor, DeEsser 2).\n` +
      `- Si la liste est fournie, privilégie TOUJOURS un plugin de la liste. Recopie son nom exactement tel qu'il apparaît — n'ajoute ni numéro de version, ni suffixe, ni déclinaison que tu n'as pas vus dans la liste.\n` +
      `- N'affirme JAMAIS que l'utilisateur possède un plugin absent de la liste.\n` +
      `- Si rien dans la liste (ni en stock DAW) ne convient, décris le TYPE de traitement et ses réglages ("un compresseur avec attaque ~30 ms, ratio 4:1") SANS inventer de nom. Tu peux citer une alternative gratuite connue seulement si tu es certain de son nom exact, en précisant qu'elle est à télécharger.\n` +
      `- Dans le doute sur un nom : pas de nom. Un réglage juste sans marque vaut mieux qu'un nom de plugin inventé.\n\n` +
      `RÈGLES TECHNIQUES NON-NÉGOCIABLES (à ne JAMAIS contredire) :\n` +
      `- LUFS : échelle NÉGATIVE. Plus la valeur est PROCHE DE ZÉRO, plus c'est FORT. −8 LUFS est PLUS FORT que −14 LUFS.\n` +
      `- Pour aller de −14 à −11 LUFS il faut AJOUTER ~3 dB de gain ; de −11 à −14 il faut en RETIRER ~3.\n` +
      `- Avant toute phrase sur un delta LUFS, vérifie mentalement le sens : X plus proche de zéro que la cible → déjà plus fort que la cible → réduire ; plus loin de zéro → plus faible → ajouter.\n` +
      `- dBTP : aussi échelle négative. −1 dBTP est plus haut que −3 dBTP ; proche de 0 = risque de clip.\n` +
      `- Si tu n'es pas SÛR du sens d'un delta, pas de chiffre — formule qualitativement ("tu es dans la zone cible", "au-dessus / en dessous").`;

    const messages = [{ role: 'user', content: question.trim() }];

    // Default Haiku — économique, suffisant pour Q&A courtes sur du metering.
    // L'app peut demander Sonnet via { "model": "sonnet" } si besoin (réponse
    // plus nuancée mais 5× plus chère).
    // EXCEPTION Console View : dès que des spectres inter-pistes sont
    // fournis, le raisonnement comparatif (24 bandes × N pistes, polarité
    // dB, qui masque qui) dépasse Haiku — observé en test 2026-06-05 :
    // basse 40 dB au-dessus du kick conclue "bonne séparation". Sonnet
    // automatique dans ce cas, sauf demande explicite { "model": "haiku" }.
    const modelToUse = model === 'sonnet'
      ? 'claude-sonnet-4-6'
      : model === 'haiku'
      ? 'claude-haiku-4-5-20251001'
      : spectraText
      ? 'claude-sonnet-4-6'
      : 'claude-haiku-4-5-20251001';

    const reply = await chat(messages, systemPrompt, {
      maxTokens: 400,
      model: modelToUse,
    });

    // Filet de sécurité formatage : le prompt interdit le markdown mais Haiku
    // glisse parfois du **gras** ou des puces. Le TextEditor du plugin affiche
    // du texte brut → on nettoie systématiquement plutôt que d'espérer.
    const cleanReply = String(reply)
      .replace(/\*\*([^*]+)\*\*/g, '$1') // **gras** → texte nu
      .replace(/\*([^*\n]+)\*/g, '$1')   // *italique* → texte nu
      .replace(/^#{1,4}\s+/gm, '')       // titres markdown
      .replace(/^[-•*]\s+/gm, '- ');     // puces exotiques → tiret simple

    return res.json({ reply: cleanReply, model: modelToUse });
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
