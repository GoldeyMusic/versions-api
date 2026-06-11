const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const claudeLib = require('../lib/claude');
const { generateFiche, formulatePerception, generateEvolution } = claudeLib;
const geminiLib = require('../lib/gemini');
const { analyzeListening } = geminiLib;
const { retrievePureMixContext, formatContextForPrompt } = require('../lib/rag');
const { transcodeAndUpload } = require('../lib/audio-storage');
const { analyzeFile: fadrAnalyzeFile, extractFadrData, downloadStems: fadrDownloadStems } = require('../lib/fadr');
const { measureMaster: dspMeasureMaster, measureStem: dspMeasureStem, measureStereoField: dspMeasureStereoField } = require('../lib/dsp');
const { logAnalysisCost } = require('../lib/costTracker');
const {
  computeAudioHash,
  computeParamsSignature,
  lookupAnalysisCache,
  saveAnalysisCache,
} = require('../lib/analysis-cache');
const { getBalance, applyCreditDelta, debitOrdered } = require('../lib/credits');
const { persistAnalysisResult } = require('../lib/persistAnalysis');
// Limiteur de requêtes ciblé : appliqué UNIQUEMENT sur les routes coûteuses
// (/start, /diagnose). PAS sur /status/:jobId qui est pollé toutes les 3s
// pendant toute la durée de l'analyse (sinon 429 dès le 11ᵉ poll).
const { analyzeLimiter } = require('../lib/rateLimit');
// Classifie les exceptions du pipeline en codes stables (analysis_failed,
// analysis_timeout, analysis_service_unavailable…) pour ne plus laisser fuiter
// l'`err.message` anglais brut vers le front via job.error.
const { classifyJobError } = require('../lib/jobErrors');

// Toggle global monétisation. Tant que MONETIZATION_ENABLED ≠ 'true' :
// pas de check balance, pas de débit, pas de refund — tout passe.
// Phase test : laisser à false. Quand Stripe est branché : true.
const MONETIZATION_ENABLED = process.env.MONETIZATION_ENABLED === 'true';

// Timeout dur cote pipeline pour ne pas bloquer la fiche si Fadr est lent ou KO.
// L analyse Fadr (upload + asset + stem polling) prend typiquement 30-90s ; au-dela
// on se passe des mesures pour ne pas degrader l UX. Mode degrade = fadrMetrics=null.
const FADR_TIMEOUT_MS = 90_000;
// DSP maison (ffmpeg ebur128) — beaucoup plus rapide que Fadr (10-20s pour
// un titre de 4 min). On garde une marge confortable au cas ou un fichier
// long ou un container exotique demande plus de temps.
const DSP_TIMEOUT_MS = 60_000;
// Phase 3 (DSP_PLAN B.4) — mesures par stem (4 stems × ebur128 + 2 bandpass
// + Mid/Side + mono compat sur master). Sequentielles sur la latence du
// download Fadr (qui est deja inclus dans FADR_TIMEOUT_MS) puis ffmpeg
// ~5-10s par stem en parallele. On laisse 90s totaux pour absorber le
// download des 4 stems S3 et les 8-12 spawns ffmpeg simultanes.
const STEMS_TIMEOUT_MS = 90_000;
const STEREO_TIMEOUT_MS = 60_000;
const router = express.Router();
// Cap upload 80 Mo : 12 min × WAV 16-bit 44.1 kHz mono ou 12 min de MP3/AAC
// stéréo HQ. multer en memoryStorage → 200 Mo × N requêtes parallèles saturait
// la RAM Railway. 80 Mo couvre largement le cap durée 12 min imposé par
// MAX_AUDIO_DURATION_SEC. Le path "upload direct + storagePath" reste
// disponible pour les WAV plus gros (passe par Supabase Storage).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

// Client Supabase service-role pour télécharger les fichiers uploadés
// directement par le navigateur dans `tmp/{userId}/...` (path d'upload direct).
// On bypass RLS volontairement : seul le backend orchestre l'analyse.
const supabaseStorage = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Mapping ext → mime-type pour reconstituer un objet `req.file`-like depuis
// un téléchargement Supabase Storage. Reste minimal : on fallback `audio/mpeg`
// pour tout ce qui sort de la liste, ce qui couvre 99 % des cas pratiques.
function mimeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'wav') return 'audio/wav';
  if (e === 'mp3') return 'audio/mpeg';
  if (e === 'aac' || e === 'm4a') return 'audio/aac';
  if (e === 'flac') return 'audio/flac';
  if (e === 'ogg' || e === 'opus') return 'audio/ogg';
  if (e === 'aiff' || e === 'aif') return 'audio/aiff';
  return 'audio/mpeg';
}

// Middleware conditionnel : déclenche multer UNIQUEMENT si la requête est
// multipart (content-type "multipart/form-data"). Si JSON (le nouveau path
// upload direct), on laisse `express.json()` global avoir déjà rempli
// `req.body` et on saute multer — `req.file` reste undefined, et la route
// téléchargera le fichier depuis Supabase via `req.body.storagePath`.
function multerIfMultipart(uploadMiddleware) {
  return (req, res, next) => {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('multipart/form-data')) {
      return uploadMiddleware(req, res, next);
    }
    next();
  };
}

const jobs = new Map();
function makeJobId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Refund le crédit débité au start si le pipeline a planté. Idempotent :
// flip le flag creditDebited à false dans le jobs Map pour ne pas double-refund.
// No-op si MONETIZATION_ENABLED=false ou si le crédit n'a jamais été débité.
async function refundCreditIfDebited(jobId, errorMessage) {
  if (!MONETIZATION_ENABLED) return;
  const j = jobs.get(jobId);
  if (!j || !j.creditDebited || !j.userId) return;
  try {
    // Refund vers le bucket `pack` : pipeline raté, on rend le crédit "à vie"
    // (un peu plus généreux qu'au prélèvement initial, mais simple à expliquer
    // et le crédit n'est pas perdu si l'utilisateur résilie son abo plus tard).
    await applyCreditDelta({
      userId: j.userId,
      delta: +1,
      reason: 'refund_failed',
      bucket: 'pack',
      jobId,
      notes: `Pipeline failed: ${(errorMessage || '').slice(0, 200)}`,
    });
    jobs.set(jobId, { ...j, creditDebited: false });
    console.log(`[analyze] refunded 1 credit to ${j.userId} (job ${jobId})`);
  } catch (e) {
    console.error('[analyze] refund failed:', e.message);
  }
}

// Flow (pipeline en 2 phases) :
//   Phase A  — Gemini (ecoute) -> RAG PureMix -> Claude.formulatePerception -> job passe en 'awaiting_intent'
//              (transcodage MP3 + upload Supabase lances en parallele)
//   [attente de POST /diagnose/:jobId avec l intention de l utilisateur (ou skip)]
//   Phase B  — Claude.generateFiche(..., intent) -> job 'complete'
//
// Retro-compat : POST /start avec body field `skipIntent=true` enchaine les 2 phases
// comme avant (pratique pour tests curl ou pour le front tant qu il n expose pas l ecran intention).
// Cap audio (sync avec front : src/components/AddModal.jsx).
// 720s = 12 min : limite anti-DJ-set qui protège l'API Fadr/Gemini.
// On valide AVANT de créer le job pour pouvoir renvoyer 413 au client.
const MAX_AUDIO_DURATION_SEC = 720;

router.post('/start', analyzeLimiter, multerIfMultipart(upload.single('file')), async (req, res) => {
  // ── Garde-fou durée audio (cap 12 min) ────────────────────────
  // Le front envoie déjà durationSeconds calculé via HTMLAudioElement.
  // Ici on revalide pour bloquer un éventuel bypass (curl, script tiers).
  // Si la durée n'est pas fournie OU est égale à 0, on laisse passer
  // (cas legacy : analyses anciennes qui n'envoyaient pas le champ).
  // TODO eventuel : probe ffprobe côté serveur pour ne plus dépendre du
  // chiffre client — coût négligeable mais ajoute une dépendance.
  const durationSecondsRaw = parseFloat(req.body.durationSeconds);
  if (Number.isFinite(durationSecondsRaw) && durationSecondsRaw > MAX_AUDIO_DURATION_SEC) {
    return res.status(413).json({
      error: 'audio_too_long',
      message: `Audio file exceeds ${MAX_AUDIO_DURATION_SEC} seconds (12 minutes).`,
      maxSeconds: MAX_AUDIO_DURATION_SEC,
      receivedSeconds: Math.round(durationSecondsRaw),
    });
  }

  // ── Garde-fou crédits (cap balance) ─────────────────────────────
  // Phase test : MONETIZATION_ENABLED=false → on bypass entièrement.
  // En prod : check balance > 0, sinon 402 + redirect /pricing front.
  // SÉCURITÉ : le userId vient du JWT (requireAuth a posé req.user) —
  // jamais du body, sinon n'importe qui pourrait débiter le compte
  // d'un autre utilisateur en passant un userId arbitraire.
  const userIdEarly = req.user?.id || null;
  if (MONETIZATION_ENABLED && userIdEarly) {
    let balanceInfo = null;
    try {
      balanceInfo = await getBalance(userIdEarly);
    } catch (e) {
      console.error('[analyze] balance check failed:', e.message);
      return res.status(500).json({ error: 'balance_check_failed' });
    }
    const total = balanceInfo?.balance ?? 0;
    if (total < 1) {
      return res.status(402).json({
        error: 'no_credits',
        message: 'Aucun crédit disponible. Achète un pack ou un abonnement pour continuer.',
        balance: total,
        redirect: '/#/pricing',
      });
    }
  }

  // ── Raccord plugin DAW (Phase 3 niv. 3) : trackId fourni → résolution
  // serveur du contexte (titre, projet, vocal_type, intention, version
  // précédente). Le plugin n'envoie que { storagePath, trackId, version?,
  // durationSeconds } : on ne fait JAMAIS confiance au client pour le
  // titre/projet (une faute de frappe créerait un doublon de track).
  // SÉCURITÉ : le track doit appartenir au user du JWT — validé ICI,
  // AVANT la création du job et le débit du crédit (404 propre, pas de
  // cycle débit/refund pour un trackId pourri).
  let pluginTrack = null;
  {
    const trackIdRaw = req.body.trackId;
    const isUuid = typeof trackIdRaw === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trackIdRaw);
    if (trackIdRaw && !isUuid) {
      return res.status(400).json({ error: 'track_id_invalid' });
    }
    if (isUuid) {
      const { data: trk, error: trkErr } = await supabaseStorage
        .from('tracks')
        .select('id, title, project_id, vocal_type, artistic_intent')
        .eq('id', trackIdRaw)
        .eq('user_id', userIdEarly || '00000000-0000-0000-0000-000000000000')
        .maybeSingle();
      if (trkErr || !trk) {
        return res.status(404).json({ error: 'track_not_found' });
      }
      pluginTrack = trk;
    }
  }

  const jobId = makeJobId();
  jobs.set(jobId, { status: 'pending', progress: 'Démarrage…', pct: 0, userId: userIdEarly, creditDebited: false });
  res.json({ jobId });

  // ── Débit immédiat du crédit (au start de l'analyse) ────────────
  // Pattern AubioMix : on débite tout de suite, on refund automatiquement
  // si le pipeline plante. Visible dans la sidebar : balance baisse, puis
  // remonte si erreur. Audit complet via credit_events.
  // Modèle Splice (révision 2026-04-29) : débit ordonné via debitOrdered —
  // consomme subscription_balance D'ABORD, puis pack_balance.
  if (MONETIZATION_ENABLED && userIdEarly) {
    try {
      const result = await debitOrdered({
        userId: userIdEarly,
        amount: 1,
        jobId,
        notes: `Analyse ${jobId}`,
      });
      if (result?.ok) {
        const j = jobs.get(jobId) || {};
        jobs.set(jobId, { ...j, creditDebited: true });
      } else {
        console.warn(`[analyze] debit refused (${result?.reason}) — continuing without debit (race entre check et débit)`);
      }
    } catch (e) {
      // Si le débit plante (ex. balance déjà 0 entre check et débit),
      // on n'arrête pas l'analyse — c'est mieux pour l'UX que de laisser
      // un job zombi. Loggué pour suivi.
      console.error('[analyze] debit failed (continuing without debit):', e.message);
    }
  }

  // Reset les accumulators de tokens AVANT le pipeline (cost tracking).
  // Lus à la fin de runDiagnosticPhase via getUsage() pour insérer la
  // ligne analysis_cost_logs (cf. lib/costTracker.js).
  // Note : les accumulators sont module-scope, donc thread-safe seulement
  // si une seule analyse tourne à la fois. Le runtime Vercel garantit
  // ça (1 invocation = 1 process). À surveiller si on passe en worker pool.
  claudeLib.resetUsage();
  geminiLib.resetUsage();

  (async () => {
    try {
      const mode = req.body.mode, daw = req.body.daw;
      // title/version/skipIntent/inlineIntent/projectId/vocalType : `let`
      // (et non const) parce que le bloc pluginTrack ci-dessous les
      // remplace par les valeurs résolues serveur quand trackId est fourni.
      let title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^/.]+$/, '') : '');
      let version = req.body.version || '';
      const artist = req.body.artist || '';
      // userId DÉRIVÉ DU JWT — cf. note ci-dessus.
      const userId = req.user?.id || null;
      let skipIntent = req.body.skipIntent === 'true' || req.body.skipIntent === true;
      const durationSeconds = parseFloat(req.body.durationSeconds) || null;
      let previousFiche = null;
      try { previousFiche = req.body.previousFiche ? JSON.parse(req.body.previousFiche) : null; } catch {}
      // previousAnalysisResult : { fiche, listening } de la version precedente du meme titre.
      // Sert a generer le bandeau "evolution depuis V_n-1" (suivi inter-versions).
      // Si absent : pas d evolution generee, pipeline identique a avant.
      let previousAnalysisResult = null;
      try {
        previousAnalysisResult = req.body.previousAnalysisResult
          ? JSON.parse(req.body.previousAnalysisResult)
          : null;
      } catch {}
      // Ticket 4.2 — items coches "implementes" sur la version precedente.
      // Tableau d ids passe par le front depuis la table mix_note_completions.
      // Sert au verrou des sub-scores (advice-followed locking).
      let previousCompletions = null;
      try {
        const raw = req.body.previousCompletions;
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) previousCompletions = arr.filter((x) => typeof x === 'string');
        }
      } catch {}
      const locale = typeof req.body.locale === 'string' && req.body.locale.trim().length > 0
        ? req.body.locale.trim()
        : 'fr';
      // Intention inline (fournie avant analyse, ex: heritee du titre pour une V2+)
      let inlineIntent = typeof req.body.intent === 'string' && req.body.intent.trim().length > 0
        ? req.body.intent.trim()
        : null;
      // Genre musical : declare par l artiste a l upload (texte libre court)
      // ou flag "Choisir automatiquement" -> inference par Claude depuis l ecoute.
      const declaredGenre = typeof req.body.declaredGenre === 'string' && req.body.declaredGenre.trim().length > 0
        ? req.body.declaredGenre.trim().slice(0, 600)
        : null;
      const genreUnknown = req.body.genreUnknown === 'true' || req.body.genreUnknown === true;
      // Mix / Master toggle (refonte 2026-04-30). Default 'mix' pour rester
      // permissif si le front n'envoie rien (anciens clients, fallback). Seules
      // les deux valeurs prévues sont acceptées — toute autre chaîne est
      // ramenée à 'mix' silencieusement (validation côté DB via la migration
      // 021 si on devait la persister, mais ici on l'utilise juste pour
      // calibrer le prompt + la pondération).
      const uploadType = (req.body.uploadType === 'master' || req.body.uploadType === 'mix')
        ? req.body.uploadType
        : 'mix';
      // BPM optionnel saisi par l'artiste. Override Fadr post-analyse si
      // present. Validation : nombre dans [30, 300]. Hors borne ou
      // non-numerique = ignore (Fadr garde la main).
      const userBpmRaw = req.body.userBpm;
      const userBpm = (() => {
        if (userBpmRaw == null || userBpmRaw === '') return null;
        const n = parseFloat(String(userBpmRaw).trim().replace(',', '.'));
        if (!Number.isFinite(n) || n < 30 || n > 300) return null;
        return n;
      })();
      // projectId : optionnel — si le front a choisi un projet précis dans
      // AddModal, on le passe ici. Sinon persistAnalysisResult retombera sur
      // le projet par défaut de l'utilisateur (premier projet, ou crée
      // "Mon premier projet"). Validation : format uuid v4.
      const projectIdRaw = req.body.projectId;
      let projectId = (typeof projectIdRaw === 'string'
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(projectIdRaw))
        ? projectIdRaw
        : null;
      // copyrightAcknowledgedAt : timestamp ISO de l'acceptation copyright dans
      // AddModal (migration 029). Sert à l'audit GDPR de droits d'auteur.
      const copyrightAcknowledgedAt = (typeof req.body.copyrightAcknowledgedAt === 'string'
        && req.body.copyrightAcknowledgedAt.trim().length > 0)
        ? req.body.copyrightAcknowledgedAt.trim()
        : null;
      // vocalType : passé par AddModal pour les nouveaux titres. Validation
      // côté helper, ici on relaie tel quel.
      let vocalType = (typeof req.body.vocalType === 'string' && req.body.vocalType.trim().length > 0)
        ? req.body.vocalType.trim()
        : null;

      // ── Application du contexte track résolu (plugin DAW, cf. garde
      // pluginTrack en tête de route). Le serveur fait foi : titre/projet
      // du track lié, intention artistique du titre, version précédente
      // pour le bandeau évolution + verrou conseils, nom de version auto.
      if (pluginTrack) {
        title = pluginTrack.title;
        projectId = pluginTrack.project_id;
        if (!vocalType) vocalType = pluginTrack.vocal_type || null;
        if (!inlineIntent && pluginTrack.artistic_intent) {
          inlineIntent = pluginTrack.artistic_intent;
        }
        // Le plugin n'a pas d'étape intention interactive : jamais
        // d'awaiting_intent sur ce chemin (sinon le job resterait gelé).
        skipIntent = true;

        try {
          const { data: prevRows } = await supabaseStorage
            .from('versions')
            .select('id, name, analysis_result, created_at')
            .eq('track_id', pluginTrack.id)
            .order('created_at', { ascending: false })
            .limit(1);
          const prev = prevRows?.[0] || null;
          const prevAR = prev?.analysis_result || null;
          if (!previousFiche && prevAR?.fiche) previousFiche = prevAR.fiche;
          if (!previousAnalysisResult && prevAR?.fiche && prevAR?.listening) {
            previousAnalysisResult = {
              fiche: prevAR.fiche,
              listening: prevAR.listening,
              intent_used: prevAR.intent_used || null,
            };
          }
          // Items cochés "implémentés" sur la version précédente →
          // verrou des sub-scores (même logique que le front, ticket 4.2).
          if (!previousCompletions && prev?.id) {
            const { data: comps } = await supabaseStorage
              .from('mix_note_completions')
              .select('item_id, completed')
              .eq('version_id', prev.id);
            const done = (comps || []).filter((c) => c.completed).map((c) => c.item_id);
            if (done.length) previousCompletions = done;
          }
        } catch (e) {
          // Mode dégradé : pas d'évolution, fiche quand même.
          console.warn('[analyze] plugin track context fetch failed (continuing):', e.message);
        }

        // Nom de version auto vN+1 si le client n'en a pas fourni.
        if (!version) {
          try {
            const { count } = await supabaseStorage
              .from('versions')
              .select('id', { count: 'exact', head: true })
              .eq('track_id', pluginTrack.id);
            version = `v${(count || 0) + 1}`;
          } catch { version = 'v1'; }
        }
      }

      let fileBuffer = null, fileMime = null, fileName = null;
      // Path historique : multipart upload via multer.
      if (req.file) {
        fileBuffer = req.file.buffer;
        fileMime = req.file.mimetype || 'audio/mpeg';
        fileName = req.file.originalname || 'audio.mp3';
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB) [multipart]`);
      }
      // Path nouveau : upload direct navigateur → Supabase. Le client a fait
      // un PUT signé sur `tmp/{userId}/...` puis nous a envoyé un body JSON
      // avec `storagePath`. On télécharge ici (service-role, bypass RLS).
      // Permet d'envoyer des WAV de plusieurs dizaines de Mo sans se cogner
      // à la limite ~4,5 Mo body de Vercel serverless.
      else if (req.body.storagePath && typeof req.body.storagePath === 'string') {
        const path = req.body.storagePath;
        // SÉCURITÉ : valider que le path appartient au user authentifié.
        // Sans ce check, un attaquant peut soumettre `tmp/<victim_uuid>/...`
        // et faire analyser l'audio d'un autre utilisateur sur SES crédits.
        // Format attendu : `tmp/<uuid_user>/<timestamp>-<uuid>.<ext>`.
        const SAFE_PATH = /^tmp\/[a-f0-9-]{36}\/[\w.-]+\.(wav|mp3|aac|m4a|flac|ogg|opus|aiff|aif)$/i;
        if (!SAFE_PATH.test(path)) {
          throw new Error('storagePath_invalid');
        }
        if (!path.startsWith(`tmp/${userId}/`)) {
          throw new Error('storagePath_forbidden');
        }
        const t0 = Date.now();
        const { data, error } = await supabaseStorage.storage
          .from('audio')
          .download(path);
        if (error || !data) {
          throw new Error(`Storage download failed: ${error?.message || 'no data'}`);
        }
        const ab = await data.arrayBuffer();
        fileBuffer = Buffer.from(ab);
        fileName = path.split('/').pop() || 'audio';
        const ext = (fileName.includes('.') ? fileName.split('.').pop() : '').toLowerCase();
        fileMime = mimeFromExt(ext);
        console.log(`[analyze] ${fileName} (${Math.round(fileBuffer.length / 1024)}KB) [storage:${path}, ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
        // Cleanup best-effort du tmp/ : plus rien n'a besoin du fichier source
        // une fois qu'il est en buffer mémoire. Si la suppression rate (ex.
        // fichier déjà absent), on log mais on ne bloque pas l'analyse.
        // Évite l'accumulation d'orphelins dans le bucket `audio/tmp/...`.
        if (path.startsWith('tmp/')) {
          supabaseStorage.storage.from('audio').remove([path])
            .then(({ error: rmErr }) => {
              if (rmErr) console.warn('[analyze] tmp cleanup failed:', rmErr.message);
            })
            .catch((e) => console.warn('[analyze] tmp cleanup threw:', e.message));
        }
      }

      // ── CACHE FICHE COMPLET (migration 031) ──────────────────────────
      // Lookup tres tot : si on a deja analyse ce fichier avec les memes
      // parametres (intent, genre declare, type d'upload), on sert la fiche
      // mise en cache et on saute tout le pipeline lourd (Gemini, Fadr,
      // DSP, stems, stereo, Claude). On laisse tourner uniquement le
      // transcoding/upload Storage en parallele (necessaire pour avoir un
      // storage_path frais pour ce upload-ci, que le BottomPlayer puisse
      // jouer le morceau).
      let cachedAnalysis = null;
      let cacheAudioHash = null;
      let cacheParamsSig = null;
      if (fileBuffer) {
        cacheAudioHash = computeAudioHash(fileBuffer);
        cacheParamsSig = computeParamsSignature({
          intent: inlineIntent,
          declaredGenre,
          uploadType,
          userBpm,
        });
        cachedAnalysis = await lookupAnalysisCache(cacheAudioHash, cacheParamsSig);
        if (cachedAnalysis) {
          console.log(`[analyze] cache hit on audio_hash ${cacheAudioHash.slice(0, 12)}… — skipping pipeline`);
        }
      }

      // Branche cache hit : transcode + upload pour le storage_path, puis
      // populate le job final avec le cached_result. On ne touche pas a
      // l evolution ni a previousAnalysisResult — si fournis, on continue
      // sans evolution (le delta version-a-version recalcule sur demande).
      if (cachedAnalysis) {
        const storagePromiseFast = transcodeAndUpload({ fileBuffer, fileMime, userId })
          .catch((err) => {
            console.error('[analyze] storage transcode error (cache hit branch):', err.message);
            return null;
          });
        jobs.set(jobId, {
          status: 'pending', stage: 'started',
          progress: 'Récupération de l\'analyse…', pct: 50,
          meta: { title, artist, daw, mode, version },
        });
        // Lissage de la barre pendant le transcoding+upload (~10-15s).
        // Sans ce ticker, la barre reste figee a 50 % puis saute a 100 %,
        // ce qui donne l impression que le job freeze. On monte de 50 a 90
        // par paliers de +2 % toutes les 700 ms (cap a 90 pour garder de
        // la marge — le 100 % vient quand storage_path est dispo).
        let lissagePct = 50;
        const lissageTicker = setInterval(() => {
          lissagePct = Math.min(lissagePct + 2, 90);
          const cur = jobs.get(jobId);
          if (!cur || cur.status !== 'pending') {
            clearInterval(lissageTicker);
            return;
          }
          jobs.set(jobId, { ...cur, pct: lissagePct });
        }, 700);
        const storagePathFast = await storagePromiseFast;
        clearInterval(lissageTicker);

        // Persistance backend (fix architectural 2026-05-21) — même logique
        // que le chemin pipeline complet, branchée ici sur le cache hit.
        let persistResultFast = { ok: false, error: null };
        if (userId && cachedAnalysis?.fiche) {
          persistResultFast = await persistAnalysisResult({
            userId,
            title: title || 'Titre inconnu',
            versionName: version || 'v1',
            projectId,
            trackId: pluginTrack ? pluginTrack.id : null,
            vocalType,
            fiche: cachedAnalysis.fiche,
            listening: cachedAnalysis.listening || null,
            evolution: null,
            intent_used: inlineIntent || null,
            fadrMetrics: cachedAnalysis.fadrMetrics || null,
            dspMetrics: cachedAnalysis.dspMetrics || null,
            stemsMetrics: cachedAnalysis.stemsMetrics || null,
            stereoMetrics: cachedAnalysis.stereoMetrics || null,
            storagePath: storagePathFast || null,
            audioHash: cacheAudioHash || null,
            locale,
            uploadType,
            copyrightAcknowledgedAt,
          });
          if (!persistResultFast.ok) {
            console.warn('[analyze] persistAnalysisResult (cache hit) failed:', persistResultFast.error);
          }
        } else {
          persistResultFast = { ok: false, error: userId ? 'no_cached_fiche' : 'no_user_id' };
        }

        const curFast = jobs.get(jobId) || {};
        jobs.set(jobId, {
          ...curFast,
          status: 'complete', stage: 'all_done',
          progress: 'Terminé', pct: 100,
          fiche: cachedAnalysis.fiche || null,
          listening: cachedAnalysis.listening || null,
          fadrMetrics: cachedAnalysis.fadrMetrics || null,
          dspMetrics: cachedAnalysis.dspMetrics || null,
          stemsMetrics: cachedAnalysis.stemsMetrics || null,
          stereoMetrics: cachedAnalysis.stereoMetrics || null,
          evolution: null,
          storagePath: storagePathFast || null,
          intent_used: inlineIntent || null,
          pmSources: [],
          audioHash: cacheAudioHash,
          // Persistance backend — voir lib/persistAnalysis.js
          persistedTrackId: persistResultFast.ok ? persistResultFast.trackId : null,
          persistedVersionId: persistResultFast.ok ? persistResultFast.versionId : null,
          persistError: persistResultFast.ok ? null : (persistResultFast.error || 'unknown'),
        });
        // Cache hit = pas d appel modele = on rembourse le credit qui a ete
        // debite en amont (line ~185). Sinon l'utilisateur paie pour zero appel.
        // Note: on reutilise le reason 'refund_failed' valide par le CHECK
        // constraint de credit_events (migration 016). Pas de reason
        // dedie pour cache hit a ce jour — on disambigue via le champ notes.
        const jForRefund = jobs.get(jobId) || {};
        if (MONETIZATION_ENABLED && jForRefund.creditDebited && jForRefund.userId) {
          try {
            await applyCreditDelta({
              userId: jForRefund.userId,
              delta: 1,
              reason: 'refund_failed',
              jobId,
              notes: 'cache_hit',
            });
            jobs.set(jobId, { ...jForRefund, creditDebited: false });
            console.log(`[analyze] refunded 1 credit to ${jForRefund.userId} (cache hit)`);
          } catch (refundErr) {
            console.warn('[analyze] cache hit refund failed:', refundErr.message);
          }
        }
        return; // skip tout le pipeline
      }

      // ── STAGE PARALLELE: Fadr (BPM, tonalite, stems) ──
      // Lance des reception du fichier en parallele de Gemini, du RAG et de la formulation
      // perception. On l attend juste avant generateFiche (avec timeout pour ne pas
      // bloquer la fiche si Fadr est lent). Erreurs et timeout = mode degrade (null).
      let fadrPromise = null;
      if (fileBuffer) {
        const ext = (fileName.split('.').pop() || 'mp3').toLowerCase();
        const t0 = Date.now();
        fadrPromise = fadrAnalyzeFile(fileBuffer, fileName, ext, fileMime)
          .then((task) => {
            const data = extractFadrData(task);
            console.log(`[analyze] fadr done in ${((Date.now() - t0) / 1000).toFixed(1)}s — bpm:${data.bpm} key:${data.key} lufs:${data.lufs} stems:${(data.stems || []).length}`);
            return data;
          })
          .catch((err) => {
            console.error(`[analyze] fadr error after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, err.message);
            return null;
          });
      }

      // ── STAGE PARALLELE: DSP maison (LUFS, LRA, True peak) ──
      // Phase 2 du DSP_PLAN. Tournant via ffmpeg ebur128 (ITU-R BS.1770).
      // Beaucoup plus rapide que Fadr (10-20s typique) et sans cout API.
      // Mode degrade : null si ffmpeg KO ou timeout.
      let dspPromise = null;
      if (fileBuffer) {
        dspPromise = dspMeasureMaster(fileBuffer)
          .catch((err) => {
            console.error('[analyze] dsp measureMaster error:', err.message);
            return null;
          });
      }

      // ── STAGE PARALLELE: STEMS (Phase 3 / DSP_PLAN B.4) ──
      // Chaine apres Fadr (besoin de l'asset.stems pour les URLs signees).
      // Telecharge les buffers en RAM, mesure chaque stem (LUFS + bandpass
      // sibilantes/presence), puis jette les buffers. Mode degrade total :
      // null si Fadr KO, ou tableau partiel si certains stems KO.
      let stemsPromise = null;
      if (fadrPromise) {
        stemsPromise = fadrPromise.then(async (data) => {
          if (!data?.stems?.length) return null;
          // downloadStems accepte un faux asset { stems: [...] } puisqu'il
          // ne lit que asset.stems. Evite de propager le `task` complet.
          let downloaded = null;
          try {
            downloaded = await fadrDownloadStems({ stems: data.stems });
          } catch (err) {
            console.error('[analyze] stems download error:', err.message);
            return null;
          }
          if (!downloaded || !downloaded.length) return null;
          // Mesures paralleles, buffers jetes apres mesure.
          const measured = await Promise.all(downloaded.map(async (s) => {
            const m = await dspMeasureStem(s.buffer, s.stemType).catch((err) => {
              console.warn(`[analyze] stem ${s.stemType} measure error:`, err.message);
              return null;
            });
            return {
              name: s.name,
              stemType: s.stemType,
              sizeBytes: s.sizeBytes,
              ...(m || {}),
            };
          }));
          // On garde tous les stems telecharges meme si la mesure a echoue
          // (le front saura : sizeBytes != null + lufs == null = mesure ratee).
          return measured;
        }).catch((err) => {
          console.error('[analyze] stems chain error:', err.message);
          return null;
        });
      }

      // ── STAGE PARALLELE: STEREO FIELD (Phase 3 / DSP_PLAN B.3) ──
      // Mesure independante du Fadr — utilise le buffer master directement.
      // On chaine sur dspPromise pour reutiliser le LUFS stereo deja mesure
      // et eviter un troisieme spawn ebur128 redondant.
      let stereoPromise = null;
      if (fileBuffer) {
        stereoPromise = (dspPromise || Promise.resolve(null))
          .then((dspMaster) =>
            dspMeasureStereoField(fileBuffer, dspMaster?.lufs ?? null)
          )
          .catch((err) => {
            console.error('[analyze] stereo error:', err.message);
            return null;
          });
      }

      const meta = { title, artist, daw, mode, version };
      jobs.set(jobId, {
        status: 'pending', stage: 'started',
        progress: 'Préparation de l\'écoute…', pct: 10,
        meta,
      });

      // ── STAGE 1: Gemini listening ──────────────
      let listening = null;
      if (fileBuffer) {
        try {
          listening = await analyzeListening(fileBuffer, fileMime, title || '', artist || '', mode, undefined, undefined, { userId });
          console.log('[analyze] listening done');
        } catch (err) {
          console.error('[analyze] listening error:', err.message);
          listening = null;
        }
      }
      const cur1 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur1,
        status: 'partial', stage: 'listening_done',
        progress: listening ? 'Écoute qualitative prête' : 'Écoute indisponible',
        pct: 55,
        listening: listening || null,
      });

      // ── STAGE PARALLÈLE: transcodage MP3 + upload Supabase ──
      // Lancé en parallèle du reste pour ne pas ajouter à la latence perçue.
      let storagePromise = null;
      if (fileBuffer && userId) {
        storagePromise = transcodeAndUpload({ fileBuffer, fileMime, userId })
          .then((path) => { console.log('[analyze] audio stored:', path); return path; })
          .catch((err) => { console.error('[analyze] storage error:', err.message); return null; });
      } else if (!userId) {
        console.warn('[analyze] no userId, skipping audio upload');
      }

      // ── STAGE 2: RAG PureMix context ───────────
      let pmChunks = [];
      if (listening) {
        try {
          pmChunks = await retrievePureMixContext(listening);
          console.log(`[analyze] rag: ${pmChunks.length} chunks retrieved`);
        } catch (err) {
          console.error('[analyze] rag error:', err.message);
          pmChunks = [];
        }
      }
      const pmContext = formatContextForPrompt(pmChunks);
      const cur15 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur15,
        stage: 'rag_done',
        progress: 'Contexte PureMix prêt',
        pct: 65,
      });

      // ── PHASE A FINALE : perception formulée (optionnelle, activee seulement si
      //    on ne saute pas l etape intention et qu on n a PAS recu d intention inline) ──
      const shouldAwaitIntent = !skipIntent && !inlineIntent;

      if (shouldAwaitIntent) {
        let perception = null;
        try {
          perception = await formulatePerception(listening);
          console.log('[analyze] perception formulée');
        } catch (err) {
          console.error('[analyze] perception error:', err.message);
          perception = null; // on passe quand meme en awaiting_intent, le front saura gérer
        }

        // Stocke dans le job tout ce dont la Phase B aura besoin
        const curA = jobs.get(jobId) || {};
        jobs.set(jobId, {
          ...curA,
          status: 'awaiting_intent', stage: 'awaiting_intent',
          progress: 'En attente de ton intention artistique…',
          pct: 70,
          perception: perception || null,
          // Contexte de reprise pour /diagnose/:jobId
          ctx: {
            mode, daw, title, artist, version,
            userId,
            durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
            locale,
            listening, pmContext, pmChunks, storagePromise, fadrPromise, dspPromise,
            stemsPromise, stereoPromise,
            declaredGenre, genreUnknown,
            uploadType,
            userBpm, // override Fadr si saisi par l artiste
            cacheAudioHash, cacheParamsSig, // cache fiche (migration 031)
            // Plumbés pour persistAnalysisResult (commit 9427693)
            projectId, vocalType, copyrightAcknowledgedAt,
            trackId: pluginTrack ? pluginTrack.id : null,
          },
        });
        return; // on ATTEND un POST /diagnose/:jobId pour reprendre
      }

      // ── PHASE B enchainee (skipIntent ou intention inline) ──
      await runDiagnosticPhase(jobId, {
        mode, daw, title, artist, version,
        userId,
        durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
        locale,
        listening, pmContext, pmChunks,
        storagePromise, fadrPromise, dspPromise, stemsPromise, stereoPromise,
        cacheAudioHash, cacheParamsSig, // cache fiche (migration 031)
        userBpm, // override Fadr si saisi par l artiste
        intent: inlineIntent, // null si skip
        declaredGenre, genreUnknown,
        uploadType,
        // Plumbés pour persistAnalysisResult (commit 9427693)
        projectId, vocalType, copyrightAcknowledgedAt,
        trackId: pluginTrack ? pluginTrack.id : null,
      });
    } catch (err) {
      console.error('[analyze] error:', err.message);
      const prev = jobs.get(jobId) || {};
      // Code stable côté front (cf. lib/jobErrors). err.message reste en console
      // pour le debug, mais n'est jamais exposé à l'utilisateur (anglais brut).
      jobs.set(jobId, { ...prev, status: 'error', error: classifyJobError(err) });
      await refundCreditIfDebited(jobId, err.message);
    }
  })();
});

// ─── POST /diagnose/:jobId — reprend un job en 'awaiting_intent' et execute la Phase B ───
// body: { intent: string|null }
// Si intent est vide/null, on lance le diagnostic en lecture neutre (equivalent skip).
router.post('/diagnose/:jobId', analyzeLimiter, express.json(), (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  if (job.status !== 'awaiting_intent' || !job.ctx) {
    return res.status(409).json({ error: 'job_not_in_awaiting_intent', status: job.status });
  }

  const intent = typeof req.body?.intent === 'string' && req.body.intent.trim().length > 0
    ? req.body.intent.trim()
    : null;

  // Marquage immediat pour que le front voie la transition
  jobs.set(jobId, {
    ...job,
    status: 'pending', stage: 'diagnosing',
    progress: 'Diagnostic calibré en cours…',
    pct: 80,
  });
  res.json({ ok: true, jobId, intent_used: intent });

  // Execution en tache de fond (comme /start)
  (async () => {
    try {
      await runDiagnosticPhase(jobId, { ...job.ctx, intent });
    } catch (err) {
      console.error('[diagnose] error:', err.message);
      jobs.set(jobId, { ...(jobs.get(jobId) || {}), status: 'error', error: classifyJobError(err) });
      await refundCreditIfDebited(jobId, err.message);
    }
  })();
});

// Execute Claude.generateFiche + attend le transcodage + marque le job complete.
// Utilise par /start (skipIntent) et par /diagnose/:jobId.
async function runDiagnosticPhase(jobId, ctx) {
  const {
    mode, daw, title, artist, version,
    userId,
    durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
    locale,
    listening, pmContext, pmChunks,
    storagePromise, fadrPromise, dspPromise, stemsPromise, stereoPromise,
    intent,
    declaredGenre, genreUnknown,
    uploadType,
    userBpm, // override Fadr si saisi par l artiste
    cacheAudioHash, cacheParamsSig, // cache fiche (migration 031)
    // ↓ Champs utilises par persistAnalysisResult — l oubli de ces 4 dans le
    // destructuring causait un ReferenceError lors de la construction des
    // options persist, qui propageait au catch externe et marquait le job
    // en `status:error` (cf. bug 2026-05-21, commit 9427693).
    projectId, vocalType, copyrightAcknowledgedAt,
    trackId, // plugin DAW : track lié explicite (bypass du match par titre)
  } = ctx;

  // ── ATTENTE Fadr + DSP en parallele (avec timeouts independants) ──
  // Les deux promesses sont independantes : Fadr (cloud, lent) et DSP maison
  // (ffmpeg local, rapide). On les attend en parallele pour ne pas serialiser.
  // Mode degrade : null si timeout/erreur, le pipeline continue.
  const awaitWithTimeout = (promise, ms, label) => {
    if (!promise) return Promise.resolve(null);
    let timeoutId = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        console.warn(`[analyze] ${label} timeout ${ms / 1000}s — pipeline continues without`);
        resolve(null);
      }, ms);
    });
    return Promise.race([promise, timeoutPromise]).then((v) => {
      if (timeoutId) clearTimeout(timeoutId);
      return v;
    });
  };

  const [fadrMetrics, dspMetrics, stemsMetrics, stereoMetrics] = await Promise.all([
    awaitWithTimeout(fadrPromise, FADR_TIMEOUT_MS, 'fadr'),
    awaitWithTimeout(dspPromise, DSP_TIMEOUT_MS, 'dsp'),
    awaitWithTimeout(stemsPromise, STEMS_TIMEOUT_MS, 'stems'),
    awaitWithTimeout(stereoPromise, STEREO_TIMEOUT_MS, 'stereo'),
  ]);

  // User BPM override : l artiste a renseigne le BPM dans la modale.
  // Prime sur la detection Fadr (qui se trompe souvent entre half-time
  // et double-time, 75 vs 150 etc.). Mutate fadrMetrics si dispo pour
  // que l override soit visible dans toutes les utilisations downstream.
  if (userBpm != null && fadrMetrics) {
    console.log(`[analyze] user BPM override : ${fadrMetrics.bpm} -> ${userBpm}`);
    fadrMetrics.bpm = userBpm;
  }

  // Arrondi BPM a 0.5 pres. Fadr renvoie souvent 3-4 decimales (ex: 79.213)
  // qui n ont aucune valeur perceptive et polluent l affichage et les
  // recettes. Helper : nombre le plus proche d un multiple de 0.5.
  if (fadrMetrics && typeof fadrMetrics.bpm !== 'undefined' && fadrMetrics.bpm != null) {
    const rawBpm = typeof fadrMetrics.bpm === 'string' ? parseFloat(fadrMetrics.bpm) : fadrMetrics.bpm;
    if (Number.isFinite(rawBpm)) {
      fadrMetrics.bpm = Math.round(rawBpm * 2) / 2;
    }
  }

  if (fadrMetrics || dspMetrics || stemsMetrics || stereoMetrics) {
    const cur = jobs.get(jobId) || {};
    jobs.set(jobId, { ...cur, stage: 'measures_done', progress: 'Mesures objectives prêtes', pct: Math.max(cur.pct || 0, 75) });
  }

  // ── STAGE 3: Claude fiche (listening + pmContext + intent + mesures) ──
  // On fusionne fadr (BPM, tonalite, stems list), dsp master (LUFS, LRA,
  // truePeak), stems mesures (LUFS+bandes par stem) et stereo (corr, M/S,
  // mono compat) dans un objet "metrics" passe a Claude. Le LUFS DSP a la
  // priorite sur le LUFS Fadr (qui est souvent null de toute facon).
  const hasAnyMeasure = !!(fadrMetrics || dspMetrics || stemsMetrics || stereoMetrics);
  const mergedMetrics = hasAnyMeasure ? {
    ...(fadrMetrics || {}),
    ...(dspMetrics ? {
      lufs: dspMetrics.lufs ?? (fadrMetrics?.lufs ?? null),
      lra: dspMetrics.lra ?? null,
      truePeak: dspMetrics.truePeak ?? null,
    } : {}),
    // Phase 3 (DSP_PLAN B.4) — ajout des mesures par stem et du champ stereo.
    // Null si la mesure correspondante a echoue (mode degrade).
    stemsMeasured: stemsMetrics || null, // [{stemType, lufs, truePeak, energyBand_5_8kHz, energyBand_1_3kHz, ...}]
    stereo: stereoMetrics || null,        // {correlation, midSideRatio, balanceLR, monoCompat}
  } : null;

  let fiche = null;
  try {
    fiche = await generateFiche(mode, daw, title || 'Titre inconnu', artist, listening, pmContext, previousFiche, intent || null, previousCompletions || null, mergedMetrics, declaredGenre || null, !!genreUnknown, uploadType || 'mix');
    if (fiche && durationSeconds) fiche.duration_seconds = durationSeconds;
    console.log('[analyze] claude done — keys:', Object.keys(fiche || {}).join(', '));
  } catch (err) {
    console.error('[analyze] claude error:', err.message);
  }

  // ── STAGE 4 (optionnel): Claude evolution (suivi inter-versions) ──
  // Ne se declenche que si on a une analyse precedente complete (fiche +
  // listening) ET une nouvelle fiche/listening. Sinon : pas d evolution,
  // pipeline strictement identique a avant.
  let evolution = null;
  const canCompare =
    fiche && listening &&
    previousAnalysisResult &&
    previousAnalysisResult.fiche &&
    previousAnalysisResult.listening;
  if (canCompare) {
    try {
      evolution = await generateEvolution(
        { fiche: previousAnalysisResult.fiche, listening: previousAnalysisResult.listening },
        { fiche, listening },
        intent || previousAnalysisResult.intent_used || null,
        locale || 'fr',
      );
      if (evolution) console.log('[analyze] evolution done — dominante:', evolution.dominante);
      else console.log('[analyze] evolution skipped (null result)');
    } catch (err) {
      console.error('[analyze] evolution error:', err.message);
      evolution = null;
    }
  }

  // Attend la fin du transcodage/upload (peut avoir fini depuis longtemps)
  const storagePath = storagePromise ? await storagePromise : null;

  // ── PERSISTANCE BACKEND (fix architectural 2026-05-21) ────────────
  // Insère directement tracks/versions via service_role AVANT de marquer
  // le job `complete`. Comme ça, dès que le client voit complete, il a
  // aussi `persistedTrackId` et `persistedVersionId` dans la réponse →
  // plus jamais de crédit perdu sur tab fermée. Si la persist échoue, on
  // log mais on ne casse pas le job (le front retombe sur saveAnalysis
  // comme avant pour ne pas régresser).
  let persistResult = { ok: false, error: null };
  if (userId && fiche) {
    persistResult = await persistAnalysisResult({
      userId,
      title: title || 'Titre inconnu',
      versionName: version || 'v1',
      projectId,
      trackId: trackId || null, // plugin DAW : bypass find-or-create par titre
      vocalType,
      fiche,
      listening,
      evolution,
      intent_used: intent || null,
      fadrMetrics,
      dspMetrics,
      stemsMetrics,
      stereoMetrics,
      storagePath,
      audioHash: cacheAudioHash || null,
      locale,
      uploadType,
      copyrightAcknowledgedAt,
    });
    if (!persistResult.ok) {
      console.warn('[analyze] persistAnalysisResult failed:', persistResult.error);
    }
  } else {
    persistResult = { ok: false, error: userId ? 'no_fiche' : 'no_user_id' };
  }

  const cur = jobs.get(jobId) || {};
  jobs.set(jobId, {
    ...cur,
    status: 'complete', stage: 'all_done',
    progress: 'Terminé', pct: 100,
    fiche: fiche || null,
    listening: listening || null,
    evolution: evolution || null,
    storagePath: storagePath || null,
    intent_used: intent || null, // utile pour le front
    fadrMetrics: fadrMetrics || null, // BPM, tonalite, stems — null si Fadr KO
    dspMetrics: dspMetrics || null,   // LUFS, LRA, truePeak — null si ffmpeg KO
    // Phase 3 (DSP_PLAN B.4) — mesures par stem et champ stereo.
    stemsMetrics: stemsMetrics || null, // [{stemType, lufs, truePeak, energyBand_*, ...}] ou null
    stereoMetrics: stereoMetrics || null, // {correlation, midSideRatio, balanceLR, monoCompat} ou null
    // Persistance backend (cf. lib/persistAnalysis.js) — si ok, le front
    // peut sauter saveAnalysis et lire ces IDs directement. Si ko, le front
    // retombe sur saveAnalysis comme historiquement (compat).
    persistedTrackId: persistResult.ok ? persistResult.trackId : null,
    persistedVersionId: persistResult.ok ? persistResult.versionId : null,
    persistError: persistResult.ok ? null : (persistResult.error || 'unknown'),
    pmSources: (pmChunks || []).map(c => ({
      source_file: c.source_file,
      category: c.category,
      similarity: c.similarity,
    })),
    ctx: undefined, // on purge pour eviter de garder le listening en memoire plus longtemps
  });
  console.log('[analyze] done');

  // ── CACHE FICHE FILL (migration 031) ──────────────────────────────
  // Pipeline classique reussi : on alimente le cache pour les futurs
  // uploads du meme fichier avec les memes parametres. Fire-and-forget
  // (les erreurs DB ne doivent pas affecter la reponse au client).
  // On ne cache QUE si on a une fiche valide — pas la peine de cacher
  // un mode degrade (fiche null, Claude KO).
  if (fiche && cacheAudioHash && cacheParamsSig) {
    saveAnalysisCache(
      cacheAudioHash,
      cacheParamsSig,
      {
        fiche,
        listening: listening || null,
        fadrMetrics: fadrMetrics || null,
        dspMetrics: dspMetrics || null,
        stemsMetrics: stemsMetrics || null,
        stereoMetrics: stereoMetrics || null,
      },
      userId || null,
    );
  }

  // ── COST TRACKING (analysis_cost_logs) ──
  // Insère la ligne de coût de cette analyse dans Supabase.
  // Lit les accumulators de tokens captés pendant le pipeline (gemini + claude)
  // et y ajoute les forfaits Fadr/infra (cf. lib/costTracker.js).
  // Try/catch isolé : une erreur DB ne doit JAMAIS casser une analyse réussie.
  try {
    await logAnalysisCost({
      userId: userId || null,
      jobId,
      audioDurationSec: durationSeconds || null,
      geminiUsage: geminiLib.getUsage(),
      claudeUsage: claudeLib.getUsage(),
      fadrCalled: !!fadrMetrics,
    });
  } catch (err) {
    console.error('[analyze] cost tracking error (non-fatal):', err.message);
  }
}

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  // On ne renvoie PAS `ctx` au front (trop lourd, contient listening + pmContext).
  const { ctx, ...publicJob } = job;
  res.json(publicJob);
  if (job.status === 'complete' || job.status === 'error') {
    setTimeout(() => jobs.delete(req.params.jobId), 60000);
  }
});


module.exports = router;
