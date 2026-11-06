/**
 * jobErrors.js — classification des erreurs d'analyse en codes stables.
 *
 * Pourquoi : avant ce helper, les catch dans _analyze.js stockaient `err.message`
 * brut dans le champ `job.error` (ex. "Storage download failed: ...", "Fadr upload2: 503",
 * "Analysis API: timeout (120s)"). Le front poll /status, lit ce champ, et affiche
 * tel quel à l'utilisateur — qui voit donc des messages techniques en anglais.
 *
 * On classifie maintenant l'erreur en CODE stable (snake_case, anglais comme nos
 * autres codes HTTP : `unauthorized`, `no_credits`, etc.) et c'est le front qui
 * mappe ce code vers une string FR/EN i18n via translateBackendError().
 *
 * Le `err.message` brut continue d'être loggé en console côté backend pour le
 * debug, il n'est juste plus exposé à l'utilisateur.
 */

/**
 * Classifie une erreur catch dans le pipeline d'analyse en code stable.
 * @param {Error|string|null|undefined} err
 * @returns {string} Un code i18n-safe que le front saura traduire.
 */
function classifyJobError(err) {
  const msg = (err?.message || err || '').toString().toLowerCase();

  if (!msg) return 'analysis_failed';

  // Écoute Gemini KO après relance (étape bloquante depuis 2026-11-06) :
  // code dédié pour que le front puisse dire "écoute indisponible" plutôt
  // qu'un générique "service externe". Testé AVANT les autres règles parce
  // que le message sous-jacent peut contenir "timeout" ou "file api".
  if (msg.includes('listening_unavailable')) {
    return 'analysis_listening_unavailable';
  }

  // Timeouts (perception 30s, claude 120s, abort signaux)
  if (msg.includes('timeout') || msg.includes('aborterror')) {
    return 'analysis_timeout';
  }

  // Erreurs réseau Fadr / Gemini / Anthropic — toutes regroupées en "service externe KO"
  if (
    msg.includes('fadr') ||
    msg.includes('file api') ||
    msg.includes('perception api') ||
    msg.includes('analysis api')
  ) {
    return 'analysis_service_unavailable';
  }

  // Erreurs Supabase Storage (download/upload du fichier audio)
  if (msg.includes('storage') || msg.includes('supabase upload')) {
    return 'analysis_storage_failed';
  }

  // Parsing JSON Claude/Gemini cassé
  if (msg.includes('json invalide') || msg.includes('no json')) {
    return 'analysis_parse_failed';
  }

  // storagePath_invalid / storagePath_forbidden — codes déjà propres, on les garde
  if (msg === 'storagepath_invalid' || msg === 'storagepath_forbidden') {
    return 'analysis_storage_failed';
  }

  // Défaut : on n'expose pas le détail technique
  return 'analysis_failed';
}

module.exports = { classifyJobError };
