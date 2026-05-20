// ─────────────────────────────────────────────────────────────
// mechanicalCaps — plafonnement deterministe du globalScore.
//
// Applique des "caps" sur le globalScore quand un defaut DSP mesurable
// est detecte, en post-traitement de l'analyse Claude. C'est l'arme
// principale contre le scoring lineaire qui dilue les red flags graves
// dans la moyenne ponderee.
//
// PHILOSOPHIE :
// - Les items et item.score restent intacts (le LLM a fait son boulot
//   sur le diagnostic par element). On ne touche QUE le globalScore.
// - Si plusieurs caps se declenchent, on prend le MIN (le plus severe).
// - Le rapport _caps_applied est ajoute au payload pour pedagogie cote
//   fiche : on peut afficher "score plafonne par : <reason>".
//
// LIMITES :
// - Si une mesure n'est pas disponible (stems KO, stereo absent),
//   le cap correspondant n'est simplement pas evalue — pas d'erreur.
// - Les caps "mix-only" sont desactives en mode master (un master a
//   logiquement une dynamique resserree, un True Peak controle par le
//   mastering engineer, etc. — penaliser ce serait un faux positif).
//
// SOURCE DE VERITE :
// - docs/roadmap_post_aubiomix_2026-05-19.md (Bloc A.2)
// - Benchmark 9 titres 2026-05-20 (3 demos, 3 pros, 3 hits)
//   qui a permis de calibrer les seuils sans faux positifs sur les pros.
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} fiche — fiche normalisee (post normalizeIds)
 * @param {object} signals — signaux DSP disponibles
 *   { mCorr, mLra, mTruePeak, voiceVsInstruDelta, sibilantsBand, presenceBand }
 * @param {string} uploadType — 'mix' | 'master'
 * @returns {{ fiche: object, capsApplied: Array }}
 */
function applyMechanicalCaps(fiche, signals = {}, uploadType = 'master') {
  if (!fiche || typeof fiche !== 'object') return { fiche, capsApplied: [] };

  const caps = [];
  const {
    mCorr,
    mLra,
    mTruePeak,
    voiceVsInstruDelta,
    sibilantsBand,
    presenceBand,
  } = signals;
  const isMix = uploadType === 'mix';

  // ─── Cap 1 : stereo quasi-mono ──────────────────────────────
  // Corr L/R > 0.95 → mix tellement centre que le signal est presque
  // mono. Faute structurelle independante du contexte mix/master.
  if (typeof mCorr === 'number' && mCorr > 0.95) {
    caps.push({
      key: 'mono_like_stereo',
      cap: 75,
      signal: `correlation L/R ${mCorr}`,
      reason:
        'Image stereo quasi-mono : correlation L/R au-dessus de 0.95, peu de differenciation entre les canaux.',
    });
  }

  // ─── Cap 2 : LRA tres serre (mix uniquement) ────────────────
  // LRA < 2.5 LU sur un mix non masterise = sur-compression bus master
  // appliquee avant l'envoi mastering. Sur un master, LRA bas est
  // standard pour le streaming → cap inactif en mode master.
  if (isMix && typeof mLra === 'number' && mLra < 2.5) {
    caps.push({
      key: 'lra_squashed_mix',
      cap: 70,
      signal: `LRA ${mLra} LU`,
      reason:
        'Dynamique tres ecrasee sur un mix non masterise : LRA sous 2.5 LU laisse peu de place au mastering pour respirer.',
    });
  }

  // ─── Cap 3 : clipping (mix uniquement) ──────────────────────
  // True Peak > 0 dBTP sur un mix non masterise = samples ecretes
  // ou intersample clipping. Sur un master c'est un choix discutable
  // mais frequent, et le LLM le sanctionne deja en MED → pas de cap.
  if (isMix && typeof mTruePeak === 'number' && mTruePeak > 0) {
    caps.push({
      key: 'clipping_mix',
      cap: 70,
      signal: `True Peak ${mTruePeak} dBTP`,
      reason:
        'Clipping detecte sur un mix non masterise : True Peak au-dessus de 0 dBFS, samples ecretes ou risque d intersample clipping a l encodage.',
    });
  }

  // ─── Cap 4 : voix masquee par instru ────────────────────────
  // Delta voix/instru < -3 LU = voix en retrait, sous le seuil que
  // le pipeline DSP signale deja comme "voix a remonter". Au-dessus
  // de -3 LU la voix est dans la cible -3/+3, pas de cap.
  if (typeof voiceVsInstruDelta === 'number' && voiceVsInstruDelta < -3) {
    caps.push({
      key: 'voice_masked',
      cap: 75,
      signal: `delta voix/instru ${voiceVsInstruDelta} LU`,
      reason:
        'Voix lead en retrait par rapport a l instrumentation : delta voix/instru sous -3 LU, l intelligibilite est compromise.',
    });
  }

  // ─── Cap 5 : sibilantes excessives sur stem vocal ──────────
  // Mesure preferee : ratio energie 5-8 kHz vs 1-3 kHz sur le stem
  // vocal isole. Si la bande sibilantes (5-8 kHz) est a moins de
  // 3 dB sous la bande presence (1-3 kHz), les sibilantes dominent.
  // Fallback sur seuil absolu si la bande presence n'est pas mesuree.
  if (typeof sibilantsBand === 'number' && typeof presenceBand === 'number') {
    const ratio = +(sibilantsBand - presenceBand).toFixed(1);
    if (ratio > -3) {
      caps.push({
        key: 'sibilants_excessive',
        cap: 80,
        signal: `ratio 5-8kHz / 1-3kHz ${ratio} dB sur stem vocal`,
        reason:
          "Sibilantes excessives : sur le stem vocal isole, la bande 5-8 kHz est a moins de 3 dB sous la bande de presence 1-3 kHz, les 's' dominent l'intelligibilite.",
      });
    }
  } else if (typeof sibilantsBand === 'number' && sibilantsBand > -22) {
    caps.push({
      key: 'sibilants_excessive',
      cap: 80,
      signal: `5-8 kHz ${sibilantsBand} dB sur stem vocal`,
      reason:
        'Sibilantes excessives : energie au-dessus de -22 dB sur la bande 5-8 kHz du stem vocal.',
    });
  }

  if (caps.length === 0) {
    return { fiche, capsApplied: [] };
  }

  // Cap effectif = le plus severe parmi ceux declenches.
  const sorted = caps.slice().sort((a, b) => a.cap - b.cap);
  const activeCap = sorted[0].cap;
  const rawGlobal = typeof fiche.globalScore === 'number' ? fiche.globalScore : null;

  if (rawGlobal != null && rawGlobal > activeCap) {
    fiche.globalScore = activeCap;
    fiche._caps_applied = {
      raw: rawGlobal,
      cap: activeCap,
      caps: sorted,
    };
    console.log(
      '[mechanicalCaps] applied — raw:',
      rawGlobal,
      '-> cap:',
      activeCap,
      'reasons:',
      sorted.map((c) => c.key).join(', ')
    );
  } else {
    // Caps declenches mais globalScore deja sous le cap → on expose
    // quand meme la liste pour pedagogie cote fiche.
    fiche._caps_applied = {
      raw: rawGlobal,
      cap: activeCap,
      caps: sorted,
      applied: false,
    };
  }

  return { fiche, capsApplied: sorted };
}

module.exports = { applyMechanicalCaps };
