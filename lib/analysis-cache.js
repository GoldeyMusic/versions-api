// ─────────────────────────────────────────────────────────────
// Cache de la fiche complète (migration 031).
//
// Stocke la réponse complète du pipeline d'analyse (fiche Claude + écoute
// Gemini + mesures DSP/Fadr/stems/stereo) keyée sur :
//   - audio_hash : SHA-256 hex du fichier audio
//   - params_signature : SHA-256 court d'un JSON ordonné contenant les
//     paramètres user-spécifiques qui affectent légitimement le diagnostic
//     (intent, genre déclaré, type d'upload mix/master).
//
// Pourquoi ce cache : Anthropic Claude n'est pas strictement déterministe
// même à temperature 0. Sans cache fiche, deux uploads d'un même fichier
// avec les mêmes paramètres peuvent produire des diagnostics qui oscillent
// sur les cas borderline. Avec cache, on garantit la reproductibilité.
// Bonus : économise les appels Claude pour tous les uploads ultérieurs.
//
// Pseudonymisation / RGPD : voir migration 031 (le contributed_by_user_id
// sert uniquement à la purge cascade à la suppression de compte).
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

let _cacheClient = null;
function getCacheClient() {
  if (_cacheClient) return _cacheClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[analysis-cache] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — cache disabled');
    return null;
  }
  _cacheClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _cacheClient;
}

// SHA-256 hex du fileBuffer — même algo que côté front (Web Crypto subtle.digest).
function computeAudioHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Signature stable des paramètres user-spécifiques qui affectent le diagnostic.
// Modulaire : on peut ajouter d'autres champs ici sans toucher au schéma DB
// (toute évolution des params déclenche un cache miss, ce qui est OK : on
// régénère et on cache la nouvelle combinaison).
const FICHE_PROMPT_VERSION = 3;

function computeParamsSignature({ intent, declaredGenre, uploadType, userBpm }) {
  // Normalisation : trim, lowercase. Les paramètres absents deviennent ''
  // pour avoir une clé stable (deux uploads sans intent partagent le cache).
  // userBpm participe à la clé : deux uploads du même fichier avec des BPM
  // différents (override artiste) doivent produire des fiches différentes
  // (les recettes time-based dependent du BPM).
  const normalized = {
    // v : version du prompt fiche. A incrementer a chaque changement de
    // prompt/scoring qui modifie le diagnostic, sinon le cache resert les
    // anciennes fiches pour un meme fichier + memes parametres.
    // v2 (2026-11-04) : items "artistic" + plancher artistique.
    // v3 (2026-11-04) : persistance relachee sur les seuls items artistic.
    v: FICHE_PROMPT_VERSION,
    intent: (intent || '').trim(),
    genre: (declaredGenre || '').trim().toLowerCase(),
    uploadType: (uploadType || 'mix').trim().toLowerCase(),
    userBpm: (userBpm != null && Number.isFinite(userBpm)) ? String(userBpm) : '',
  };
  const ordered = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(ordered).digest('hex').slice(0, 32);
}

// Lookup dans le cache. Retourne le cached_result si hit, null sinon.
async function lookupAnalysisCache(audioHash, paramsSignature) {
  const client = getCacheClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('analysis_cache')
      .select('cached_result')
      .eq('audio_hash', audioHash)
      .eq('params_signature', paramsSignature)
      .maybeSingle();
    if (error) {
      console.warn('[analysis-cache] lookup error:', error.message);
      return null;
    }
    return data?.cached_result || null;
  } catch (err) {
    console.warn('[analysis-cache] lookup exception:', err.message);
    return null;
  }
}

// Insert fire-and-forget. Si l'entrée existe déjà (duplicate key), c'est
// pas grave, on log au niveau debug.
function saveAnalysisCache(audioHash, paramsSignature, cachedResult, userId) {
  const client = getCacheClient();
  if (!client) return;
  client
    .from('analysis_cache')
    .insert({
      audio_hash: audioHash,
      params_signature: paramsSignature,
      cached_result: cachedResult,
      contributed_by_user_id: userId || null,
    })
    .then(({ error }) => {
      if (error && !/duplicate key/i.test(error.message)) {
        console.warn('[analysis-cache] insert failed:', error.message);
      }
    })
    .catch((err) => console.warn('[analysis-cache] insert exception:', err.message));
}

module.exports = {
  computeAudioHash,
  computeParamsSignature,
  lookupAnalysisCache,
  saveAnalysisCache,
};
