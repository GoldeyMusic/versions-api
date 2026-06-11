/**
 * lib/persistAnalysis.js — persistance backend des fiches d'analyse.
 *
 * Contexte (2026-05-21) : historiquement la fiche était insérée
 * EXCLUSIVEMENT côté client par src/lib/storage.js::saveAnalysis(). Si
 * l'utilisateur fermait sa tab pendant l'analyse, le crédit était débité
 * mais aucune ligne tracks/versions n'était créée → crédit perdu sans
 * livrable. 4 cas observés en 6 jours (2026-05-15 → 2026-05-21).
 *
 * Trois paliers de protection ont été ajoutés côté front + cron Supabase
 * (cf. memory project_versions_credit_persistence_bug), mais le seul
 * vrai remède est de persister côté serveur — c'est ce que fait ce
 * helper. Quand le pipeline arrive en `complete`, on insère directement
 * dans tracks/versions via service_role. Le crédit n'est jamais perdu,
 * peu importe l'état du client.
 *
 * Réplique fidèlement la logique de src/lib/storage.js::saveAnalysis()
 * pour rester en cohérence : mêmes colonnes, même résolution de projet
 * par défaut, même gestion track-déjà-existant (par titre case-insensitive
 * sur le même project_id), même upsert version (par name).
 */

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — persistAnalysis unavailable');
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

/** Format de date FR utilisé partout côté front. Réplique de storage.js. */
function formatDate(d = new Date()) {
  const months = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Résout un projectId par défaut pour cet utilisateur :
 * - premier projet existant (ordre position ASC, created_at ASC)
 * - sinon en crée un "Mon premier projet"
 * Renvoie null si la création échoue (RLS, etc.).
 */
async function getOrCreateDefaultProjectId(userId) {
  const sb = getSupabase();
  const { data: existing } = await sb
    .from('projects')
    .select('id')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);
  if (existing?.[0]) return existing[0].id;

  const { data: created, error } = await sb
    .from('projects')
    .insert({ user_id: userId, name: 'Mon premier projet', cover_gradient: 0, position: 0 })
    .select('id')
    .single();
  if (error) {
    console.warn('[persistAnalysis] getOrCreateDefaultProjectId error:', error.message);
    return null;
  }
  return created.id;
}

/**
 * Persiste une analyse complète côté serveur.
 *
 * Args (tous nommés via options) :
 *   userId               : uuid (obligatoire)
 *   title                : string (obligatoire)
 *   versionName          : string (ex: 'v1', 'mix3')
 *   trackId              : uuid optionnel (plugin DAW : track lié explicite —
 *                          bypass le find-or-create par titre, qui peut se
 *                          tromper si deux tracks du projet portent le même nom)
 *   projectId            : uuid optionnel (sinon résolu via défaut)
 *   vocalType            : 'vocal' | 'instrumental_pending' | 'instrumental_final'
 *   fiche, listening, evolution, intent_used
 *   fadrMetrics, dspMetrics, stemsMetrics, stereoMetrics
 *   storagePath          : chemin Supabase Storage de l'audio
 *   audioHash            : hash SHA fichier (pour dedup)
 *   locale               : 'fr' | 'en' (analysis_locale)
 *   uploadType           : 'mix' | 'master'
 *   copyrightAcknowledgedAt : timestamp ISO (optionnel)
 *
 * Renvoie { ok: true, trackId, versionId } ou { ok: false, error: '...' }.
 * NE THROW JAMAIS — toute erreur est capturée et retournée, pour ne pas
 * casser le pipeline d'analyse si la persistance foire.
 */
async function persistAnalysisResult(opts) {
  try {
    const {
      userId, title, versionName, projectId: explicitProjectId,
      trackId: explicitTrackId,
      vocalType,
      fiche, listening, evolution, intent_used,
      fadrMetrics, dspMetrics, stemsMetrics, stereoMetrics,
      storagePath, audioHash, locale, uploadType,
      copyrightAcknowledgedAt,
    } = opts || {};

    if (!userId) return { ok: false, error: 'userId required' };
    const cleanTitle = String(title || '').trim() || 'Sans titre';
    const cleanVersionName = String(versionName || 'v1').trim();

    const sb = getSupabase();

    // ── 0) Track explicite (plugin DAW) ─────────────────────────────
    // Si l'appelant connaît déjà le track (lien plugin ↔ titre), on le
    // charge directement (vérifié par user_id) et on saute la résolution
    // projet + le find-or-create par titre.
    if (explicitTrackId) {
      const { data: directTrack, error: directErr } = await sb
        .from('tracks')
        .select('id, title, vocal_type')
        .eq('id', explicitTrackId)
        .eq('user_id', userId)
        .maybeSingle();
      if (directErr || !directTrack) {
        return { ok: false, error: `explicit_track_not_found: ${directErr?.message || explicitTrackId}` };
      }
      return persistVersionForTrack(sb, directTrack, opts);
    }

    // ── 1) Résolution du projet ─────────────────────────────────────
    let projectId = explicitProjectId || null;
    if (!projectId) {
      projectId = await getOrCreateDefaultProjectId(userId);
    }
    if (!projectId) {
      return { ok: false, error: 'project_resolution_failed' };
    }

    // ── 2) Find or create track ─────────────────────────────────────
    const { data: existingTracks } = await sb
      .from('tracks')
      .select('id, title, vocal_type')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .ilike('title', cleanTitle);

    let track = (existingTracks || []).find(t => t.title.toLowerCase() === cleanTitle.toLowerCase());

    if (!track) {
      const { data: last } = await sb
        .from('tracks')
        .select('position_in_project')
        .eq('project_id', projectId)
        .order('position_in_project', { ascending: false })
        .limit(1);
      const nextPos = (last?.[0]?.position_in_project ?? -1) + 1;

      const allowedVocalTypes = ['vocal', 'instrumental_pending', 'instrumental_final'];
      const vt = allowedVocalTypes.includes(vocalType) ? vocalType : 'vocal';

      const { data: newTrack, error: insertErr } = await sb
        .from('tracks')
        .insert({
          user_id: userId,
          title: cleanTitle,
          project_id: projectId,
          position_in_project: nextPos,
          vocal_type: vt,
        })
        .select('id, title, vocal_type')
        .single();
      if (insertErr) {
        return { ok: false, error: `track_insert_failed: ${insertErr.message}` };
      }
      track = newTrack;
    }

    return persistVersionForTrack(sb, track, opts);
  } catch (err) {
    console.error('[persistAnalysis] unexpected error:', err?.message || err);
    return { ok: false, error: `unexpected: ${err?.message || 'unknown'}` };
  }
}

/**
 * Étapes 3-6 (upsert de la version sous un track résolu). Partagé entre le
 * chemin historique (find-or-create par titre) et le chemin trackId explicite
 * du plugin DAW. NE THROW JAMAIS (même contrat que persistAnalysisResult).
 */
async function persistVersionForTrack(sb, track, opts) {
  try {
    const {
      userId, versionName,
      fiche, listening, evolution, intent_used,
      fadrMetrics, dspMetrics, stemsMetrics, stereoMetrics,
      storagePath, audioHash, locale, uploadType,
      copyrightAcknowledgedAt,
    } = opts || {};
    const cleanTitle = track.title;
    const cleanVersionName = String(versionName || 'v1').trim();

    // ── 3) Cherche une version existante du même nom ────────────────
    const { data: existingVersions } = await sb
      .from('versions')
      .select('id, name, is_main')
      .eq('track_id', track.id);

    const existing = (existingVersions || []).find(v => v.name.toLowerCase() === cleanVersionName.toLowerCase());

    // La nouvelle version devient toujours `is_main`. On reset les autres.
    await sb.from('versions').update({ is_main: false }).eq('track_id', track.id);

    // ── 4) Construit l'analysisResult agrégé (compatibilité front) ─
    // Le front s'attend à un objet `analysis_result` qui contient
    // fiche/listening/evolution/intent_used/fadr/dsp/stems/stereo etc.
    // — c'est ce que saveAnalysis client persiste actuellement.
    const analysisResult = {
      fiche: fiche || null,
      listening: listening || null,
      evolution: evolution || null,
      intent_used: intent_used || null,
      fadrMetrics: fadrMetrics || null,
      dspMetrics: dspMetrics || null,
      stemsMetrics: stemsMetrics || null,
      stereoMetrics: stereoMetrics || null,
      storagePath: storagePath || null,
      audioHash: audioHash || null,
    };

    // ── 5) Champs métriques individuels (filtrage par badge topbar) ─
    const fm = fadrMetrics || {};
    const dm = dspMetrics || {};
    const fadrBpm = (fm.bpm != null && fm.bpm !== '') ? String(fm.bpm) : null;
    const fadrKey = (typeof fm.key === 'string' && fm.key.trim()) ? fm.key.trim() : null;
    let lufsValue = null;
    if (typeof dm.lufs === 'number' && Number.isFinite(dm.lufs)) lufsValue = dm.lufs.toFixed(1);
    else if (typeof fm.lufs === 'number' && Number.isFinite(fm.lufs)) lufsValue = fm.lufs.toFixed(1);
    else if (typeof fm.lufs === 'string' && fm.lufs.trim()) lufsValue = fm.lufs.trim();

    const dspPatch = {
      ...(fadrBpm ? { bpm: fadrBpm } : {}),
      ...(fadrKey ? { key: fadrKey } : {}),
      ...(lufsValue ? { lufs: lufsValue } : {}),
    };
    if (Array.isArray(stemsMetrics) && stemsMetrics.length > 0) {
      dspPatch.dsp_stems = stemsMetrics;
    }
    if (stereoMetrics && typeof stereoMetrics === 'object') {
      dspPatch.dsp_stereo = stereoMetrics;
    }

    // Genre — source de vérité = fiche (lib/claude.js force la cohérence)
    if (fiche) {
      if (typeof fiche.declared_genre === 'string' && fiche.declared_genre.trim()) {
        dspPatch.declared_genre = fiche.declared_genre.trim();
      } else if (fiche.declared_genre === null) {
        dspPatch.declared_genre = null;
      }
      if (typeof fiche.genre_inferred_by_ai === 'boolean') {
        dspPatch.genre_inferred_by_ai = fiche.genre_inferred_by_ai;
      }
      if (typeof fiche.inferred_genre === 'string' && fiche.inferred_genre.trim()) {
        dspPatch.inferred_genre = fiche.inferred_genre.trim();
      } else if (fiche.inferred_genre === null) {
        dspPatch.inferred_genre = null;
      }
    }

    const cleanLocale = (locale || 'fr').toString().toLowerCase().slice(0, 2);
    const cleanUploadType = (uploadType === 'master' || uploadType === 'mix') ? uploadType : 'mix';

    // ── 6) Insert ou update la version ──────────────────────────────
    let versionId = null;

    if (existing) {
      const updatePayload = {
        date: formatDate(),
        is_main: true,
        analysis_result: analysisResult,
        analysis_locale: cleanLocale,
        analysis_translations: {},
        audio_hash: audioHash || null,
        upload_type: cleanUploadType,
        ...(copyrightAcknowledgedAt ? { copyright_acknowledged_at: copyrightAcknowledgedAt } : {}),
        ...dspPatch,
      };
      if (storagePath) updatePayload.storage_path = storagePath;
      const { error } = await sb
        .from('versions')
        .update(updatePayload)
        .eq('id', existing.id);
      if (error) {
        return { ok: false, error: `version_update_failed: ${error.message}` };
      }
      versionId = existing.id;
    } else {
      const { data: newVer, error } = await sb
        .from('versions')
        .insert({
          track_id: track.id,
          name: cleanVersionName,
          date: formatDate(),
          is_main: true,
          analysis_result: analysisResult,
          analysis_locale: cleanLocale,
          audio_hash: audioHash || null,
          storage_path: storagePath || null,
          upload_type: cleanUploadType,
          ...(copyrightAcknowledgedAt ? { copyright_acknowledged_at: copyrightAcknowledgedAt } : {}),
          ...dspPatch,
        })
        .select('id')
        .single();
      if (error) {
        return { ok: false, error: `version_insert_failed: ${error.message}` };
      }
      versionId = newVer.id;
    }

    console.log(`[persistAnalysis] ok user=${userId} track=${track.id} version=${versionId} (${cleanTitle} / ${cleanVersionName})`);
    return { ok: true, trackId: track.id, versionId };
  } catch (err) {
    console.error('[persistAnalysis] unexpected error:', err?.message || err);
    return { ok: false, error: `unexpected: ${err?.message || 'unknown'}` };
  }
}

module.exports = { persistAnalysisResult };
