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

function formatMaskAlerts(maskAlerts) {
  if (!Array.isArray(maskAlerts) || maskAlerts.length === 0) return '';
  const lines = maskAlerts.slice(0, 16).map((m) => {
    const lo = Math.round(m.loHz), hi = Math.round(m.hiHz);
    if (m.severe)
      return `- ROUGE (domination) : "${m.a}" masque "${m.b}" sur ${lo}-${hi} Hz`;
    return `- ORANGE (competition legere) : "${m.a}" et "${m.b}" se chevauchent sur ${lo}-${hi} Hz`;
  });
  return (
    `ALERTES DE MASQUAGE AFFICHEES A L'ECRAN (panneau SESSION, zones colorees du spectre) :\n` +
    `${lines.join('\n')}\n` +
    `Ce sont EXACTEMENT les zones que l'utilisateur voit colorees dans le spectre. ROUGE = domination (une piste couvre l'autre), ORANGE = competition legere. Si on te demande "c'est quoi la zone orange" ou "la zone rouge", reponds avec CETTE liste (pistes concernees + plage en Hz + severite). Ne dis JAMAIS que tu ne peux pas voir les graphiques : ces alertes SONT le contenu de ces zones colorees.\n\n`
  );
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
    // Libellé "SESSION" (pas "console") : cohérent avec l'UI du plugin —
    // l'IA reprend ce mot dans ses réponses. Le champ JSON reste
    // context.console (contrat API plugin↔backend).
    block +=
      `SESSION (instances Versions sur les AUTRES pistes du même projet, mesures live) :\n` +
      `${lines.join('\n')}\n\n`;
  }

  const maskBlock = formatMaskAlerts(ctx.maskAlerts);
  if (maskBlock) block += maskBlock;

  // Fiche d'analyse versions.studio du titre lie (envoyee par le plugin)
  if (ctx.ficheSummary) {
    block +=
      `FICHE D'ANALYSE VERSIONS.STUDIO (analyse complete du titre lie, ecoute reelle + DSP) :\n` +
      `${ctx.ficheSummary}\n` +
      `Sers-t'en comme reference de fond sur CE morceau. ATTENTION : le metering ci-dessus est l'etat ACTUEL dans le DAW et peut differer de la version analysee — si ca diverge, dis-le.\n\n`;
  }

  // Verdict de la derniere ecoute express de CETTE instance (extrait ~30 s
  // ecoute par l'IA pendant la session en cours). Sert aux questions de
  // suivi : l'utilisateur vient de le lire et enchaine ("comment je corrige
  // les sibilantes ?", "le 1er point ?"). Regle de resolution DURCIE apres
  // le test 2026-06-12 : "le 1er point" repondait True Peak (fiche) au lieu
  // de la caisse claire (verdict express) — l'express est le message le plus
  // RECENT que l'utilisateur a sous les yeux, il prime sur la fiche.
  if (ctx.expressVerdict) {
    block +=
      `ECOUTE EXPRESS (verdict de la DERNIERE ecoute express de cette session — c'est le dernier feedback que l'utilisateur a recu et lu) :\n` +
      `${String(ctx.expressVerdict).slice(0, 2500)}\n` +
      `REGLE DE PRIORITE : quand l'utilisateur fait reference a un point sans le nommer ("le 1er point", "le 2e", "ca", "ce probleme", "comment je corrige"), il parle des points "A travailler" de CE verdict express — PAS de la fiche versions.studio (plus ancienne). EXCEPTION : si le fil de conversation fourni contient deja l'antecedent (une de TES reponses precedentes definit "ca"), le fil PRIME sur le verdict (plus recent et plus specifique). Reponds sur le point exact. C'est un INSTANT de la session : si le metering actuel a change depuis, dis-le.\n\n`;
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
  // JWT user (envoyé par le plugin en plus du secret partagé) → identifie
  // l'utilisateur pour le quota chat. Absent (vieux binaire) → mode dégradé.
  const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let chatConsumed = false;
  try {
    const { metering, context, question, model } = req.body || {};

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question_required' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ error: 'question_too_long' });
    }

    // ── Garde-fou coût chat : consomme 1 message AVANT l'appel Claude ──
    // Gratuit = 15/jour, abonné = 1000/mois (plugin_chat_consume décide selon
    // l'abonnement). allowed:false → on renvoie un message (HTTP 200 pour que
    // le plugin l'affiche dans le fil), SANS appeler Claude. Pas de token /
    // RPC indispo → null → mode dégradé (pas de blocage), comme l'express.
    // Le refund (catch) annule la conso si Claude échoue (jamais débiter sur échec).
    const quota = await callPluginQuotaRpc('plugin_chat_consume', userToken);
    if (quota && quota.allowed === false) {
      const perDay = quota.period === 'day';
      const replyText = perDay
        ? `Tu as atteint ta limite de ${quota.limit || 15} messages par jour dans le chat. `
          + `Reviens demain — ou passe en illimité (abonnement Indie ou Pro) sur versions.studio.`
        : `Tu as atteint ta limite de messages ce mois-ci. `
          + `Passe en illimité sur versions.studio.`;
      return res.json({
        reply: replyText,
        quota: { exceeded: true, feature: 'chat', limit: quota.limit, period: quota.period },
      });
    }
    if (quota && quota.allowed === true) chatConsumed = true;

    // ── Mémoire de conversation (plugin ≥ 1.0.5, 2026-07-09) ──
    // context.history = les derniers échanges [{q, a}] du fil, du plus ancien
    // au plus récent (déjà plafonné à 8 tours / réponses 1200 chars côté
    // plugin). On reconstruit un vrai fil user/assistant → l'IA comprend les
    // questions de suivi ("comment je corrige ça ?") au lieu de repartir de
    // zéro à chaque message. Le contexte/metering live ne voyage QUE dans le
    // system prompt (valeurs ACTUELLES) — les tours passés sont du texte nu.
    // Champ absent (vieux binaire) → historique vide → comportement d'avant.
    const history = Array.isArray(context && context.history) ? context.history : [];
    const historyMessages = [];
    for (const t of history.slice(-8)) {
      const q = t && typeof t.q === 'string' ? t.q.trim() : '';
      const a = t && typeof t.a === 'string' ? t.a.trim() : '';
      if (!q || !a) continue; // paires complètes only → alternance user/assistant garantie
      historyMessages.push({ role: 'user', content: q.slice(0, 2000) });
      historyMessages.push({ role: 'assistant', content: a.slice(0, 2000) });
    }

    // Diagnostic Console View : visible dans les logs Railway. Permet de
    // vérifier en 10 s si le plugin envoie bien context.console (sinon =
    // vieux binaire en mémoire dans Logic).
    const consoleInfo = Array.isArray(context && context.console)
      ? `${context.console.length} pistes (${context.console.filter((t) => t.playing).length} en lecture)`
      : 'ABSENT';
    console.log(`[plugin/feedback] console: ${consoleInfo} · canal: ${(context && context.instrumentType) || '?'} · historique: ${historyMessages.length / 2} tours`);

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
      (historyMessages.length > 0
        ? `MEMOIRE DE CONVERSATION (des messages précédents sont fournis dans le fil) :\n` +
          `- Ce fil est TA conversation en cours avec cet utilisateur — c'est le contexte le plus récent, il PRIME sur tout le reste.\n` +
          `- Les références sans antécédent ("ça", "ce problème", "le 1er point", "comment je corrige") renvoient D'ABORD au fil ci-dessus s'il contient la réponse, SINON au verdict express, SINON à la fiche.\n` +
          `- NE répète PAS les chiffres, mesures ou explications déjà donnés dans le fil, SAUF si les valeurs ont changé — les mesures de CE system prompt sont les valeurs ACTUELLES, seule source de chiffres à jour (celles citées dans les vieux messages du fil sont périmées).\n` +
          `- Réponds dans la continuité : court, ciblé sur la question posée. Pas de nouvelle analyse complète si on ne te la demande pas.\n\n`
        : ``) +
      `RÈGLES SESSION — CONSEIL INTER-PISTES (si un bloc SESSION est fourni) :\n` +
      `- Le bloc SESSION liste les autres pistes du projet équipées d'une instance Versions, avec leurs mesures live. La piste analysée (celle du chat) est "${(context && context.instrumentType) || 'inconnue'}". Si tu nommes cette vue, dis "la session" (jamais "la console").\n` +
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

    const messages = [...historyMessages, { role: 'user', content: question.trim() }];

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
    // Claude a échoué après la conso → rembourse le message (jamais débiter sur échec).
    if (chatConsumed) await callPluginQuotaRpc('plugin_chat_refund', userToken);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Healthcheck non gated (pour que le plugin puisse pinger sans secret au boot)
router.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'versions-plugin', phase: '2.A' });
});

const multerExpress = require('multer');
const { analyzeListening: analyzeListeningExpress } = require('../lib/gemini');
const expressUpload = multerExpress({ storage: multerExpress.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Helper RPC quota (consume / status / refund) avec le JWT user — partagé par
// l'écoute express ET le chat. Renvoie null si pas de token ou si la RPC échoue
// (mode dégradé : on ne bloque pas). Déclaration hoistée → utilisable depuis les
// handlers définis plus haut dans le fichier.
async function callPluginQuotaRpc(fn, userToken) {
  if (!userToken) return null;
  try {
    const fetchQuota = require('node-fetch');
    const r = await fetchQuota(process.env.SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: 'sb_publishable_4n0FfejTu9-3kWXjALYNow_6gAZ814r',
        Authorization: 'Bearer ' + userToken,
      },
      body: '{}',
    });
    return await r.json().catch(() => null);
  } catch (e) {
    console.warn(`[plugin/quota] rpc ${fn} failed:`, e.message);
    return null;
  }
}

router.post('/express', requirePluginAuth, expressUpload.single('file'), async (req, res) => {
  const userTokenExpress = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let quotaConsumed = false;
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    // Garde-fou coût : consomme 1 écoute AVANT l'analyse (anti-spam). Si la
    // RPC dit "non" → 429. Si pas de token / RPC indispo → mode dégradé
    // (pas de blocage). Le refund (catch) annule la conso en cas d'échec.
    const quota = await callPluginQuotaRpc('plugin_express_consume', userTokenExpress);
    if (quota && quota.allowed === false) {
      return res.status(429).json({ error: 'express_quota', used: quota.used, limit: quota.limit });
    }
    if (quota && quota.allowed === true) quotaConsumed = true;

    const { title, vocalType, channelType,
            userLevel, userMonitors, userHeadphones, userGenres } = req.body;

    // ── Contexte additionnel (2026-06-12) ──────────────────────────────
    // 1) PISTE ISOLÉE : l'express écoute l'instance du plugin — sur une
    //    piste c'est un STEM, pas un mix. Sans cette règle, Gemini jugeait
    //    des chœurs comme un mix ("il manque la batterie").
    const extra = [];
    if (channelType && !/master|mix bus|music bus/i.test(String(channelType))) {
      extra.push(
        `IMPORTANT - CONTEXTE D'ECOUTE : tu ecoutes une PISTE ISOLEE ` +
        `(« ${String(channelType).slice(0, 60)} »), PAS un mix complet. ` +
        `Evalue-la comme un stem : timbre, dynamique, transitoires, problemes ` +
        `propres a ce type de piste (sibilance pour une voix, definition/sub ` +
        `pour une basse, punch/corps pour des drums...). NE COMMENTE PAS ` +
        `l'absence des autres instruments, ni l'equilibre global du mix, ni ` +
        `la "separation des elements" : ils ne sont pas dans ce que tu entends. ` +
        `ETIQUETAGE PRUDENT : ne nomme un instrument que si tu l'identifies ` +
        `CLAIREMENT. Ce bus ne contient pas forcement l'instrumentation ` +
        `typique du genre — s'il y a de l'energie dans le bas du spectre, ` +
        `dis "le bas du spectre de ce bus" ou "le registre grave des keys", ` +
        `PAS "la basse" (elle est peut-etre sur une autre piste).`);
    }
    // 2) PROFIL UTILISATEUR (champs envoyés par le plugin, vides omis).
    //    Règle (leçon du verdict→chat) : dire QUAND ce bloc s'applique.
    const prof = [];
    if (userLevel)      prof.push(`Niveau : ${String(userLevel).slice(0, 40)} (Beginner = vulgarise et explique chaque terme ; Pro/Expert = direct et technique).`);
    if (userMonitors)   prof.push(`Monitors : ${String(userMonitors).slice(0, 80)}.`);
    if (userHeadphones) prof.push(`Casques : ${String(userHeadphones).slice(0, 80)}.`);
    if (userGenres)     prof.push(`Genres habituels : ${String(userGenres).slice(0, 80)}.`);
    if (prof.length) {
      extra.push(
        `PROFIL UTILISATEUR (contexte d'ecoute SEULEMENT — n'en parle que si ` +
        `un point precis y gagne, ex. limite de bas du spectre des monitors → ` +
        `suggerer une verification au casque. N'invente JAMAIS de specs de ` +
        `materiel que tu ne connais pas, et n'ouvre pas le verdict par le profil) :\n`
        + prof.join('\n'));
    }

    const listening = await analyzeListeningExpress(
      req.file.buffer, req.file.mimetype || 'audio/wav',
      title || 'ce morceau', '', undefined, vocalType || 'vocal', 'fr',
      extra.length ? { extraContext: extra.join('\n\n') } : {}
    );
    const parts = [];
    if (listening && listening.impression) parts.push(String(listening.impression));
    if (listening && Array.isArray(listening.a_travailler) && listening.a_travailler.length) {
      parts.push('A travailler : ' + listening.a_travailler.join(' ; '));
    } else if (listening && Array.isArray(listening.points_forts) && listening.points_forts.length) {
      parts.push('Points forts : ' + listening.points_forts.slice(0, 3).join(' ; '));
    }
    const reply = parts.join('\n\n') || 'Ecoute effectuee.';
    return res.json({ success: true, reply });
  } catch (err) {
    console.error('[plugin/express] error:', err && err.message);
    // Écoute échouée → rembourse l'écoute consommée (jamais débiter sur échec)
    if (quotaConsumed) await callPluginQuotaRpc('plugin_express_refund', userTokenExpress);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /api/plugin/download — tracking du téléchargement ──────
// Le téléchargement du plugin est gaté par le login sur le SITE (décision
// David 2026-07-05) : PluginScreen n'affiche les liens /downloads/* qu'aux
// connectés, et poste ici en fire-and-forget au clic (apiFetchJson → Bearer
// JWT du site, PAS le X-Plugin-Secret — c'est un appel webapp, pas plugin).
// On logge en base (table plugin_downloads, migration 043 versions-app,
// service role). PLUS de notif email ici (retirée 2026-07-10, décision
// David) : doublon avec la notif "Plugin installé" (webhook
// notify-plugin-first-seen, migration 044) qui est le vrai signal, et
// faux positifs fréquents (clics par erreur sur mobile). La table
// continue d'être alimentée — elle sert de source à la répartition
// Mac/Windows dans l'admin (RPC admin_get_plugin_installs, mig 045).
// IMPORTANT : cette route ne doit JAMAIS bloquer un téléchargement — le
// fichier part en statique côté site quoi qu'il arrive ; ici tout échec
// est loggé puis avalé (200 quand même une fois l'auth passée).

const { requireAuth: requireUserAuth } = require('../lib/auth');

// Version courante du plugin — lue de plugin-version.json (déjà maintenu à
// chaque release par release.sh + déploiement site), cachée 10 min. Échec
// réseau → null (la colonne version reste vide, rien ne casse).
let pluginVersionCache = { value: null, at: 0 };
async function getLatestPluginVersion() {
  const TTL = 10 * 60 * 1000;
  if (pluginVersionCache.value && Date.now() - pluginVersionCache.at < TTL) {
    return pluginVersionCache.value;
  }
  try {
    const base = process.env.APP_BASE_URL || 'https://versions.studio';
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${base}/plugin-version.json`, { signal: controller.signal });
    clearTimeout(tid);
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j.latest === 'string') {
        pluginVersionCache = { value: j.latest, at: Date.now() };
        return j.latest;
      }
    }
  } catch { /* silencieux — la version est un nice-to-have */ }
  return null;
}

router.post('/download', requireUserAuth, async (req, res) => {
  const raw = req.body && req.body.platform;
  const platform = raw === 'mac' || raw === 'windows' ? raw : null;
  if (!platform) return res.status(400).json({ error: 'invalid_platform' });

  try {
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const version = await getLatestPluginVersion();
    const { error: insErr } = await sb.from('plugin_downloads').insert({
      user_id: req.user.id,
      email: req.user.email || null,
      platform,
      version,
      user_agent: (req.get('user-agent') || '').slice(0, 500) || null,
    });
    if (insErr) console.error('[plugin/download] insert failed:', insErr.message);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[plugin/download] error:', err && err.message);
    // Le tracking ne doit jamais faire échouer l'expérience côté site.
    return res.json({ ok: false });
  }
});

module.exports = router;
