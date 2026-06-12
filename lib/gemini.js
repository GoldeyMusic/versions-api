const fetch = require('node-fetch');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────
// Service-role Supabase client pour le cache d'écoute (migration 030).
// Lazy-init et cache à l'échelle du module. Bypassable si les variables
// d'environnement manquent (on log un warn et on saute le cache, sans
// crasher l'analyse).
// ─────────────────────────────────────────────────────────────
let _cacheClient = null;
function getCacheClient() {
  if (_cacheClient) return _cacheClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[gemini-cache] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — listening cache disabled');
    return null;
  }
  _cacheClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _cacheClient;
}

// SHA-256 hex du fileBuffer (même algo que côté front : hashAudioFile dans
// versions-app/src/lib/storage.js, qui utilise Web Crypto subtle.digest).
function computeAudioHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// Usage accumulator (cost tracking, ticket #DASHBOARD-ADMIN).
//
// Accumule les usageMetadata Gemini sur la durée d'une analyse.
// resetUsage() est appelé au début d'une analyse par api/analyze.js,
// et getUsage() à la fin pour alimenter costTracker.logAnalysisCost.
// Le `model` capté est le DERNIER modèle utilisé (utile pour distinguer
// flash vs pro côté tarification).
// ─────────────────────────────────────────────────────────────
let _usage = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0, calls: 0, model: null };

function resetUsage() {
  _usage = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0, calls: 0, model: null };
}

function getUsage() {
  return { ..._usage };
}

function _recordUsage(meta, model) {
  if (!meta) return;
  _usage.promptTokenCount += Number(meta.promptTokenCount || 0);
  _usage.candidatesTokenCount += Number(meta.candidatesTokenCount || 0);
  _usage.totalTokenCount += Number(meta.totalTokenCount || 0);
  _usage.calls += 1;
  if (model) _usage.model = model;
}

// Nettoie les derapages de ton dans "impression" (salutations, simulation relationnelle)
function sanitizeImpression(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let s = raw.trim();
  const firstSentenceEnd = s.search(/[.!?]\s/);
  if (firstSentenceEnd !== -1) {
    const first = s.slice(0, firstSentenceEnd + 1);
    const rest = s.slice(firstSentenceEnd + 2);
    const badOpeningRe = /^\s*(salut|hey|yo|coucou|bonjour|alors|ok|bon|eh bien)\b/i;
    const selfRefRe = /\b(j'ai ecout|j ai ecout|j'ai écout|j ai écout|je viens d'ecout|je viens d ecout|je viens d'écout|je viens d écout|apres ecoute|apres écoute|apres avoir ecout|apres avoir écout)/i;
    const artistAddressRe = /\b(l'artiste|l artiste|cher artiste|chere artiste)\b/i;
    if (badOpeningRe.test(first) || selfRefRe.test(first) || artistAddressRe.test(first)) {
      s = rest.trim();
    }
  }
  if (s && s[0] && s[0] !== s[0].toUpperCase()) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  return s || raw;
}
 
async function uploadToFileApi(fileBuffer, mimeType, displayName) {
  const apiKey = process.env.GEMINI_API_KEY;
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileBuffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    }
  );
  if (!initRes.ok) {
    const err = await initRes.text().catch(() => '');
    throw new Error(`File API init: ${initRes.status} ${err.slice(0, 200)}`);
  }
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('File API: no upload URL returned');
 
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(fileBuffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBuffer,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => '');
    throw new Error(`File API upload: ${uploadRes.status} ${err.slice(0, 200)}`);
  }
  const fileInfo = await uploadRes.json();
  const fileUri = fileInfo.file?.uri;
  if (!fileUri) throw new Error('File API: no file URI in response');
  console.log(`[gemini] file uploaded: ${fileUri}`);
  return fileUri;
}
 
async function callGenerate(model, fileUri, mimeType, prompt, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { file_uri: fileUri, mime_type: mimeType } },
              { text: prompt },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`Listening API: ${res.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
      e.status = res.status;
      throw e;
    }
    const json = await res.json();
    // Capte les usage tokens pour le cost tracking (alimente getUsage())
    _recordUsage(json.usageMetadata, model);
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Listening JSON invalide');
      parsed = JSON.parse(m[0]);
    }
    if (parsed && typeof parsed.impression === 'string') {
      parsed.impression = sanitizeImpression(parsed.impression);
    }
    // Normalise contient_chant en booleen strict (Gemini renvoie parfois la string "true"/"false").
    if (parsed && parsed.contient_chant !== undefined) {
      const v = parsed.contient_chant;
      parsed.contient_chant = (v === true || v === 'true' || v === 'TRUE');
    }
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Listening API: timeout (${timeoutMs / 1000}s)`);
      e.status = 0;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
 
// Bloc d'instructions injecté dans le prompt selon le type vocal du titre.
// - 'vocal' (défaut) : aucune contrainte, le morceau est chanté.
// - 'instrumental_final' : définitivement instrumental → la voix ne doit
//   JAMAIS être mentionnée (ni en manque, ni en piste à traiter).
// - 'instrumental_pending' : instrumental temporaire, les voix arriveront
//   plus tard → ne PAS présenter l'absence de voix comme un défaut, c'est
//   une étape à venir (logique A côté UX, confirmée avec l'artiste).
function buildVocalTypeBlock(vocalType) {
  if (vocalType === 'instrumental_final') {
    return `
TYPE DU MORCEAU : INSTRUMENTAL DEFINITIF (pas de voix, et il n y en aura jamais).
- Ne mentionne JAMAIS la voix, les chœurs, les backing vocals, le lead vocal, dans AUCUN champ (impression, points_forts, a_travailler, espace, dynamique, potentiel).
- Ne dis PAS "absence de voix", "voix a ajouter", "voix a traiter", "il manque une voix". Ne le presente pas comme un manque.
- Evalue ce qui existe reellement : arrangement, beat, basses, pads, textures, progression, dynamique, mix instrumental. C est l oeuvre.
`;
  }
  if (vocalType === 'instrumental_pending') {
    return `
TYPE DU MORCEAU : INSTRUMENTAL TEMPORAIRE (les voix viendront sur les prochaines versions).
- L absence de voix est une ETAPE A FRANCHIR, pas un defaut. Ne la presente JAMAIS comme une faiblesse du mix actuel.
- Si tu dois mentionner la voix, formule-la comme une etape a venir ("voix a enregistrer", "quand les voix arriveront") et NE LA MET PAS dans "a_travailler". Ne lui donne pas de critique negative.
- Concentre ton ecoute sur ce qui existe aujourd hui : arrangement, beat, basses, synthes, textures, espace, dynamique.
`;
  }
  return '';
}

// Instruction de langue injectée au début de l'écoute.
// Le prompt FR reste calibré, on demande juste que le JSON produit
// (impression, points_forts, a_travailler, espace, dynamique, potentiel, mood)
// soit rédigé dans la langue de l'utilisateur.
function buildLocaleInstruction(locale) {
  const norm = (locale || '').toString().toLowerCase().slice(0, 2);
  if (norm === 'en') {
    return `[ABSOLUTE LANGUAGE CONSTRAINT] Even though the detailed instructions below are written in French, your ENTIRE JSON OUTPUT must be in ENGLISH. Every human-visible string — "impression", every item of "points_forts", every item of "a_travailler", "espace", "dynamique", "potentiel", "mood" — MUST be written in English prose. The French text below is a style/structure guide only; DO NOT echo it back in French. Keep the JSON keys UNCHANGED (they are code identifiers). The "contient_chant" value must stay the literal string "true" or "false".

`;
  }
  return '';
}

// Rappel en fin de prompt (recency bias) pour ne pas que Gemini dérive vers
// le FR à cause des 150+ lignes d'instructions en français qui précèdent.
function buildLocaleReminder(locale) {
  const norm = (locale || '').toString().toLowerCase().slice(0, 2);
  if (norm === 'en') {
    return `\n\n=== FINAL REMINDER ===\nThe JSON you output MUST be entirely in ENGLISH. Translate every piece of natural language to English, even if the examples and instructions above are in French. Write as a native English-speaking sound engineer would.\n`;
  }
  return '';
}

function buildPrompt(mode, title, vocalType, locale) {
  const vocalBlock = buildVocalTypeBlock(vocalType);
  const localeInstruction = buildLocaleInstruction(locale);
  const localeReminder = buildLocaleReminder(locale);
  if (mode === 'ref') {
    return `${localeInstruction}Tu rediges un RAPPORT D ECOUTE TECHNIQUE sur le morceau "${title}". Ce rapport est destine a etre lu dans une interface (pas une conversation). Le ton est celui d un ingenieur du son qui documente ce qu il a entendu: precis, nuance, factuel, pas familier. Tu peux dire quand c est bien ET quand c est perfectible, sans forcer l un ou l autre. Tu N ES PAS en train de parler a l artiste, tu documentes une ecoute.

DIRECTIVES IMPORTANTES:
1. Commence par l observation reelle. Si le mix est deja propre, dis-le ("on sent le travail", "c est deja bien avance"). Ne rentre pas direct dans les problemes.
2. Ne force PAS des "a_travailler" s il n y a rien de majeur. Cette liste peut avoir 0, 1, 2 ou 3 items, selon ce que tu entends vraiment. Si tout est propre, laisse-la VIDE.
3. Sois SPECIFIQUE: cite des moments du morceau ("vers 1:24", "au solo"), des elements identifies ("caisse claire", "pad arriere", "guitare clean"), des frequences seulement quand tu es sur.
4. Si le morceau est INSTRUMENTAL et qu il n y a pas de voix, n en parle pas. Ne dis pas "voix a traiter".
5. "VOIX" inclut les leads ET les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
6. Tes observations doivent refleter ce que tu entends, pas des generalites.
7. Termine par un verdict franc dans "potentiel": est-ce pret, presque pret, ou encore du travail, et dans quelle direction.
8. INTERDIT de simuler une relation humaine. PAS de "merci beaucoup", "content de t entendre", "je l ai ecoute plusieurs fois", "j adore", "ravi de", "ca me fait plaisir", ni aucune marque d emotion personnelle ou de familiarite feinte. Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — l IA observe, elle ne ressent rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour", "chapeau"). Reconnaitre qu un titre est un classique/standard reste autorise, et les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres dans une observation. L utilisateur sait qu il parle a une IA. 9. FORMAT STRICT de l ouverture de "impression": la PREMIERE phrase DOIT commencer par un groupe nominal qui designe le morceau ou un de ses elements. Debuts autorises: "Le mix...", "L ambiance...", "La production...", "Le morceau...", "Les voix...", "Le groove...", "L arrangement...", "Cette prod...", etc. DEBUTS INTERDITS: "Salut", "Salut l artiste", "Hey", "Yo", "Alors", "Ok", "Je", "J ai", "Tu", "On", ni aucun verbe a la premiere personne.

MAUVAIS EXEMPLES a ne JAMAIS produire:
- "Salut! J ai ecoute ce morceau et il y a une super vibe qui s en degage." (salutation + je + compliment vague)
- "Salut l artiste, j ai ecoute et l ambiance que tu as creee est vraiment top." (salutation + compliment vague)
- "Hey, ce morceau est cool." (salutation + compliment vague)

BONS EXEMPLES a suivre:
- "Le mix respire bien, la voix est posee devant sans ecraser l arrangement."
- "L ambiance est tendue des les premieres mesures, portee par un pad ample et un kick sourd."
- "La production est soignee: la caisse claire a du corps, les voix sont articulees, l espace stereo est large sans etre diffus."

10. INTERDIT des compliments vagues: "vraiment top", "super", "super vibe", "genial", "c est chouette", "j aime bien", "c est cool". Remplace par des observations concretes et specifiques ("la caisse claire a du corps sans masquer la voix", "l espace stereo est bien tenu sur le refrain"). Le compliment doit toujours etre ancre dans ce que tu entends precisement.
11. Tu peux tutoyer pour l adresse directe quand c est utile (ex: "ta caisse claire a..."), mais JAMAIS pour simuler une relation ("content de t ecouter"). Tutoiement = adresse directe, pas proximite affective. En doute, parle du morceau a la 3e personne ("le morceau", "le mix") plutot que tutoyer.
12. DETECTION DE VOIX: Tu dois aussi indiquer dans le champ "contient_chant" si tu entends du chant sur ce morceau. TRUE si tu entends une voix melodique (lead vocal, choeurs, backing vocals, harmonies vocales), FALSE si le morceau est entierement instrumental. Des "oh" / "ah" brefs samplés qui ne portent pas de ligne melodique = FALSE. Cette detection est utilisee par l application pour proposer a l artiste de mettre a jour le statut de son titre, sois rigoureux et deterministe.
${vocalBlock}
13. COUVERTURE PAR CATEGORIE (champ "par_categorie") — IMPORTANT.
   En plus des champs narratifs, tu DOIS remplir un champ structure "par_categorie" qui couvre LES 6 CATEGORIES CANONIQUES du rapport. Pour CHAQUE categorie, fais 1-2 phrases d observation specifique au morceau, qu il y ait un probleme OU NON. Si la categorie est saine, dis-le franchement avec une observation concrete. Si la categorie a un probleme, decris-le.
   Les 6 categories sont OBLIGATOIRES (sauf "voix" si vocalBlock le dit) et doivent etre des chaines de texte non vides.

JSON strict (aucun markdown, aucun backtick):
{
  "impression": "2-4 phrases. OBLIGATOIREMENT commencer par un groupe nominal sur le morceau (ex: 'Le mix...', 'L ambiance...', 'La production...'). INTERDIT de commencer par 'Salut', 'Hey', 'J ai ecoute', un pronom personnel ou toute salutation. INTERDIT les compliments vagues ('super', 'top', 'cool'). Exemple de bonne ouverture: 'L ambiance est posee des les premieres mesures, portee par un pad ample et une rythmique souple.'",
  "points_forts": ["3-6 observations concretes de ce qui fonctionne, avec des details du morceau"],
  "a_travailler": ["0 a 3 vraies pistes a creuser. VIDE si le mix est deja pret. Chaque item pointe un element precis et suggere une direction sans dicter un plugin."],
  "espace": "image stereo, profondeur, plans. 2-3 phrases specifiques au morceau.",
  "dynamique": "dynamique, respiration, compression percue. 2-3 phrases specifiques.",
  "par_categorie": {
    "voix": "1-2 phrases sur la voix lead et les chœurs/backing vocals. Chaine vide ou cle omise si purement instrumental selon le vocalBlock.",
    "instruments": "1-2 phrases sur les instruments melodiques/harmoniques (guitares, claviers, synthes, pads, leads).",
    "basses_kick": "1-2 phrases sur la basse + le kick : tenue du low-end, complementarite, masquage eventuel.",
    "drums_percu": "1-2 phrases sur la batterie hors kick et les percussions : caisse claire, hi-hats, cymbales.",
    "spatial_reverb": "1-2 phrases sur l image stereo et les effets spatiaux (reverb, delay, plans).",
    "master_loudness": "1-2 phrases sur le rendu global : niveau percu, dynamique, transparence de la compression."
  },
  "potentiel": "une phrase franche de verdict et direction artistique perçue.",
  "mood": "le mood en un mot",
  "contient_chant": "true ou false — voix melodique detectee sur le morceau (leads ou choeurs). FALSE si purement instrumental."
}${localeReminder}`;
  }

  return `${localeInstruction}Tu es ingenieur du son expert et A&R. Tu viens d ecouter ce morceau "${title}". Ecris ton retour comme tu le ferais a un artiste que tu respectes: honnete, precis, nuance. Tu peux dire quand c est bien ET quand c est perfectible, sans forcer l un ou l autre.

DIRECTIVES IMPORTANTES:
1. Commence par TON impression reelle. Si le mix est deja propre, dis-le ("on sent le travail", "c est deja bien avance"). Ne rentre pas direct dans les problemes.
2. Ne force PAS des "a_travailler" s il n y a rien de majeur. Cette liste peut avoir 0, 1, 2 ou 3 items, selon ce que tu entends vraiment. Si tout est propre, laisse-la VIDE.
3. Sois SPECIFIQUE: cite des moments du morceau ("vers 1:24", "au solo"), des elements identifies ("caisse claire", "pad arriere", "guitare clean"), des frequences seulement quand tu es sur.
4. Si le morceau est INSTRUMENTAL et qu il n y a pas de voix, n en parle pas. Ne dis pas "voix a traiter".
5. "VOIX" inclut les leads ET les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
6. Tes observations doivent refleter ce que TU entends, pas des generalites.
7. Termine par un verdict franc dans "potentiel": est-ce pret, presque pret, ou encore du travail, et dans quelle direction.
8. DETECTION DE VOIX: Tu dois aussi indiquer dans le champ "contient_chant" si tu entends du chant sur ce morceau. TRUE si tu entends une voix melodique (lead vocal, choeurs, backing vocals, harmonies vocales), FALSE si le morceau est entierement instrumental. Des "oh" / "ah" brefs samplés qui ne portent pas de ligne melodique = FALSE. Sois rigoureux et deterministe.
9. INTERDIT de simuler une relation humaine. PAS de "merci beaucoup", "content de t entendre", "je l ai ecoute plusieurs fois", "j adore", "ravi de", "ca me fait plaisir", ni aucune marque d emotion personnelle ou de familiarite feinte. Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — l IA observe, elle ne ressent rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour", "chapeau"). Reconnaitre qu un titre est un classique/standard reste autorise, et les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres dans une observation. L utilisateur sait qu il parle a une IA.
10. COUVERTURE PAR CATEGORIE (champ "par_categorie") — IMPORTANT.
   En plus des champs narratifs, tu DOIS remplir un champ structure "par_categorie" qui couvre LES 6 CATEGORIES CANONIQUES du diagnostic. Pour CHAQUE categorie, fais 1-2 phrases d observation specifique au morceau, qu il y ait un probleme OU NON. Si la categorie est saine, dis-le franchement avec une observation concrete (ex: "image stereo large et bien tenue, sans deborder", "caisse claire avec corps et tranchant suffisants"). Si la categorie a un probleme, decris-le et donne une direction.
   Cette couverture sert de base au diagnostic structure : chaque categorie commentee deviendra un item de fiche. Une categorie laissee vide / generique = un item manquant pour l artiste.
   Les 6 categories sont OBLIGATOIRES (sauf "voix" si vocalBlock le dit) et doivent etre des chaines de texte non vides.
${vocalBlock}
JSON strict (aucun markdown, aucun backtick):
{
  "impression": "2-4 phrases d ouverture personnelles et specifiques, tutoyant l artiste.",
  "points_forts": ["3-6 observations concretes de ce qui fonctionne, avec des details du morceau"],
  "a_travailler": ["0 a 3 vraies pistes a creuser. VIDE si le mix est deja pret. Chaque item pointe un element precis et suggere une direction sans dicter un plugin."],
  "espace": "image stereo, profondeur, plans. 2-3 phrases specifiques au morceau.",
  "dynamique": "dynamique, respiration, compression percue. 2-3 phrases specifiques.",
  "par_categorie": {
    "voix": "1-2 phrases sur la voix lead et les chœurs/backing vocals : posement, articulation, intelligibilite, sibilantes, presence, integration. Si purement instrumental selon le vocalBlock, retourne une chaine vide ou omet la cle.",
    "instruments": "1-2 phrases sur les instruments melodiques/harmoniques (guitares, claviers, synthes, pads, leads). Texture, integration, role dans l arrangement.",
    "basses_kick": "1-2 phrases sur la basse + le kick : tenue du low-end, complementarite, tightness, masquage eventuel.",
    "drums_percu": "1-2 phrases sur la batterie hors kick et les percussions : caisse claire, hi-hats, cymbales, percussions colorees. Impact, separation, tranchant.",
    "spatial_reverb": "1-2 phrases sur l image stereo et les effets spatiaux (reverb, delay, plans). Largeur, profondeur, mono-compat percue.",
    "master_loudness": "1-2 phrases sur le rendu global du master : niveau percu, dynamique d ensemble, transparence ou ecrasement de la compression, clipping eventuel."
  },
  "potentiel": "une phrase franche de verdict et direction artistique perçue.",
  "mood": "le mood en un mot",
  "contient_chant": "true ou false — voix melodique detectee sur le morceau (leads ou choeurs). FALSE si purement instrumental."
}${localeReminder}`;
}
 
async function analyzeListening(fileBuffer, mimeType, title, artist, mode, vocalType, locale, opts = {}) {
  // opts.extraContext (2026-06-12, plugin express) : contexte additionnel
  // apposé au prompt — écoute d'une piste isolée (stem) + profil utilisateur.
  // Voir versions-plugin/docs/EXPRESS_PROFILE_BACKEND.md.
  const prompt = buildPrompt(mode, title || 'ce morceau', vocalType || 'vocal', locale)
               + (opts.extraContext ? '\n\n' + String(opts.extraContext) : '');

  // ── Cache lookup (migration 030) ─────────────────────────────────
  // Si on a un userId (= contexte authentifié d'analyse normale), on tente
  // le lookup par hash audio. Cache hit → on saute Gemini et on renvoie
  // l'écoute déjà calculée par un upload précédent (même fichier binaire,
  // n'importe quel user).
  const userId = opts.userId || null;
  const audioHash = (fileBuffer && fileBuffer.length) ? computeAudioHash(fileBuffer) : null;
  const cacheClient = audioHash ? getCacheClient() : null;
  if (audioHash && cacheClient) {
    try {
      const { data: cached } = await cacheClient
        .from('gemini_listening_cache')
        .select('listening_json')
        .eq('audio_hash', audioHash)
        .maybeSingle();
      if (cached && cached.listening_json) {
        console.log(`[gemini] cache hit on audio_hash ${audioHash.slice(0, 12)}… — skipping Gemini call`);
        return cached.listening_json;
      }
    } catch (err) {
      console.warn('[gemini-cache] lookup failed:', err.message);
    }
  }

  // ── Cache miss : appel Gemini classique ──────────────────────────
  console.log(`[gemini] uploading ${Math.round(fileBuffer.length / 1024)}KB via File API...`);
  const fileUri = await uploadToFileApi(fileBuffer, mimeType, title || 'audio');

  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-1.5-flash'];
  const RETRY_CODES = [429, 500, 502, 503, 504];
  const MAX_ATTEMPTS_PER_MODEL = 3;
  let lastError = null;
  let listening = null;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        console.log(`[gemini] ${model} attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL}...`);
        listening = await callGenerate(model, fileUri, mimeType, prompt);
        console.log(`[gemini] ${model} success on attempt ${attempt}`);
        break;
      } catch (err) {
        lastError = err;
        const isTransient = err.status && RETRY_CODES.includes(err.status);
        if (!isTransient) {
          console.warn(`[gemini] ${model} non-retryable: ${err.message}`);
          break;
        }
        if (attempt < MAX_ATTEMPTS_PER_MODEL) {
          const wait = Math.min(3000 * Math.pow(2, attempt - 1), 30000) + Math.floor(Math.random() * 1500);
          console.warn(`[gemini] ${model} ${err.status} — retry in ${(wait / 1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.warn(`[gemini] ${model} exhausted retries, trying next model...`);
        }
      }
    }
    if (listening) break;
  }
  if (!listening) throw lastError || new Error('Listening API: all models unavailable');

  // ── Cache insert (fire-and-forget) ───────────────────────────────
  // On stocke l'écoute pour bénéficier aux uploads ultérieurs du même
  // fichier (par cet user ou un autre). userId nullable côté DB :
  // si pas d'user identifié, on insert quand même mais sans contributeur
  // (la cascade ON DELETE ne s'appliquera pas — entrée semi-orpheline,
  // acceptable). Erreurs non-bloquantes (doesn't fail l'analyse).
  if (audioHash && cacheClient) {
    cacheClient
      .from('gemini_listening_cache')
      .insert({
        audio_hash: audioHash,
        listening_json: listening,
        contributed_by_user_id: userId,
      })
      .then(({ error }) => {
        if (error && !/duplicate key/i.test(error.message)) {
          console.warn('[gemini-cache] insert failed:', error.message);
        }
      })
      .catch((err) => console.warn('[gemini-cache] insert exception:', err.message));
  }

  return listening;
}
 
module.exports = { analyzeListening, resetUsage, getUsage };
