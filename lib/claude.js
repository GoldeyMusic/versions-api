const fetch = require('node-fetch');
const { applyMechanicalCaps } = require('./scoring/mechanicalCaps');
const MODEL = 'claude-sonnet-4-6';

// ─────────────────────────────────────────────────────────────
// Usage accumulator (cost tracking, ticket #DASHBOARD-ADMIN).
//
// Accumule les `usage` de chaque appel Anthropic (formulatePerception,
// generateFiche, generateEvolution, chat) sur la durée d'une analyse.
// resetUsage() au début / getUsage() à la fin (cf. api/analyze.js).
// ─────────────────────────────────────────────────────────────
let _usage = { input_tokens: 0, output_tokens: 0, calls: 0, model: MODEL };

function resetUsage() {
  _usage = { input_tokens: 0, output_tokens: 0, calls: 0, model: MODEL };
}

function getUsage() {
  return { ..._usage };
}

function _recordUsage(usage, fnLabel) {
  if (!usage) return;
  _usage.input_tokens += Number(usage.input_tokens || 0);
  _usage.output_tokens += Number(usage.output_tokens || 0);
  _usage.calls += 1;
  // model est constant (MODEL), pas besoin de le re-set, mais utile en debug
}

// Garde-fou post-parse : genere les ids manquants, normalise les scores /100,
// et calcule un globalScore /100 pondere si absent.
//
// uploadType (refonte 2026-04-30) : pilote la ponderation de la section
// "Master & Loudness".
//   - 'master' : comportement historique, le master pese 2 (parite avec voix).
//   - 'mix'    : le master ne pese que 0.5. L artiste a explicitement declare
//                qu il envoie un mix non-masterise — le diagnostic master/
//                loudness reste informatif (head-room, dynamique) mais ne doit
//                pas plomber le score global, sinon on penalise un mix qui
//                n est pas suppose etre a sa loudness finale.
function normalizeIds(fiche, uploadType = 'master') {
  if (!fiche || !Array.isArray(fiche.elements)) return fiche;
  const masterWeight = uploadType === 'mix' ? 0.5 : 2;
  // Ponderation par categorie (voix et master pesent plus, drums moins).
  // 'lufs' est l icon de la section MASTER & LOUDNESS — son poids varie
  // selon uploadType. Tous les autres restent constants.
  const WEIGHTS = {
    voice: 2,
    lufs: masterWeight,
    bass: 1.5,
    synths: 1,
    fx: 1,
    drums: 0.8,
  };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const el of fiche.elements) {
    if (!Array.isArray(el.items)) continue;
    const prefix = (el.icon || el.cat || 'item').toString().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'item';
    const w = WEIGHTS[prefix] ?? 1;
    let n = 1;
    for (const it of el.items) {
      if (!it || typeof it !== 'object') continue;
      if (!it.id || typeof it.id !== 'string') it.id = `${prefix}-${n}`;
      if (typeof it.score === 'number' && !Number.isNaN(it.score)) {
        it.score = Math.max(0, Math.min(100, Math.round(it.score)));
        weightedSum += it.score * w;
        totalWeight += w;
      }
      n++;
    }
  }
  // globalScore /100 — recalcule si absent ou hors limites.
  // Les scores items sont desormais /100, donc moyenne ponderee directe (plus de *10).
  if (typeof fiche.globalScore !== 'number' || fiche.globalScore < 0 || fiche.globalScore > 100) {
    fiche.globalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
  } else {
    fiche.globalScore = Math.max(0, Math.min(100, Math.round(fiche.globalScore)));
  }
  return fiche;
}

// ─────────────────────────────────────────────────────────────
// Score floor protection (ticket 4.1).
//
// Quand on revise un mix, le globalScore ne peut pas perdre plus de 3 points
// par rapport a la version precedente, et chaque categorie (sub-score) ne
// peut pas perdre plus de 5 points sur sa moyenne. Si la nouvelle moyenne
// d une categorie tombe sous le plancher, on releve uniformement les
// item.score de la categorie pour ramener la moyenne au plancher (le front
// recalcule la moyenne a partir des items, donc cette correction suffit).
//
// Reponse directe au cas "j ai ameliore et le score baisse" — l ecart V_n
// vs V_(n-1) reste lisible mais on lisse les regressions courtes pour ne pas
// demoraliser l artiste qui itere.
//
// TODO : "sauf degradation prouvee par DSP" (cf. spec ticket 4.1). Quand on
// aura une detection DSP de regression (LUFS hors cible, clipping apparu,
// crest factor effondre, etc.), elle desactivera localement le plancher.
// Tant que ce n est pas branche, le plancher s applique inconditionnellement.
// ─────────────────────────────────────────────────────────────
function applyScoreFloor(fiche, previousFiche) {
  if (!fiche || !previousFiche) return fiche;

  const applied = {};

  // Plancher global — max -3 points.
  const prevG = typeof previousFiche.globalScore === 'number' ? previousFiche.globalScore : null;
  if (prevG != null && typeof fiche.globalScore === 'number') {
    const floor = Math.max(0, prevG - 3);
    if (fiche.globalScore < floor) {
      applied.global = { prev: prevG, raw: fiche.globalScore, floor };
      fiche.globalScore = floor;
    }
  }

  // Plancher par categorie — max -5 points sur la moyenne.
  const avgByCat = (f) => {
    const map = new Map();
    if (!Array.isArray(f.elements)) return map;
    for (const el of f.elements) {
      if (!Array.isArray(el.items)) continue;
      const scores = el.items
        .filter((it) => it && typeof it.score === 'number')
        .map((it) => it.score);
      if (!scores.length) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      map.set((el.cat || '').toString().toLowerCase().trim(), { avg, items: el.items });
    }
    return map;
  };

  const prevAvgs = avgByCat(previousFiche);
  const currAvgs = avgByCat(fiche);

  const cats = [];
  for (const [cat, curr] of currAvgs.entries()) {
    const prev = prevAvgs.get(cat);
    if (!prev) continue;
    const floor = Math.max(0, prev.avg - 5);
    if (curr.avg < floor) {
      const lift = floor - curr.avg;
      for (const it of curr.items) {
        if (it && typeof it.score === 'number') {
          it.score = Math.max(0, Math.min(100, Math.round(it.score + lift)));
        }
      }
      cats.push({
        cat,
        prevAvg: Math.round(prev.avg),
        rawAvg: Math.round(curr.avg),
        floorAvg: Math.round(floor),
      });
    }
  }
  if (cats.length) applied.categories = cats;

  if (Object.keys(applied).length) fiche._floor_applied = applied;
  return fiche;
}

// ─────────────────────────────────────────────────────────────
// Advice-followed locking (ticket 4.2).
//
// S appuie sur la checklist (ticket 2.1) : `previousCompletions` est un
// tableau d ids d items qui ont ete coches "implementes" sur V_(n-1).
// Pour chaque categorie de V_(n-1) qui contient au moins un item coche,
// la moyenne de la categorie en V_n ne peut PAS etre inferieure a la
// moyenne en V_(n-1). Si la moyenne courante est en dessous, on releve
// uniformement les item.score de la categorie pour la ramener au niveau
// V_(n-1) (meme mecanique que applyScoreFloor mais plancher = prevAvg).
//
// Concretement : "j ai dit que je l avais implementee, donc c est au moins
// aussi bien qu avant". Le score peut MONTER librement, il ne peut pas
// regresser sur une zone ou l artiste a confirme une action.
//
// A appliquer APRES applyScoreFloor (le lock est plus strict que le floor
// pour les categories concernees, donc l ordre n a pas d effet sur le
// resultat final ; mais ca evite de calculer deux fois la meme correction).
// ─────────────────────────────────────────────────────────────
function applyAdviceLock(fiche, previousFiche, previousCompletions) {
  if (!fiche || !previousFiche) return fiche;
  if (!Array.isArray(previousCompletions) || !previousCompletions.length) return fiche;

  const completedSet = new Set(previousCompletions);

  // Categories de V_(n-1) qui contiennent au moins un item coche, avec leur moyenne.
  const lockedCats = new Map(); // catKey -> prevAvg
  if (Array.isArray(previousFiche.elements)) {
    for (const el of previousFiche.elements) {
      if (!Array.isArray(el.items)) continue;
      const hasCompleted = el.items.some((it) => it && it.id && completedSet.has(it.id));
      if (!hasCompleted) continue;
      const scores = el.items
        .filter((it) => it && typeof it.score === 'number')
        .map((it) => it.score);
      if (!scores.length) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      lockedCats.set((el.cat || '').toString().toLowerCase().trim(), avg);
    }
  }
  if (!lockedCats.size) return fiche;

  const cats = [];
  if (Array.isArray(fiche.elements)) {
    for (const el of fiche.elements) {
      if (!Array.isArray(el.items)) continue;
      const key = (el.cat || '').toString().toLowerCase().trim();
      const lockFloor = lockedCats.get(key);
      if (typeof lockFloor !== 'number') continue;
      const scores = el.items
        .filter((it) => it && typeof it.score === 'number')
        .map((it) => it.score);
      if (!scores.length) continue;
      const currAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (currAvg < lockFloor) {
        const lift = lockFloor - currAvg;
        for (const it of el.items) {
          if (it && typeof it.score === 'number') {
            it.score = Math.max(0, Math.min(100, Math.round(it.score + lift)));
          }
        }
        cats.push({
          cat: el.cat,
          prevAvg: Math.round(lockFloor),
          rawAvg: Math.round(currAvg),
        });
      }
    }
  }
  if (cats.length) {
    fiche._advice_lock_applied = { categories: cats, completedCount: completedSet.size };
  }
  return fiche;
}

// ─────────────────────────────────────────────────────────────
// formulatePerception — Phase A du pipeline intention.
// Court (1-2 phrases + 3-5 tags) : on decrit CE qu on entend,
// SANS juger. Cette perception est affichee a l utilisateur sur
// l ecran d intention avant le diagnostic calibre.
// ─────────────────────────────────────────────────────────────
async function formulatePerception(listening) {
  if (!listening) {
    // Ecoute indisponible : on renvoie une perception neutre
    // pour que le front puisse quand meme afficher l ecran intention.
    return {
      lead: "Ecoute qualitative indisponible — dis-moi quand meme ton intention avant le diagnostic.",
      tags: [],
      bpm: null,
      duration: null,
    };
  }

  const listeningStr = JSON.stringify(listening, null, 2);

  const systemPrompt = `Tu es ingenieur du son. Tu recois une ECOUTE qualitative (JSON) faite par un collegue qui a reellement ecoute le morceau.

Ta tache : formuler en 1-2 phrases UNE PERCEPTION courte de ce que tu entends, destinee a etre montree a l artiste avant le diagnostic. Objectif : qu il se reconnaisse, et puisse te corriger ou completer.

REGLES DE TON :
- 1 a 2 phrases, francais naturel, direct.
- Mentionne le style approximatif, le tempo ressenti, 1-2 elements sonores marquants (voix, grain, reverb, choix rythmiques).
- PAS de jugement ("c est bien", "ca manque de"), PAS de score, PAS de "il faudrait".
- PAS de simulation relationnelle ("je sens que tu voulais", "j adore ce que tu fais"). Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — tu observes, tu ne ressens rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour"). Reconnaitre qu un titre est un classique/standard reste OK, les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres. Reste factuel.
- PAS de "chantier" — prefere "ajustements", "leviers", "axes" si tu dois mentionner des pistes.

EN PLUS de la perception, extrais :
- 3 a 5 tags courts en francais (style, grain, tempo, un element fort), format court (ex: "soul-pop", "voix-retrait", "grain-analogique").
- bpm approximatif (number ou null si l ecoute ne permet pas d estimer).
- duree au format "mm:ss" (ou null).

Reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks :
{
  "lead": "string (1-2 phrases)",
  "tags": ["string", "string", ...],
  "bpm": number | null,
  "duration": "mm:ss" | null
}`;

  const prompt = `ECOUTE QUALITATIVE :
${listeningStr}

Formule la perception en suivant exactement le schema JSON ci-dessus.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === 'AbortError') throw new Error('Perception API: timeout (30s)');
    throw fetchErr;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[perception] API error:', res.status, body.slice(0, 300));
    throw new Error('Perception API: ' + res.status);
  }

  const data = await res.json();
  _recordUsage(data.usage, 'perception');
  let text = (data.content[0].text || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[perception] no JSON in response');
    return { lead: text.slice(0, 280) || "Lecture formulee indisponible.", tags: [], bpm: null, duration: null };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return {
      lead: typeof parsed.lead === 'string' ? parsed.lead.trim() : "",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === 'string').slice(0, 5) : [],
      bpm: typeof parsed.bpm === 'number' ? parsed.bpm : null,
      duration: typeof parsed.duration === 'string' ? parsed.duration : null,
    };
  } catch (e) {
    console.error('[perception] parse error:', e.message);
    return { lead: "Lecture formulee indisponible.", tags: [], bpm: null, duration: null };
  }
}

// ─────────────────────────────────────────────────────────────
// generateFiche — signature etendue avec deux parametres OPTIONNELS
// en fin :
//   - intent : bloc d intention artistique (cadre le diagnostic)
//   - fadrMetrics : mesures objectives Fadr ({bpm, key, lufs, stems, …})
//     branchees en 1.1bis (DSP_PLAN). 1.2 : exploitees dans le prompt
//     en tant que MESURES OBJECTIVES — Claude peut/doit les citer dans
//     les "why", "summary", "how" quand c est pertinent. Si absentes
//     (Fadr KO/timeout), le pipeline retombe sur le comportement
//     historique "aucune mesure".
// Tous les appels existants (sans intent / sans fadrMetrics) continuent
// de marcher inchanges.
// ─────────────────────────────────────────────────────────────
async function generateFiche(mode, daw, title, artist, listening, pmContext, previousFiche, intent, previousCompletions, fadrMetrics, declaredGenre = null, genreUnknown = false, uploadType = 'master') {
  const isRef = mode === 'ref';
  // listeningStr en let (et pas const) parce qu'on peut le re-deriver
  // plus bas si on detecte un master commercial et qu on neutralise la
  // section "a_travailler" pour eviter l incoherence avec le diagnostic
  // Claude qui reformule positivement les memes points.
  let listeningStr = listening ? JSON.stringify(listening, null, 2) : 'AUCUNE ECOUTE DISPONIBLE (Gemini a echoue).';
  const hasPM = typeof pmContext === 'string' && pmContext.trim().length > 0;
  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const intentStr = hasIntent ? intent.trim() : '';
  // Genre musical : soit déclaré explicitement par l'artiste, soit "à inférer
  // par l'IA" si l'artiste a cliqué "Choisir automatiquement". Quand declaredGenre
  // est rempli, c'est la vérité de référence et Claude calibre ses items
  // techniques en conséquence. Quand genreUnknown=true, Claude DOIT inférer un
  // genre court (≤3 mots) depuis l'écoute et l'émettre dans `inferred_genre`.
  const hasDeclaredGenre = typeof declaredGenre === 'string' && declaredGenre.trim().length > 0;
  const declaredGenreStr = hasDeclaredGenre ? declaredGenre.trim() : '';
  const shouldInferGenre = !hasDeclaredGenre && genreUnknown === true;
  const m = fadrMetrics || {};
  const mBpm = (typeof m.bpm === 'number' || (typeof m.bpm === 'string' && m.bpm.trim())) ? m.bpm : null;
  const mKey = (typeof m.key === 'string' && m.key.trim()) ? m.key.trim() : null;
  const mLufs = (typeof m.lufs === 'number') ? m.lufs : (typeof m.lufs === 'string' && m.lufs.trim() ? parseFloat(m.lufs) : null);
  const mLra = (typeof m.lra === 'number') ? m.lra : null;
  const mTruePeak = (typeof m.truePeak === 'number') ? m.truePeak : null;
  const hasMetrics = !!(mBpm || mKey || mLufs != null || mLra != null || mTruePeak != null);
  if (hasMetrics) {
    console.log('[claude] metrics injected in prompt — bpm:', mBpm, 'key:', mKey, 'lufs:', mLufs, 'lra:', mLra, 'truePeak:', mTruePeak);
  }
  // Le hasStems / hasStereo loggers sont definis plus bas (apres le calcul
  // des verdicts par stem/stereo). Voir log apres le bloc dspBlock.

  // Verdict contextualise sur le LUFS (cible streaming) pour aider Claude
  // a calibrer son diagnostic master sans le laisser deriver.
  let lufsVerdict = '';
  if (mLufs != null) {
    if (mLufs < -16) lufsVerdict = 'sous la cible streaming (vise -10 a -14 LUFS pour Spotify/Apple/YouTube), le master manque de presence';
    else if (mLufs < -10) lufsVerdict = 'dans la zone confortable streaming (Spotify/Apple normalisent autour de -14, donc tu as encore un peu de marge dynamique)';
    else if (mLufs < -7) lufsVerdict = 'dans le sweet spot streaming actuel (-10 a -8 LUFS), bon equilibre dynamique/loudness';
    else lufsVerdict = 'tres pousse (> -7 LUFS) : Spotify/Apple vont normaliser a la baisse, attention aux distorsions limiter';
  }

  // Verdict contextualise sur LRA (plage dynamique) :
  // - LRA < 4 : ecrasee, peu d air entre couplets/refrains (mastering tres tasse)
  // - 4-7   : moderne pop/electro, dynamique compressee mais ok
  // - 7-12  : confortable, respiration entre sections
  // - > 12  : large, classique/jazz/cinematic
  let lraVerdict = '';
  if (mLra != null) {
    if (mLra < 4) lraVerdict = 'plage dynamique tres ecrasee (limiteur tres present, peu d air entre les sections)';
    else if (mLra < 7) lraVerdict = 'plage dynamique pop/electro standard (compression maitrisee)';
    else if (mLra < 12) lraVerdict = 'plage dynamique confortable, sections respirent';
    else lraVerdict = 'plage dynamique large (classique/jazz/cinematic)';
  }

  // Verdict True Peak (clipping inter-sample) :
  // - > 0 dBTP : clipping garanti sur n importe quel encodeur lossy (mp3/aac)
  // - -1 a 0   : risque de clipping intersample apres encodage streaming
  // - <= -1    : safe streaming (cible standard -1 dBTP)
  let truePeakVerdict = '';
  if (mTruePeak != null) {
    if (mTruePeak > 0) truePeakVerdict = 'clipping intersample certain sur les encodeurs lossy (mp3/aac/opus). Critique a corriger : limiter -1 dBTP en sortie';
    else if (mTruePeak > -1) truePeakVerdict = 'risque de clipping intersample apres encodage streaming (cible standard : -1 dBTP). A descendre legerement';
    else truePeakVerdict = 'sous la cible -1 dBTP, safe pour les encodeurs streaming';
  }

  // ── DSP_PLAN B.5 — bloc STEMS (Phase 3) ───────────────────────────────
  // Mesures par stem isolé. Calcule un verdict "voix posée" (delta LUFS
  // voix vs instru), un proxy sibilantes (énergie 5-8 kHz du stem voix),
  // un proxy présence (énergie 1-3 kHz). Sur les autres stems, on expose
  // juste les valeurs (Claude se sert de l'écoute Gemini pour le qualitatif).
  const stemsArr = Array.isArray(m.stemsMeasured) ? m.stemsMeasured : [];
  const findStem = (type) => stemsArr.find((s) => s && s.stemType === type) || null;
  const vocalStem = findStem('vocal');
  const drumsStem = findStem('drums');
  const bassStem = findStem('bass');
  const otherStem = findStem('other');
  // LUFS instru reconstitué = moyenne pondérée des stems non-voix dispos.
  // Pas parfait (somme énergétique vraie demanderait une mesure de L_total),
  // mais une moyenne donne un repère utile pour le delta voix/instru.
  const instruLufs = (() => {
    const xs = [drumsStem, bassStem, otherStem]
      .map((st) => (st && typeof st.lufs === 'number') ? st.lufs : null)
      .filter((v) => v != null);
    if (!xs.length) return null;
    // Conversion en linéaire pour moyenner correctement, puis retour en dB.
    const lin = xs.map((db) => Math.pow(10, db / 10));
    const avg = lin.reduce((a, b) => a + b, 0) / lin.length;
    return +(10 * Math.log10(avg)).toFixed(1);
  })();
  const vocalLufs = vocalStem?.lufs ?? null;
  const voiceVsInstruDelta = (vocalLufs != null && instruLufs != null)
    ? +(vocalLufs - instruLufs).toFixed(1)
    : null;
  let voicePlacementVerdict = '';
  if (voiceVsInstruDelta != null) {
    if (voiceVsInstruDelta < -3) voicePlacementVerdict = 'voix en retrait par rapport a l instru (' + voiceVsInstruDelta + ' LU) : a remonter de ' + Math.abs(voiceVsInstruDelta + 1).toFixed(1) + ' dB pour rejoindre la cible -1 a +1 LU';
    else if (voiceVsInstruDelta > 3) voicePlacementVerdict = 'voix tres en avant (' + voiceVsInstruDelta + ' LU au dessus de l instru) : peut sembler agressive ou detachee, a calibrer selon le genre';
    else voicePlacementVerdict = 'voix bien posee dans le mix (delta ' + voiceVsInstruDelta + ' LU vs instru, dans la cible -3/+3 LU)';
  }
  // Sibilantes : énergie de la voix dans 5-8 kHz. Repère perceptif :
  // > -25 dB = sibilantes proeminentes (susceptibles), -30 a -25 = présentes,
  // < -30 = douces. Echelle approximative car varie selon registre vocal.
  let sibilantsVerdict = '';
  const sibilantsBand = vocalStem?.energyBand_5_8kHz ?? null;
  if (sibilantsBand != null) {
    if (sibilantsBand > -25) sibilantsVerdict = 'sibilantes appuyees (energie 5-8 kHz a ' + sibilantsBand + ' dB), de-esser conseille (Sibilance ratio 4:1, threshold -28 dB)';
    else if (sibilantsBand > -30) sibilantsVerdict = 'sibilantes presentes mais maitrisees (' + sibilantsBand + ' dB sur 5-8 kHz)';
    else sibilantsVerdict = 'sibilantes douces (' + sibilantsBand + ' dB sur 5-8 kHz), pas d action urgente';
  }
  // Presence (1-3 kHz) : zone d intelligibilite des voyelles + transitoires
  // d articulation. Pas de verdict normatif (le bon niveau depend du genre)
  // mais on expose la valeur pour que Claude puisse comparer.
  const presenceBand = vocalStem?.energyBand_1_3kHz ?? null;

  const stemsLines = [];
  if (vocalStem) stemsLines.push(`- VOIX : ${vocalStem.lufs != null ? vocalStem.lufs + ' LUFS' : 'mesure KO'}${vocalStem.truePeak != null ? ' / ' + vocalStem.truePeak + ' dBTP' : ''}${sibilantsBand != null ? ' / 5-8 kHz: ' + sibilantsBand + ' dB' : ''}${presenceBand != null ? ' / 1-3 kHz: ' + presenceBand + ' dB' : ''}`);
  if (drumsStem) stemsLines.push(`- DRUMS : ${drumsStem.lufs != null ? drumsStem.lufs + ' LUFS' : 'mesure KO'}${drumsStem.truePeak != null ? ' / ' + drumsStem.truePeak + ' dBTP' : ''}`);
  if (bassStem) stemsLines.push(`- BASS : ${bassStem.lufs != null ? bassStem.lufs + ' LUFS' : 'mesure KO'}${bassStem.truePeak != null ? ' / ' + bassStem.truePeak + ' dBTP' : ''}`);
  if (otherStem) stemsLines.push(`- INSTRU (other) : ${otherStem.lufs != null ? otherStem.lufs + ' LUFS' : 'mesure KO'}${otherStem.truePeak != null ? ' / ' + otherStem.truePeak + ' dBTP' : ''}`);
  if (instruLufs != null) stemsLines.push(`- INSTRU GLOBAL (moyenne energetique) : ${instruLufs} LUFS`);
  if (voiceVsInstruDelta != null) stemsLines.push(`- DELTA VOIX/INSTRU : ${voiceVsInstruDelta > 0 ? '+' : ''}${voiceVsInstruDelta} LU — ${voicePlacementVerdict}`);
  if (sibilantsVerdict) stemsLines.push(`- SIBILANTES : ${sibilantsVerdict}`);
  const hasStems = stemsLines.length > 0;

  // ── DSP_PLAN B.5 — bloc STEREO (Phase 3) ──────────────────────────────
  // Corrélation L/R, Mid/Side ratio, balance L/R, mono compat. Permet a
  // Claude de proposer des recettes spatial/reverb calibrees.
  const stereo = m.stereo || null;
  const mCorr = stereo && typeof stereo.correlation === 'number' ? stereo.correlation : null;
  const mMS = stereo && typeof stereo.midSideRatio === 'number' ? stereo.midSideRatio : null;
  const mBal = stereo && typeof stereo.balanceLR === 'number' ? stereo.balanceLR : null;
  const mMonoCompat = stereo && typeof stereo.monoCompat === 'number' ? stereo.monoCompat : null;
  let corrVerdict = '';
  if (mCorr != null) {
    if (mCorr > 0.85) corrVerdict = 'mix etroit/quasi mono (corr > 0.85), peu de largeur stereo — possibilite d elargir avec un Haas court ou un mid/side EQ';
    else if (mCorr > 0.6) corrVerdict = 'image stereo equilibree (correlation moderee), bon compromis largeur/cohesion';
    else if (mCorr > 0.2) corrVerdict = 'mix tres large (correlation faible) : verifier la mono-compat ci-dessous avant validation';
    else corrVerdict = 'risque de problemes de phase (correlation < 0.2) : tester en mono, des elements peuvent disparaitre';
  }
  let monoCompatVerdict = '';
  if (mMonoCompat != null) {
    if (mMonoCompat <= 2) monoCompatVerdict = 'excellent en mono (perte ' + mMonoCompat + ' LU vs stereo)';
    else if (mMonoCompat <= 4) monoCompatVerdict = 'mono a surveiller (perte ' + mMonoCompat + ' LU) : zone typique des masters commerciaux en stereo enveloppante, des elements mid/side s annulent partiellement mais le titre tient en stereo';
    else monoCompatVerdict = 'mono a reprendre (perte ' + mMonoCompat + ' LU) : des elements en side s attenuent significativement en lecture mono (telephone, enceinte BT) — important a corriger avant publication';
  }
  let balanceVerdict = '';
  if (mBal != null) {
    const absB = Math.abs(mBal);
    if (absB < 0.5) balanceVerdict = 'mix bien centre (balance L/R a ' + mBal + ' dB)';
    else if (absB < 1.5) balanceVerdict = 'leger desequilibre L/R (' + mBal + ' dB) — pencheche ' + (mBal > 0 ? 'a gauche' : 'a droite') + ', surement intentionnel';
    else balanceVerdict = 'desequilibre marque L/R (' + mBal + ' dB) : verifier que c est bien intentionnel sinon recentrer le bus master';
  }
  const stereoLines = [];
  if (mCorr != null) stereoLines.push(`- CORRELATION L/R : ${mCorr} — ${corrVerdict}`);
  if (mMS != null) stereoLines.push(`- MID/SIDE RATIO : ${mMS} (part d energie sur le side, ${(mMS * 100).toFixed(0)}%)`);
  if (mBal != null) stereoLines.push(`- BALANCE L/R : ${mBal > 0 ? '+' : ''}${mBal} dB — ${balanceVerdict}`);
  if (mMonoCompat != null) stereoLines.push(`- MONO COMPAT : ${mMonoCompat > 0 ? '+' : ''}${mMonoCompat} LU (LUFS_stereo - LUFS_mono) — ${monoCompatVerdict}`);
  const hasStereo = stereoLines.length > 0;

  // Bloc MESURES OBJECTIVES injecte au debut du systemPrompt.
  // Format pensé pour aider Claude :
  // - liste claire de ce qu il SAIT (pour pouvoir le citer textuellement)
  // - verdicts pre-calcules pour calibrer le diagnostic master/voix/stereo
  // - garde-fous pour ne pas inventer d autres mesures
  const hasAnyDspContent = hasMetrics || hasStems || hasStereo;
  if (hasStems) console.log('[claude] stems injected — count:', stemsArr.length, 'voix delta:', voiceVsInstruDelta, 'sibilants:', sibilantsBand);
  if (hasStereo) console.log('[claude] stereo injected — corr:', mCorr, 'M/S:', mMS, 'monoCompat:', mMonoCompat);

  // ── DETECTION "MASTER COMMERCIAL" ───────────────────────────────────────
  // Heuristique 6 criteres pour reconnaitre un titre au standard commercial
  // (release publie / master pro). Quand on le detecte, on bascule le prompt
  // en mode plus indulgent : on ne nitpick plus sur des choix esthetiques
  // assumes, on reconnait le standard. Sinon on garde le comportement
  // critique habituel pour les mix en cours.
  //
  // Note : on n'active ce mode QUE en upload_type='master'. Un user qui
  // declare un mix non-masterise ne doit pas etre traite avec la lentille
  // commerciale meme si ses mesures sont parfaites (ce serait incoherent
  // avec sa declaration et le mode mix existant).
  // Fourchettes calibrees pour couvrir tout le repertoire de production
  // professionnelle, toutes epoques confondues (vinyle/CD 70s-80s ->
  // streaming moderne 2020s+) :
  // - LUFS [-20, -7]  : englobe Pink Floyd / Queen / Beatles (vinyle, ~-18/-20)
  //                     jusqu au master loud moderne (-7 typique)
  // - LRA [4, 20]     : englobe la dynamique aplatie du loudness war (4-6)
  //                     comme la dynamique large des annees 70/jazz/orchestral (15-20)
  // Le seuil 5/6 criteres requis filtre toujours les mix amateurs (qui
  // foirent typiquement 2+ autres mesures : TP, mono compat, sibilantes...).
  const commercialChecks = {
    lufsInTarget: (mLufs != null) && mLufs >= -20 && mLufs <= -7,
    lraReasonable: (mLra != null) && mLra >= 4 && mLra <= 20,
    truePeakSafe: (mTruePeak != null) && mTruePeak <= 0,
    correlationHealthy: (mCorr != null) && mCorr >= 0.4 && mCorr <= 0.98,
    monoCompatAcceptable: (mMonoCompat != null) && mMonoCompat <= 4,
    sibilantsControlled: (sibilantsBand != null) && sibilantsBand <= -25,
  };
  const commercialScore = Object.values(commercialChecks).filter(Boolean).length;
  // 5/6 critères techniques + mode 'master' déclaré = master commercial probable.
  // On baisse le seuil a 4/6 si certaines mesures sont indisponibles (stems
  // ou stereo manquants donnent des criteres a undefined qu on n a pas
  // moyen de verifier — on est conservatoire).
  const isMaster = uploadType === 'master';

  // ── PROTECTION B — Cross-check Gemini sur l'ecoute ──────────────────
  // Faux positif typique : un beatmaker met Ozone/limiteur sur son bus master
  // des le debut du mix. Resultat : LUFS/LRA/TP/corr/mono compat passent tous
  // (gonfles par le limiteur), 6/6 criteres techniques OK. Si l user coche
  // "Master" par confusion (parce que son mix sonne "fort"), le mode
  // commercial s activerait a tort sur un mix encore bancal.
  //
  // Garde-fou : on contre-verifie via l'ecoute Gemini. Un VRAI master
  // commercial professionnel a un "a_travailler" quasi-vide (0 ou 1 item
  // mineur maximum). Des qu il y a 2+ items dans a_travailler, c est qu il
  // reste de vrais axes d amelioration -> ce n est pas un master commercial,
  // c est un mix solide mais non finalise. Le mode commercial est DESACTIVE
  // meme si toggle='Master' + 5/6 critères techniques.
  //
  // Note : la detection se fait sur le wording original de Gemini, pas sur
  // la version reecrite par Claude. Un wording doux ("pourrait beneficier
  // de plus de corps") compte comme un item au meme titre qu un wording
  // direct ("manque de corps") — l intention est la meme.
  const aTravailler = Array.isArray(listening?.a_travailler) ? listening.a_travailler : [];
  const tooManyDefects = aTravailler.length >= 2;
  const isLikelyCommercialMaster = isMaster && commercialScore >= 5 && !tooManyDefects;
  if (isMaster && commercialScore >= 5) {
    console.log('[claude] commercial-master eval — score:', commercialScore + '/6', 'a_travailler items:', aTravailler.length, 'activated:', isLikelyCommercialMaster);
  }

  // Neutralisation de l'ecoute Gemini en mode master commercial.
  // L'ecoute Gemini est generee SANS conscience du contexte master commercial
  // (Gemini ne voit que l'audio brut). Resultat : sa section "a_travailler"
  // pointe des "defauts" qualitatifs (basse boueuse, snare en retrait, etc.)
  // qui contredisent visuellement le diagnostic Claude reformule. On neutralise
  // donc cette section a la source pour eviter l incoherence affichee a
  // l utilisateur (ecoute "a_travailler" en haut de fiche + items Claude
  // "choix assume" en bas). La mutation est faite par reference -> Claude
  // voit aussi l ecoute neutralisee, et le frontend recoit la version propre.
  if (isLikelyCommercialMaster && listening && Array.isArray(listening.a_travailler) && listening.a_travailler.length > 0) {
    console.log('[claude] commercial-master: neutralizing listening.a_travailler (' + listening.a_travailler.length + ' items)');
    listening.a_travailler = [
      "Aucun ajustement majeur à signaler — production au niveau d'une release commerciale publiée."
    ];
    // Re-derive listeningStr depuis l ecoute mutee pour que Claude voie la
    // version propre et reste coherent avec le bloc commercial.
    listeningStr = JSON.stringify(listening, null, 2);
  }
  const dspBlock = hasAnyDspContent ? `

MESURES OBJECTIVES DU MORCEAU (sources fiables, conformes aux standards) :
${mBpm ? `- BPM : ${mBpm} (Fadr)` : ''}
${mKey ? `- Tonalité : ${mKey} (Fadr — reformule en clair si pertinent : "Eb maj" -> "Mi bémol majeur", "Am" -> "La mineur").` : ''}
${mLufs != null ? `- Loudness intégré : ${mLufs} LUFS (mesuré via ffmpeg ebur128, ITU-R BS.1770) — ${lufsVerdict}.` : ''}
${mLra != null ? `- LRA (Loudness Range) : ${mLra} LU — ${lraVerdict}.` : ''}
${mTruePeak != null ? `- True Peak max : ${mTruePeak} dBTP — ${truePeakVerdict}.` : ''}
${hasStems ? `

MESURES PAR STEM (Fadr separation + ffmpeg ebur128 + bandpass — DSP_PLAN Phase 3) :
${stemsLines.join('\n')}` : ''}
${hasStereo ? `

MESURES CHAMP STEREO (ffmpeg astats sur le master — DSP_PLAN Phase 3) :
${stereoLines.join('\n')}` : ''}

EXPLOITATION DE CES MESURES :
- Tu PEUX et tu DOIS citer ces valeurs dans les champs "why", "summary" ou "how" quand elles eclairent un point. Cite les valeurs TEXTUELLEMENT (dis "${mBpm || 'X'} BPM" / "${mLufs ?? 'X'} LUFS" / "${mTruePeak ?? 'X'} dBTP", pas "un tempo modéré" ou "un loudness eleve").
- En MASTER & LOUDNESS, c est OBLIGATOIRE de t appuyer sur LUFS / LRA / True Peak quand ils sont disponibles. Si le LUFS est sous la cible streaming, propose de remonter (recette "how" : "monter de X dB pour atteindre -10 LUFS"). Si le True Peak est > -1 dBTP, propose un limiter ceiling a -1 dBTP. Si le LRA est tres bas, suggere d alleger la compression bus master.${hasStems ? `
- En VOIX, calibre tes items sur les mesures stems : delta voix/instru ${voiceVsInstruDelta != null ? '(' + voiceVsInstruDelta + ' LU' + (voiceVsInstruDelta < -3 ? ', voix en retrait — recette : remonter le bus voix de ' + Math.abs(voiceVsInstruDelta + 1).toFixed(1) + ' dB' : voiceVsInstruDelta > 3 ? ', voix proeminente' : ', cible OK') + ')' : ''}, sibilantes ${sibilantsBand != null ? '(' + sibilantsBand + ' dB sur 5-8 kHz' + (sibilantsBand > -25 ? ' — de-esser conseille' : '') + ')' : ''}. Si la voix est en retrait, propose une remontee precise basee sur la mesure et non un avis vague.` : ''}${hasStereo ? `
- En SPATIAL & REVERB ou MASTER, calibre sur la stereo : ${mCorr != null ? 'correlation ' + mCorr + (mCorr < 0.2 ? ' = risque de phase, tester en mono' : mCorr > 0.85 ? ' = mix etroit, possibilite d elargir' : '') : ''}${mMonoCompat != null ? ', mono compat ' + mMonoCompat + ' LU' + (mMonoCompat > 2 ? ' = des elements disparaissent en mono, a corriger via mid/side EQ ou repositionner les sources side critiques au centre' : '') : ''}.` : ''}
- En BASSES & KICK ou INSTRUMENTS, la tonalite t aide : si l'écoute parle de masquage basse-grave, tu peux preciser que la fondamentale ${mKey ? 'est en ' + mKey : ''} et donner des frequences EQ adaptees a cette tonalite.
- Le BPM peut justifier des recettes de delay/reverb time (ex: "delay 1/8 = ${mBpm ? Math.round(60000 / mBpm / 2) + ' ms' : '...'}", "reverb decay calé sur ${mBpm ? Math.round(60000 / mBpm * 2) + ' ms' : '...'} = 2 temps"). Tu peux faire ces calculs.

GARDE-FOU HALF-TIME (detection BPM ambigue) :
Les detecteurs BPM (Fadr inclus) se trompent regulierement d un facteur 2 entre half-time et double-time (75 vs 150, 80 vs 160, etc.). Avant d utiliser le BPM pour des recettes time-based (delay, reverb decay, pre-delay), tu DOIS faire ce check de sanity en silence :

(1) Si le BPM mesure est >= 140 ET que l ecoute Gemini decrit le morceau avec un caractere LENT/MID-TEMPO (mots-cles strictement deterministes : "mid-tempo", "ballade", "downtempo", "lent", "slow", "intimiste", "feutre", "atmospherique") ET que l ecoute ne mentionne AUCUN mot de caractere rapide (interdit : "energique", "dansant", "uptempo", "club", "drum'n'bass", "drum and bass", "rapide", "frenetique") -> alors considere que le BPM REEL est probablement BPM_mesure / 2, et calcule TES RECETTES TIME-BASED sur BPM/2.

(2) Hors de ce triple ET, garde le BPM mesure tel quel.

(3) NE MENTIONNE PAS cette correction dans la fiche (ni dans le summary, ni dans les items). C est une correction interne silencieuse. Tu cites toujours le BPM tel qu il est dans le bloc MESURES OBJECTIVES ci-dessus pour ne pas creer de confusion avec l affichage front.

(4) Si l artiste a renseigne un BPM en amont (visible dans MESURES OBJECTIVES, override Fadr), ce BPM est LA VERITE et tu ne dois PAS appliquer la correction half-time. Le BPM affiche est deja le BPM corrige.

GARDE-FOUS :
- N invente JAMAIS d AUTRES mesures que celles listees ci-dessus. Pas de "le kick tape a 62 Hz", pas de "la voix est a -8 dBFS sur les pics", pas de "le crest factor est de 12 dB" : ces valeurs ne sont pas mesurees, donc INTERDITES en tant que mesures de CE titre.
- Tu peux donner des VALEURS DE RECETTE GENERIQUES dans "how" (Hz, dB, ratio, attack/release en ms, GR en dB) — ce sont des techniques pro standard, pas des mesures du titre.
` : '';

  // Le template inclut les champs genre quand ils s'appliquent :
  // - declared_genre : présent uniquement si l'artiste a déclaré un genre (Claude le réémet textuellement)
  // - inferred_genre : présent uniquement si l'artiste a cliqué "Choisir automatiquement" (Claude infère)
  // Ces deux champs sont mutuellement exclusifs dans la sortie attendue.
  const persoTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX",                icon: "voice",   items: [{ id: "voice-1", section: "VOIX", priority: "high", title: "...", score: 72, why: "...", how: "...", plugin_pick: "..." }] },
      { cat: "INSTRUMENTS",         icon: "synths",  items: [] },
      { cat: "BASSES & KICK",       icon: "bass",    items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums",   items: [] },
      { cat: "SPATIAL & REVERB",    icon: "fx",      items: [] },
      { cat: "MASTER & LOUDNESS",   icon: "lufs",    items: [] },
    ],
    globalScore: 72,
    summary: "...",
    ...(hasDeclaredGenre ? { declared_genre: "..." } : {}),
    ...(shouldInferGenre ? { inferred_genre: "..." } : {}),
  });

  const refTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX",                icon: "voice",   items: [] },
      { cat: "INSTRUMENTS",         icon: "synths",  items: [] },
      { cat: "BASSES & KICK",       icon: "bass",    items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums",   items: [] },
      { cat: "SPATIAL & REVERB",    icon: "fx",      items: [] },
      { cat: "MASTER & LOUDNESS",   icon: "lufs",    items: [] },
    ],
    tips: [],
    summary: "..."
  });

  // Bloc intention a injecter dans le systemPrompt (seulement si fournie)
  const intentBlock = hasIntent ? `

INTENTION ARTISTIQUE DECLAREE PAR L ARTISTE :
"${intentStr}"

Cette intention est un CADRE qui transforme ton regard :
- Ce qui ressemble a un defaut mais s inscrit dans l intention est un CHOIX ASSUME, pas une erreur. Ne propose pas de le "corriger", sauf si tu penses que le choix dessert l intention elle-meme (et dans ce cas, explique le conflit dans le "why" de l item).
- Ce qui s ecarte de l intention sans raison apparente merite un item d ajustement, avec score bas si c est bien un defaut technique.
- Les references citees (artistes, albums) sont des boussoles : compare, ne copie pas.
- Les scores restent ancres sur les problematiques techniques (balance, dynamique, masquage, artefacts). Un choix revendique par l intention ne doit PAS tirer un score vers le bas.
- Le summary doit brievement reconnaitre l intention et dire si elle est globalement respectee ou si des ecarts notables sont reperes.
` : '';

  // Bloc genre a injecter dans le systemPrompt (deux modes : declare ou a inferer)
  const genreBlock = hasDeclaredGenre ? `

GENRE MUSICAL DECLARE PAR L ARTISTE :
"${declaredGenreStr}"

Ce genre est la VERITE DE REFERENCE et CALIBRE tes recommandations techniques :
- Les normes de mix varient selon le genre. Un mix dub-techno tolere de la saturation analogique et une dynamique tres ecrasee ; un mix folk/singer-songwriter exige une dynamique preservee et une voix tres claire ; un mix electro/club priorise un sub puissant et un loudness eleve ; un mix jazz acoustique demande une scene stereo realiste et peu de compression. Adapte tes recettes en consequence.
- Tu peux mentionner ce genre textuellement dans le summary si c est utile (l artiste l a declare, donc pas de risque d erreur).
- Tu DOIS emettre dans le JSON de fiche un champ "declared_genre" (string) reprenant exactement la valeur declaree.
` : (shouldInferGenre ? `

GENRE MUSICAL — A INFERER PAR L IA :
L artiste a clique "Choisir automatiquement" pour le genre. Tu dois INFERER un genre court (2-3 mots max, ex: "indie pop", "neo-soul", "dub-techno", "folk acoustique") UNIQUEMENT depuis l ECOUTE (tags + commentaire Gemini : instruments percus, energie, atmosphere, timbre, tempo, structure, type de batterie, type de basse, traitement vocal, etc.), et :
- Calibrer tes items techniques sur ce genre infere (cf. exemples plus bas).
- EMETTRE dans le JSON de fiche un champ "inferred_genre" (string court) avec ce genre.
- NE JAMAIS mentionner le genre infere dans le summary (l artiste n a rien declare, on ne lui colle pas une etiquette qui peut etre fausse — le champ inferred_genre sera affiche separement avec un caveat dans la fiche).

INTERDIT — sources prohibees pour l inference du genre :
- L INTENTION DECLAREE par l artiste (bloc plus haut). Meme si elle contient des mots qui ressemblent a un genre ("lo-fi soul", "indie pop", "néo-soul"…), tu IGNORES ces mots pour ce champ : l intention parle des references et de l humeur recherchees, pas de ce que sonne reellement le mix. Recopier l intention serait une triche, pas une analyse.
- Le titre du morceau, le nom de l artiste, les references citees.
- Tes propres suppositions hors observations de l ecoute.

Test : ton genre infere doit pouvoir etre justifie par des observations musicales CONCRETES de l ecoute (ex: "voix soul + beat downtempo + hiss vinyle + basse warm + tempo lent" -> "lo-fi soul"). Si l ecoute ne te donne pas assez de matiere pour justifier un genre, EMETS inferred_genre: null plutot que d inventer ou de recopier l intention.

Calibrage par genre (exemples) : dub-techno tolere saturation analogique et dynamique ecrasee ; folk/singer-songwriter exige dynamique preservee et voix claire ; electro/club priorise sub puissant et loudness eleve ; jazz acoustique demande scene stereo realiste et peu de compression.
` : '');

  // ── Bloc PERSISTANCE INTER-VERSION ─────────────────────────────
  // Injecte un resume compact de la fiche v(n-1) dans le system prompt
  // pour empecher que des items (MED ou HIGH) disparaissent silencieusement
  // entre 2 versions du meme titre quand le mix n a pas bouge sur l axe.
  // Levier 2 du plan persistance (2026-05-13).
  let previousFicheBlock = '';
  if (previousFiche && Array.isArray(previousFiche.elements) && previousFiche.elements.length) {
    const lines = [];
    const completedSet = new Set(Array.isArray(previousCompletions) ? previousCompletions : []);
    for (const el of previousFiche.elements) {
      if (!Array.isArray(el.items) || !el.items.length) continue;
      for (const it of el.items) {
        if (!it) continue;
        const cat = (el.cat || '').toString().toUpperCase();
        const title = (it.title || '').toString().replace(/\s+/g, ' ').trim();
        const score = typeof it.score === 'number' ? it.score : '?';
        const priority = (it.priority || '').toString().toUpperCase();
        const completed = it.id && completedSet.has(it.id) ? ' [RESOLU PAR ARTISTE]' : '';
        lines.push(`- ${cat} : "${title}" (${score} ${priority})${completed}`);
      }
    }
    if (lines.length) {
      previousFicheBlock = `

DIAGNOSTIC DE LA VERSION PRECEDENTE (V_n-1) — REFERENCE POUR LA STABILITE INTER-VERSION :
Voici les items qui figuraient dans la fiche de la version precedente du MEME titre :
${lines.join('\n')}

REGLE DE PERSISTANCE INTER-VERSION — STRICTE :
(1) Si un item MED ou HIGH de la v(n-1) etait ancre sur une MESURE DSP (mono compat, True Peak, LUFS, correlation, sibilantes, delta voix/instru), et que la MESURE EQUIVALENTE en v(n) reste dans la MEME ZONE de seuil, tu DOIS rejouer un item equivalent en v(n) avec une severite coherente. Une mesure inchangee = un item inchange. Ne fais JAMAIS disparaitre silencieusement un item DSP — l artiste doit pouvoir suivre l axe d une version a l autre.

(2) Si un item de la v(n-1) etait QUALITATIF (sans ancrage DSP, ex: "reverb voix a renforcer", "guitares manquent de presence") :
  - Si l ecoute v(n) le mentionne encore -> rejoue l item, severite coherente.
  - Si l ecoute v(n) ne le mentionne plus ET que la categorie correspondante ne semble pas avoir ete retouchee (pas mentionne dans "a_travailler" precedent comme RESOLU, et globalScore de la categorie n a pas saute) -> tu PEUX rejouer l item comme "sujet a confirmer" : score 78-82 LOW ACTIF, why = "L ecoute ne mentionne plus ce point en v(n), mais aucun ajustement explicite n a ete documente. A re-ecouter pour confirmer.", how = la meme recette qu en v(n-1).

(3) Si un item MED/HIGH de la v(n-1) est marque [RESOLU PAR ARTISTE] (case cochee) -> ne le rejoue PAS sauf si une mesure DSP le contredit fortement. C est une victoire, on passe a autre chose.

(4) Si un item MED/HIGH de la v(n-1) a vraiment ete ameliore par la nouvelle version (mesure DSP qui passe d une zone problematique a une zone saine, OU ecoute v(n) qui valide explicitement la categorie) -> tu PEUX (et dois) le faire monter en LOW en v(n). C est la progression normale.

(5) Tu ne dois JAMAIS faire descendre un item de LOW (v_n-1) a MED/HIGH (v_n) sans signal clair (mesure DSP qui s est degradee OU ecoute v(n) qui pointe explicitement le sujet en negatif).

Cette regle est CRITIQUE pour la confiance dans l outil : un utilisateur doit pouvoir comprendre l evolution de SES axes d une version a l autre. Disparition silencieuse = bug perceptif majeur.
`;
    }
  }

  // Bloc upload type a injecter dans le systemPrompt — pilote la calibration
  // de la section MASTER & LOUDNESS selon ce que l artiste a declare a
  // l upload (toggle Mix/Master, refonte 2026-04-30).
  //
  // Mode 'mix' : l artiste a explicitement dit "ce n est pas un master". On
  // ne le penalise donc pas sur la loudness finale. La section MASTER &
  // LOUDNESS reste presente (head-room, dynamique, equilibre spectral
  // global, mono compat sont utiles a verifier en amont du mastering) mais
  // les recettes basculent en checks "pre-master" (laisser de la marge,
  // verifier les peaks, viser un LUFS pre-master autour de -16 a -14)
  // plutot qu en cibles streaming. Les scores de cette section restent
  // hauts par defaut (80+) sauf probleme technique objectif (clipping,
  // mono cassee, etc.). Le ponderage backend (poids 0.5) achevera de
  // neutraliser l impact sur le globalScore.
  //
  // Mode 'master' : l artiste declare un master pret pour streaming.
  // Comportement historique : LUFS / LRA / True Peak comptent a plein,
  // les scores reflètent les standards streaming, et la section pese 2
  // dans le globalScore.
  const isMixUpload = uploadType === 'mix';
  const uploadTypeBlock = `

TYPE DE FICHIER UPLOADE : ${isMixUpload ? 'MIX (en cours, pas encore masterise)' : 'MASTER (pret pour publication / streaming)'}
${isMixUpload ? `
L artiste declare envoyer un MIX, pas un master. Calibre la section MASTER & LOUDNESS en consequence :
- Reste INFORMATIF, pas normatif. Le mix n est pas cense etre a sa loudness finale (LUFS streaming, True Peak -1 dBTP, LRA cible) — ne reproche PAS d etre sous la cible streaming, ne reproche PAS d avoir 6 dB de headroom, ne reproche PAS un LRA large.
- Items et "how" basculent en checks PRE-MASTER : laisser de la marge (idealement -6 a -3 dBFS sur le bus master, peaks sous 0), verifier l absence de clipping intersample, controler la mono compat, valider l equilibre spectral global. PAS de "monter de X dB pour atteindre -10 LUFS" ni de "mettre un limiter ceiling -1 dBTP en sortie" : c est le job du mastering, pas du mix.
- SCORES section master/loudness : score bas (sous 70) UNIQUEMENT en cas de probleme technique objectif qui fera echouer le mastering : clipping deja inscrit dans les samples, mono cassee (correlation < 0.2), desequilibre L/R majeur, distorsion non voulue audible, masquage frequentiel grave. Ces problemes-la, oui, doivent etre corriges AVANT d envoyer au mastering.
- Le summary peut mentionner "le titre est pret a partir au mastering" / "il y a encore X a reprendre avant de l envoyer au mastering". Pas de mention de "la sortie" / "le streaming" / "la publication" — l etape suivante c est le mastering.
` : `
L artiste declare envoyer un MASTER pret pour streaming.
- La QUALITE DU MASTER (artisanat, equilibre spectral, dynamique, image stereo, integration des elements) est notee normalement selon l ECHELLE GLOBALE OBLIGATOIRE ci-dessous.
- L ADEQUATION AU STREAMING (loudness vs cible plateforme, True Peak vs ceiling -1 dBTP) n EST PAS un critere de qualite de master pour le scoring. C est une question d usage final, portee EXCLUSIVEMENT par le verdict "pret a publier" / "verifications avant publication" dans le summary.
- Concretement : un master au standard old-school a -16 LUFS qui sonne reference sur le craft (basse serree, voix portee, image large, dynamique respiree) merite un score haut sur la section MASTER & LOUDNESS (LRA et image stereo notes sur leur valeur intrinseque). La question loudness sera traitee dans le summary du verdict : "Ce master sonne reference mais necessite un gain master de +X dB avant publication streaming pour tenir face a la concurrence en lecture normalisee."
- Recettes "how" en cibles publication restent valides : "remonter le bus master de X dB pour atteindre -10 LUFS", "limiter ceiling -1 dBTP". Mais ces recettes ne plombent PAS le score de la section.
- INTERDIT : generer un item MED sur le motif "loudness sous la cible streaming", "LRA serre pour le genre", "dynamique trop comprimee pour rivaliser sur Spotify". Ces motifs vont dans le summary, jamais dans un item.score.
- Le summary peut parler de "pret a sortir" / "encore X a reprendre avant publication".
`}

ECHELLE GLOBALE OBLIGATOIRE (s applique a item.score ET au globalScore) :

  92-98 LOW : item d exception, reference absolue dans son genre.
              Reserve aux cas ou l ecoute emploie un vocabulaire qui ne
              laisse aucune ambiguite ("reference", "exemplaire",
              "chirurgical", "impeccable", "indemodable", "groove
              constant et engageant tout au long du morceau",
              "production d orfevre").

  85-91 LOW : item professionnel confirme. L ecoute fournit au moins
              2-3 validations precises de craft sur cet aspect
              (ex : "voix claire, portee ET intelligible" — trois
              qualites nommees). Une seule qualite generique
              ("bien posee") ne suffit pas.

  78-84 LOW : item correct sans defaut, validation generique de
              l ecoute ("soigne", "bien avance", "bien integre",
              "agreable", "pret a diffuser", "tres bien produit").
              BANDE PAR DEFAUT pour un mix propre dont l ecoute valide
              globalement sans nommer de specificite de craft.

  70-77 LOW : item acceptable mais avec un micro-affinement implicite
              dans l ecoute ("pourrait gagner en", "legerement
              perfectible", "a surveiller", "fourchette haute
              acceptable", "un peu fin", "manque parfois de").

  60-69 MED : defaut mesure (cf. MESURES OBJECTIVES ci-dessus) OU
              observation repetee/insistante dans l ecoute decrivant
              clairement un axe a reprendre.

  Sous 60 HIGH : defaut technique grave ET objectif (clipping inscrit,
                 phase inversee, distorsion non voulue audible,
                 masquage frequentiel critique).

REGLE D OR : ne pas regrouper tout au-dessus de 78. Un mix decrit comme
"tres bien avance" / "presque pret" / "soigne" SANS validation explicite
d un niveau d ingenieur du son confirme appartient a la bande 78-84,
PAS 85+. Le 85+ est reserve aux items pour lesquels l ecoute nomme
specifiquement 2-3 qualites de craft precises.
`;

  // Bloc "master commercial" — active uniquement si 5/6 criteres techniques
  // remplis ET upload_type='master'. Adoucit drastiquement le diagnostic
  // pour qu un titre de standard commercial ne soit pas nitpicke avec des
  // "a reprendre" inventes sur des choix esthetiques pro assumes.
  const commercialMasterBlock = isLikelyCommercialMaster ? `

ANALYSE D'UN MASTER AU STANDARD COMMERCIAL — LENS INDULGENTE OBLIGATOIRE :
Les mesures techniques (LUFS, LRA, True Peak, correlation L/R, mono compat, sibilantes) confirment que ce titre est masterise au niveau d une release commerciale publiee. Score technique : ${commercialScore}/6 criteres remplis. Tu DOIS adapter ton diagnostic — cette regle OVERRIDE l ecoute qualitative sur les observations subjectives :

(1) PRIORITE : cette regle PRIME sur la regle de fer "ECOUTE = SOURCE DE VERITE" pour les OBSERVATIONS QUALITATIVES. Si l ecoute pointe un "defaut" qualitatif sur une zone validee par les mesures (basse, caisse claire, voix, espace), tu REFORMULES cette observation en CHOIX ARTISTIQUE POSITIF dans la fiche. L ecoute reste la verite sur ce qu il y a dans le mix (timbres, elements, sections) mais PAS sur ce qui est "a corriger" — un master publie n a rien a corriger d un point de vue qualitatif.

(2) EXEMPLES CONCRETS de reformulation OBLIGATOIRES :
  * Ecoute : "basse trop presente / boueuse dans le bas-medium"
    -> Fiche : "Basse chaleureuse et ronde, choix de ballade assume qui ancre l harmonie"
    Score : 85+ LOW. PAS DE MED.
  * Ecoute : "caisse claire en retrait / manque de punch"
    -> Fiche : "Snare laidback servant la dynamique emotionnelle, choix de mix intentionnel"
    Score : 85+ LOW. PAS DE MED.
  * Ecoute : "voix lead trop en avant"
    -> Fiche : "Voix portee en premier plan, signature du genre pop/soul/folk-pop"
    Score : 88+ LOW. PAS DE MED.
  * Ecoute : "guitares pourraient gagner en presence"
    -> Fiche : "Guitares dosees avec discretion, laissant la voix et la melodie au premier plan"
    Score : 85+ LOW. PAS DE MED.

(3) Tous les items qualitatifs sont des VALIDATIONS EXPLICITES (score 80+, priority "low"). Le "why" decrit positivement le choix observe en s appuyant sur l ecoute mais reformule. Le "how" se limite a "RAS, conserver tel quel" eventuellement complete par "surveiller en mastering que..." pour signaler les fragilites si remaster.

(4) Un item MED (60-79) n est autorise QUE si une MESURE DSP OBJECTIVE le contredit factuellement :
  - True Peak > -1 dBTP (risque streaming reel)
  - Correlation L/R < 0.4 (probleme stereo mesure)
  - Mono compat > 3.5 LU (perte mono mesuree)
  - Phase inversee detectee
  Pas un item MED ne peut etre genere sur une simple OBSERVATION QUALITATIVE ("manque de", "pourrait", "un peu boueux", "en retrait") meme si l ecoute la mentionne. Sur un master commercial, ces formulations sont REECRITES en validations.

(4-bis) INTERDICTION ABSOLUE de generer un item MED sur les motifs suivants, MEME si le LUFS/LRA sont objectivement loin de la cible streaming moderne :
  - "loudness sous la cible streaming" / "loudness trop bas pour Spotify / Apple Music / etc."
  - "LRA trop ecrase pour le streaming" / "dynamique trop comprimee pour rivaliser"
  - "marge inexploitee" / "headroom inexploite face a la concurrence"
  - "ne tiendra pas en lecture normalisee"
  Raison : le scoring note la QUALITE DU MASTER COMME ARTISANAT (equilibre, dynamique intrinseque, image, integration). La cible loudness streaming est une question d USAGE FINAL qui sera portee EXCLUSIVEMENT par le summary du verdict, jamais par un item.score. Un master old-school a -16 LUFS qui sonne reference doit etre note 88+ sur la section MASTER & LOUDNESS — la question loudness va dans le summary ("necessite un gain master de +X dB avant publication pour tenir face a la concurrence", pas dans un item).

(5) Un item HIGH (≤ 59) est INTERDIT sauf defaut technique grave et objectif (clipping inscrit dans les samples, phase inversee, distorsion non voulue mesuree).

(6) Le summary doit reconnaitre la qualite commerciale du master. Formulations OBLIGATOIRES :
  - "Titre au niveau d une release commerciale publiee" / "production aboutie, prete pour diffusion"
  - "Quelques verifications a faire avant publication" (UNIQUEMENT si True Peak ou mono compat objectif mentionne, OU question d adequation loudness/streaming a noter en complement)
  - JAMAIS : "Deux points a regler / a corriger / a reprendre" (mots INTERDITS dans le summary master commercial)
  - JAMAIS : "avant mastering" (le titre EST masterise)
  - Le summary PEUT mentionner un besoin d ajustement loudness avant publication ("necessite +X dB pour atteindre -10 LUFS face a la concurrence streaming") sans que ca degrade le scoring.

(7) Le globalScore final doit refleter cette realite : un master commercial honnete doit etre 88-95, pas 70-83. Calibre tes scores items en consequence — si tous les items qualitatifs sont a 85+ et seuls 1-2 items techniques DSP sont a 65-75 (uniquement les mesures listees en (4)), le globalScore tombe naturellement dans 88-92.

` : '';

  const systemPrompt = `Tu es ingenieur du son expert. Tu recois:
1. Une ECOUTE qualitative du morceau (JSON) faite par un collegue qui l a vraiment ecoute. C est ta source primaire sur le RESSENTI de CE morceau.
${hasPM ? '2. Des EXTRAITS DE COURS PUREMIX (transcripts d ingenieurs de mix reels) pertinents pour les problematiques evoquees par l ecoute. Tu peux t en inspirer pour ta pensee et ton vocabulaire, mais ne les cite jamais verbatim et ne les attribue pas nominativement.' : ''}${hasAnyDspContent ? `\n3. Des MESURES OBJECTIVES (BPM, tonalite, LUFS, LRA, True Peak${hasStems ? ', mesures par stem voix/drums/bass/other' : ''}${hasStereo ? ', champ stereo (correlation L/R, mid/side, mono compat)' : ''}) calculees sur le fichier audio par un module DSP fiable. Ce sont des verites factuelles a utiliser dans la fiche.` : ''}${uploadTypeBlock}${intentBlock}${genreBlock}${dspBlock}${previousFicheBlock}

Ton role: transformer tout ca en fiche structuree pour ${daw}${isRef ? ', ET un set de conseils de reproduction' : ''}.

REGLES DE FER:
- L ECOUTE est la SOURCE DE VERITE sur le RESSENTI de ce morceau (timbre, intelligibilite, dynamique percue, equilibre). ${hasMetrics ? 'Les MESURES OBJECTIVES listees plus haut (BPM, tonalite, LUFS) sont la source de verite sur les valeurs FACTUELLES du fichier audio — tu DOIS les citer telles quelles dans tes "why"/"summary"/"how" quand c est pertinent. En revanche, n invente AUCUNE autre mesure (pas de "le kick est a 62 Hz", pas de "la voix tape -8 dBFS sur les pics", pas de "crest factor 12 dB") : seules les valeurs explicitement listees plus haut sont mesurees.' : 'Tu n as AUCUNE MESURE DU MORCEAU (pas de BPM mesure, pas de LUFS mesure, pas de tonalite). N INVENTE jamais de valeur mesuree sur CE morceau-ci ("le kick est a 62 Hz", "la voix tape -8 LUFS", "BPM 124" : INTERDIT).'} En revanche, dans le champ "how" de chaque item tu PEUX et tu DOIS donner des VALEURS DE RECETTE GENERIQUES (Hz, dB, Q, ratio, attack/release en ms, GR en dB) qui correspondent a la technique pro typique pour ce type de probleme — ces valeurs sont des recettes connues, pas des mesures du titre.
- NE CONTREDIS PAS l ecoute. Si l ecoute dit "mix instrumental" / vocalBlock instrumental, la categorie VOIX reste vide (items: []).
- COUVERTURE PAR CATEGORIE — REGLE IMPORTANTE : l ecoute fournit un champ "par_categorie" qui couvre les 6 categories canoniques (voix, instruments, basses_kick, drums_percu, spatial_reverb, master_loudness). Pour CHAQUE categorie commentee dans "par_categorie", tu DOIS generer AU MOINS 1 item dans la categorie correspondante de la fiche :
  * Si l observation est globalement positive (rien a corriger) -> item de VALIDATION :
    - Si l element est ABOUTI (score 85+) : "title" en constat positif (ex: "Image stereo coherente", "Caisse claire bien tranchante"), "why" reprend l observation positive de l ecoute, "how" = "RAS, conserver tel quel" + suggestion d affinage optionnelle ("Si tu souhaites pousser X, tu peux..."), "plugin_pick" peut etre un outil de monitoring/verification (Logic Multimeter, FabFilter Pro-Q 4 en analyzer-only, SPAN gratuit) plutot qu un correctif.
    - Si l element est CORRECT mais perfectible (score 80-84) : "title" en constat positif nuance (ex: "Image stereo coherente, marge sur la profondeur"), "why" reprend l ecoute en pointant le micro-axe d affinage observe, "how" propose UNE action concrete chiffree pour gagner les quelques points qui manquent (formulation incarnee : "Pour gagner X, tu peux ...", pas optionnelle), "plugin_pick" correctif. Cas typique : un mix qui tient mais ou un element peut etre legerement repris avant le mastering.
  * Si l observation pointe un probleme -> item CORRECTIF classique : score sous 70, "why" descriptif, "how" avec recette chiffree, "plugin_pick" correctif.
  * EXCEPTION MAJEURE — MODE MASTER COMMERCIAL : si le bloc "ANALYSE D UN MASTER AU STANDARD COMMERCIAL" est present plus bas dans ce prompt (active automatiquement quand les mesures techniques confirment un master au niveau commercial), alors la regle "observation negative -> item correctif sous 70" est ANNULEE pour les observations QUALITATIVES (basse boueuse, caisse claire en retrait, voix trop en avant, etc.). Tu REECRIS ces observations en VALIDATION POSITIVE (score 80+, priority low) comme un choix artistique assume. Seules les MESURES DSP OBJECTIVES (True Peak > -1 dBTP, mono compat > 4 LU, correlation < 0.4, phase inversee) peuvent encore generer un item MED < 70 en mode commercial. Cette exception PRIME sur la regle generale ci-dessus et sur la regle "ECOUTE = SOURCE DE VERITE" pour les observations qualitatives.
  * Si l ecoute mentionne plusieurs choses dans la meme categorie (ex: 1 positif + 1 negatif), tu peux faire 2 items.
- Mapping des cles de "par_categorie" vers les categories canoniques de la fiche :
  * voix -> "VOIX" (icon: voice)
  * instruments -> "INSTRUMENTS" (icon: synths)
  * basses_kick -> "BASSES & KICK" (icon: bass)
  * drums_percu -> "DRUMS & PERCUSSIONS" (icon: drums)
  * spatial_reverb -> "SPATIAL & REVERB" (icon: fx)
  * master_loudness -> "MASTER & LOUDNESS" (icon: lufs)
- Une categorie d elements ne reste VIDE que si "par_categorie" ne dit rien la-dessus (cas typique : voix sur un titre instrumental). Sinon, items vide = item manquant pour l artiste.
- La categorie VOIX inclut aussi bien les leads que les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
${hasPM ? '- Les extraits PureMix t enrichissent la REFLEXION, pas le contenu. Reformule avec tes propres mots. Ne copie pas de phrases. Ne cite pas "PureMix" ni le nom d un ingenieur. Utilise-les pour mieux formuler les techniques, les priorites de mix, les reflexes pros.' : ''}
- Chaque item.why doit s appuyer sur une observation de l ecoute (idealement de "par_categorie").
${isRef ? '- tips = 3-5 conseils concrets pour reproduire ce son dans ' + daw : '- items = couverture des observations de "par_categorie" (1 item de validation OU 1 item correctif par categorie commentee). Tu peux ajouter 1 item supplementaire si "a_travailler" pointe quelque chose de plus precis qui ne tient pas dans le commentaire de "par_categorie".\n- Le "how" et le "plugin_pick" de chaque item doivent porter la recommandation actionnable (recette technique chiffree + plugin precis pour les correctifs ; outil de verification ou note "RAS conserver" pour les validations). Il n y a plus de section "Plan d action" separee : tout passe par les items du diagnostic.'}
- "plugin_pick" doit nommer UN plugin reel adapte au DAW de l utilisateur (${daw}) : soit un plugin stock du DAW (ex: Channel EQ / Compressor / Space Designer dans Logic, Pro EQ / Compressor dans Studio One, ReaEQ / ReaComp dans Reaper, Parametric EQ 2 / Fruity Limiter dans FL Studio, Pro-Q / Pro-C dans Cubase), soit un standard industrie reel (FabFilter Pro-Q 4, FabFilter Pro-C 2, UAD LA-2A, UAD 1176, Waves SSL E-Channel, Waves SSL Bus Compressor, Soothe2, Valhalla VintageVerb, Oeksound Soothe2, etc.). UN seul plugin par item, nom EXACT. N INVENTE PAS de plugin qui n existe pas.
${!isRef ? `- SCHEMA STRICT POUR CHAQUE ITEM de elements[].items — exactement ces champs, pas d autres, pas d objet imbrique : "id" (string format <icon>-<N>), "section" (string egale a la valeur du champ "cat" de la categorie parente : VOIX / INSTRUMENTS / BASSES & KICK / DRUMS & PERCUSSIONS / SPATIAL & REVERB / MASTER & LOUDNESS), "priority" ("high" | "med" | "low", MINUSCULES uniquement), "title" (titre court 4-8 mots), "score" (entier 0-100), "why" (1-2 phrases ancrees sur l ecoute${hasMetrics ? ', avec citation possible des MESURES OBJECTIVES listees plus haut (BPM, tonalite, LUFS) quand elles eclairent le point' : ', sans valeurs mesurees du morceau'}), "how" (string courte avec recette technique CHIFFREE — exemples : "EQ soustractif 200-400 Hz, -3 dB, Q 1.5" / "compression voix 2:1, attack 10-20 ms, release 80-120 ms, 2-4 dB GR" / "de-esser 6-8 kHz, -4 dB GR" / "reverb plate decay 1.8 s, pre-delay 30 ms, mix 12%"), "plugin_pick" (UN plugin reel, voir regle plugin_pick).` : ''}
- summary = COURT (2-3 phrases max, ~40-60 mots). C est un coup d œil, pas une lecture : identite du titre + 1-2 priorites majeures uniquement. Le reste passe par les items du diagnostic — pas de redite. Cible : un fan de musique qui n a JAMAIS touche un mixeur doit comprendre en 5 secondes ou est le titre.

- REGLES STRICTES POUR LE SUMMARY (zero tolerance) :

  (1) AUCUN terme technique d ingenieur son, jamais. Liste noire non exhaustive : True Peak, TruePeak, dBTP, LUFS, LU, LRA, dB, dBFS, Hz, kHz, ceiling, headroom, RMS, crest factor, intersample, clipping, sibilantes, de-esser, de-essing, EQ, equaliseur, compresseur, compression, multibande, ratio, attaque, release, side-chain, mid/side, mono compat, mono compatibility, gain staging, masking, masquage frequentiel, transitoires, pumping, bus, mix bus, master bus, low-cut, high-pass, low-shelf, fondamentale, harmonique. Si le mot vient du jargon d un ingenieur son, il ne va PAS dans le summary.

  (2) AUCUNE recette, AUCUNE valeur cible, AUCUN nom d outil. Pas de "-1 dBTP", pas de "+3 dB", pas de "compresser a 2:1", pas de "limiter", pas de "EQ", pas de "saturator". Les recettes vivent dans items[].how, JAMAIS dans le summary. Le summary pointe le souci ("a reprendre avant diffusion", "a reverifier en mono telephone"), il ne dicte AUCUNE solution technique.

  (3) Tout est traduit en sensation d ecoute ou impact concret. Exemples de traduction obligatoires :
    * "voix bien posee, devant le mix" et NON "delta +2 LU" / "voix +2 LU au dessus de l instru"
    * "le titre frole la saturation, risque de craquer sur Spotify ou Apple Music — a reprendre avant diffusion" et NON "True Peak >0 dBTP, clipping intersample, ceiling a -1 dBTP"
    * "le titre est compresse serre, il gagnerait a respirer un peu plus" et NON "LRA 2.9 LU, dynamique ecrasee"
    * "perd de la presence quand on l ecoute sur telephone ou enceinte Bluetooth" et NON "perte mono 3.6 LU, mono compat degradee"
    * "guitare lead un peu trop brillante, fatigue l oreille sur la duree" et NON "exces 2-4 kHz, sibilantes a -25 dB"
    * "le lead synthe manque un peu de presence pour s imposer dans les sections denses" reste OK (vocabulaire mainstream, c est valide)

  (4) Test mental obligatoire : si tu retires les termes interdits (1) et les recettes (2) et qu il ne reste plus rien d intelligible, c est que tu n as pas traduit — recommence. Le summary doit fonctionner SANS aucun chiffre ni jargon.

  (5) AUCUNE classification de genre catégorique dans le summary. Pas de "titre pop-rock", pas de "morceau indie folk", pas de "production électro/lo-fi", pas de "track hip-hop boom-bap", etc. Tu n as PAS la mission de poser une étiquette de genre — tu peux te tromper, et un mauvais étiquetage décrédibilise toute l analyse aux yeux de l artiste. Décris l effet du titre (groove, énergie, atmosphère, instrumentation perçue), pas son genre. Adjectifs descriptifs OK ("entraînant", "atmosphérique", "intimiste", "dansant", "feutré") ; étiquette de genre PAS OK. Si l intention déclarée par l artiste mentionne un genre, tu peux le réutiliser textuellement (c est sa déclaration), sinon abstiens-toi.
- INTERDIT aussi de simuler une relation humaine: pas de "merci", "content de t entendre", "j adore", ni aucune marque d emotion personnelle. Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — l IA observe, elle ne ressent rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour", "chapeau"). Reconnaitre qu un titre est un classique/standard reste autorise, et les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres dans une observation. Reste un collegue ingenieur qui brief, pas un ami qui fait des compliments.

REGLE IDS (obligatoire):
- Chaque item de elements[].items DOIT avoir un champ "id" unique au format "<icon>-<N>", ou <icon> est la valeur du champ "icon" de la categorie parente et <N> un entier qui commence a 1 et s incremente PAR categorie. Exemples: "voice-1", "voice-2", "bass-1", "drums-1", "lufs-1".

${!isRef ? `REGLE SCORES (obligatoire en mode diagnostic):
- Chaque item de elements[].items DOIT avoir un champ "score" (entier de 0 a 100) qui evalue l etat actuel de cet aspect du mix.
- Bareme calibre (ni trop severe, ni trop complaisant):
  - 0-30 : probleme majeur qui empeche le titre de fonctionner (voix inaudible, basse qui masque tout, master destructif).
  - 40-50 : defaut audible clair, a traiter pour passer a l etape suivante.
  - 60-70 : correct, pro mais pas encore convaincant, dernieres finitions.
  - 80-90 : tres bon niveau, commercialement defendable.
  - 100 : reference absolue. RARE. Seulement si l ecoute est dithyrambique.
- Ancre les scores STRICTEMENT sur ce que dit l ecoute. Un item existe parce que l ecoute a observe quelque chose : son score reflete ce verdict.
- Evite les scores tous identiques. Si l ecoute distingue forces et faiblesses, les scores doivent le refleter.

REGLE SEVERITE (priority) — STRICTE, NON-NEGOCIABLE:
La sevérité d un item DOIT etre deterministe et liee au score. Tu ne choisis JAMAIS la severite au feeling :

(1) Score impose la severite (correspondance obligatoire, aucune exception) :
  - score >= 85         -> priority: "low"   PASSIF (validation pleine — element abouti, on conserve)
  - score 80-84         -> priority: "low"   ACTIF  (element correct mais perfectible — il existe UN levier concret pour aller chercher quelques points de plus)
  - score 60-79         -> priority: "med"   (a reprendre, mais le mix tient)
  - score < 60          -> priority: "high"  (a corriger avant l etape suivante)
  Si tu hesites entre 2 severites, c est que le score n est pas cale : ajuste le score, pas la severite.

  REGLE DE FORMULATION DU "how" SELON LA SEVERITE :
  - LOW PASSIF (score >= 85) : "how" = "RAS, conserver tel quel" eventuellement complete par une suggestion d affinage optionnelle introduite par "Si tu souhaites...".
  - LOW ACTIF (score 80-84) : "how" propose UNE action concrete chiffree (Hz, dB, Q, ratio, ms) qui peut faire grimper cet element vers 85+. La formulation est incarnee et engageante ("Pour gagner X, tu peux ..."), pas optionnelle ni hypothetique. Pas de "RAS" sur un LOW ACTIF. C est un vrai levier d affinage que l artiste peut tester. Le "plugin_pick" reste correctif (pas un outil de monitoring).
  - MED (60-79) : "how" = action recommandee, recette chiffree, plugin correctif.
  - HIGH (<60) : "how" = action corrective forte, recette chiffree, plugin correctif.

(2) Quand une MESURE DSP existe, elle impose la fourchette de score (et donc la severite) :
  - Mono compat > 4 LU       -> score 60-70, priority "med" (perte mono importante, audible sur telephone/Bluetooth)
  - Mono compat 3-4 LU       -> score 70-78, priority "med" OBLIGATOIRE (perte mono notable, item correctif chiffre — meme sur un mix par ailleurs sain)
  - Mono compat 2-3 LU       -> score 78-84, priority "low"  ACTIF (perte mono presente mais acceptable, levier d affinage chiffre)
  - Mono compat <= 2 LU      -> score 85+,   priority "low"  PASSIF
  REGLE: la decision MED/LOW sur mono compat doit etre PILOTEE PAR LA MESURE, jamais par l ecoute seule. Si la mesure reste dans la meme zone d une version a l autre, l item DOIT garder la meme severite (stabilite inter-version).
  - True Peak > 0 dBTP       -> score <= 50, priority "high" (clipping certain sur encodeurs lossy)
  - True Peak -1 a 0 dBTP    -> score 65-75, priority "med"
  - True Peak <= -1 dBTP     -> score 85+,   priority "low"
  - Correlation L/R < 0.2    -> priority "high" (risque de phase reel)
  - Delta voix/instru entre -3 et +5 LU -> "voix bien posee" : score 80+, priority "low". Cette fourchette englobe les masters commerciaux pop/folk-pop (delta typique +4 a +5 LU). L item peut quand meme exister en MED si l ecoute pointe un probleme de TIMBRE (presence, congestion, brillance), mais JAMAIS un probleme de NIVEAU dans cette fourchette.
  - Delta voix/instru entre +5 et +9 LU -> classer SELON L ECOUTE, pas selon le seuil seul : si l ecoute valide la voix ("bien posee", "intelligible", "presente"), c est un CHOIX ARTISTIQUE legitime (pop/rock dense, dance, hip-hop) : score 78-85, priority "low". MED 60-75 UNIQUEMENT si l ecoute signale explicitement un detachement perceptif (mots "decrochee", "detachee", "agressive", "artificielle"). PAS DE HIGH sur ce delta seul.
  - Delta voix/instru < -3 LU OU > +9 LU OU ecoute explicite "voix decrochee/detachee" -> score <= 65, priority "high"
  - Sibilantes 5-8 kHz > -25 dB        -> score <= 70, priority "med" minimum

(3) Pas d invention HIGH sans signal :
  Si l ecoute valide une categorie (par_categorie positif, ex: "kick et basse solides, fondation tenue") ET qu aucune mesure DSP ne pointe un probleme dans cette zone, tu NE PEUX PAS inventer un item HIGH depuis ta seule deduction. La categorie reste validee (item LOW score 80+). Cas typique a eviter : inferer "kick masque par la basse" alors que l ecoute parle d une fondation solide et qu il n y a pas de mesure de masquage disponible.

(4) Coherence interne :
  - Pas 2 items "high" dans la meme categorie, sauf si l ecoute pointe explicitement DEUX defauts distincts.
  - Le summary mentionne en priorite les items "high", puis "med" si pas de high, JAMAIS les items "low".

REGLE CRITIQUE — CHOIX ARTISTIQUES vs DEFAUTS TECHNIQUES:
- Distingue TOUJOURS les defauts techniques objectifs (saturation non voulue, desequilibre frequentiel, masquage, artefacts) des choix artistiques potentiellement voulus (fin abrupte, arrangement minimal, distorsion creative, structure non conventionnelle, absence d intro/outro, repetition voulue).
- Un choix artistique ne doit JAMAIS etre penalise dans le score comme un defaut. Si l ecoute releve quelque chose qui POURRAIT etre un choix delibere (fin abrupte, arrangement atypique, mix lo-fi, etc.), tu peux le mentionner comme suggestion/alternative dans le "why", mais le score doit rester neutre ou positif (70+). Formule-le comme "Si c est voulu, c est un parti pris defendable. Sinon, on pourrait envisager..." et non comme une erreur a corriger.
- Seuls les problemes techniques objectifs (equilibre spectral, dynamique, nettete, separation des sources, artefacts) justifient un score bas.
- En cas de doute sur l intentionnalite, presume que c est voulu et note en consequence.${hasIntent ? ' L INTENTION DECLAREE en debut de prompt leve deja le doute sur plusieurs aspects : respecte-la.' : ''}

- Champ "globalScore" (entier 0-100) au niveau racine : evaluation globale du mix. Ce n est PAS forcement la moyenne des items. Un mix avec quelques items faibles peut rester a 70 si l essentiel fonctionne. Fais ton jugement en cherchant a refleter l impression generale de l ecoute.
` : ''}${commercialMasterBlock}
- Reponds UNIQUEMENT en JSON valide. Pas de markdown, pas de backticks.`;

  const prompt = `ECOUTE QUALITATIVE (source primaire):
${listeningStr}

${hasPM ? `EXTRAITS PUREMIX (contexte d ingenieurs de mix, pour enrichir ta reflexion):
${pmContext}
` : ''}MORCEAU: "${title}"${artist ? ' — ' + artist : ''}
DAW utilisateur: ${daw}
MODE: ${isRef ? 'reference a reproduire' : 'diagnostic de mix perso'}${hasIntent ? `
INTENTION DECLAREE: "${intentStr}"` : ''}${hasAnyDspContent ? `
MESURES OBJECTIVES :${mBpm ? ` BPM=${mBpm}` : ''}${mKey ? ` · Tonalite=${mKey}` : ''}${mLufs != null ? ` · LUFS=${mLufs}` : ''}${mLra != null ? ` · LRA=${mLra} LU` : ''}${mTruePeak != null ? ` · TruePeak=${mTruePeak} dBTP` : ''}${voiceVsInstruDelta != null ? ` · Voix vs instru=${voiceVsInstruDelta > 0 ? '+' : ''}${voiceVsInstruDelta} LU` : ''}${sibilantsBand != null ? ` · Sibilantes(5-8k)=${sibilantsBand} dB` : ''}${mCorr != null ? ` · CorrL/R=${mCorr}` : ''}${mMonoCompat != null ? ` · MonoCompat=${mMonoCompat > 0 ? '+' : ''}${mMonoCompat} LU` : ''}
↳ Cite ces valeurs textuellement dans tes "why"/"how" quand elles eclairent un point. Le summary, lui, ne cite JAMAIS de valeur mesuree brute — il traduit l impact en sensation d ecoute. En MASTER, calibre sur LUFS/LRA/TruePeak.${hasStems ? ' En VOIX, calibre sur le delta voix/instru et les sibilantes mesurees.' : ''}${hasStereo ? ' En SPATIAL, calibre sur correlation L/R et mono compat.' : ''} N invente AUCUNE autre mesure.` : ''}

Produis le JSON de fiche en suivant exactement cette structure (conserve les "cat" et "icon", varie uniquement le contenu des items${!isRef ? ', les scores et le globalScore' : ''}):

${isRef ? refTemplate : persoTemplate}

Rappel: ${isRef ? 'categories vides autorisees uniquement si "par_categorie" est vide ou absent.' : 'genere AU MOINS 1 item par categorie commentee dans "par_categorie" (validation si rien a corriger, correctif sinon). Une categorie ne reste vide que si "par_categorie" n a rien dit dessus (typiquement: voix sur un titre instrumental). Scores ancres dans le verdict de l ecoute.'} Reprends le ton et le verdict de l ecoute dans le summary.${hasPM ? ' Inspire-toi des extraits PureMix pour affiner la formulation, sans jamais les citer.' : ''}${hasIntent ? ' Tiens compte de l intention declaree : les choix qui en decoulent ne sont pas des defauts.' : ''}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === 'AbortError') throw new Error('Analysis API: timeout (120s)');
    throw fetchErr;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[claude] API error:', res.status, body.slice(0, 300));
    throw new Error('Analysis API: ' + res.status);
  }

  const data = await res.json();
  _recordUsage(data.usage, 'fiche');
  let text = data.content[0].text.trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON in response');

  let depth = 0, end = -1, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end === -1) {
    console.warn('[claude] JSON truncated, attempting repair...');
    let repair = text.slice(start);
    repair = repair.replace(/,\s*"[^"]*":\s*"[^"]*$/, '');
    repair = repair.replace(/,\s*"[^"]*$/, '');
    const openBraces = (repair.match(/\{/g) || []).length - (repair.match(/\}/g) || []).length;
    const openBrackets = (repair.match(/\[/g) || []).length - (repair.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets; i++) repair += ']';
    for (let i = 0; i < openBraces; i++) repair += '}';
    text = repair;
  } else {
    text = text.slice(start, end + 1);
  }

  // Pre-repair de glitches connus de generation JSON par Claude.
  // Cas observe en prod (jobId irii2vibzwmohdlyev) : "score">60 au lieu de "score":60.
  // On cible UNIQUEMENT le pattern "clef">nombre (ne touche pas aux strings, qui
  // contiendraient des lettres/espaces avant le >). Idem pour "clef"=valeur si jamais.
  const repairedText = text
    .replace(/("\w+")\s*>\s*(-?\d)/g, '$1:$2')
    .replace(/("\w+")\s*=\s*(-?\d)/g, '$1:$2');
  if (repairedText !== text) {
    console.warn('[claude] applied JSON glitch repair (operator-instead-of-colon)');
    text = repairedText;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('[claude] parse error:', e.message, text.slice(0, 500));
    throw new Error('JSON invalide: ' + e.message);
  }

  // On expose l intention utilisee dans la fiche pour que le front puisse
  // l afficher tel quel (badge "Intention declaree : ...") sans avoir a re-requeter.
  if (hasIntent) parsed.intent_used = intentStr;

  // Genre musical : on garantit la coherence cote backend (pas dependant
  // de Claude qui pourrait oublier de re-emettre un champ).
  // - declare : on force la valeur saisie par l artiste, peu importe ce que Claude a fait.
  // - infere : on garde ce que Claude a emis (genre court ≤ 3 mots), avec un fallback null si absent.
  if (hasDeclaredGenre) {
    parsed.declared_genre = declaredGenreStr;
    parsed.genre_inferred_by_ai = false;
    delete parsed.inferred_genre; // safety : si Claude a quand meme infere, on ignore (le declare prime)
  } else if (shouldInferGenre) {
    parsed.genre_inferred_by_ai = true;
    if (typeof parsed.inferred_genre !== 'string' || !parsed.inferred_genre.trim()) {
      parsed.inferred_genre = null; // Claude a oublie d emettre le champ — on degrade proprement
    } else {
      parsed.inferred_genre = parsed.inferred_genre.trim().slice(0, 60);
    }
    parsed.declared_genre = null;
  } else {
    // Aucun signal genre (ni declare, ni demande d inference) : on s assure que les champs sont absents/nuls.
    parsed.declared_genre = null;
    parsed.genre_inferred_by_ai = false;
    parsed.inferred_genre = null;
  }

  // Garde-fou ids/scores/globalScore, puis caps mecaniques DSP
  // (calibration 2026-05-20, cf. lib/scoring/mechanicalCaps.js), puis
  // plancher de score (ticket 4.1) et verrou des sub-scores avec items
  // coches (ticket 4.2).
  // uploadType propage pour que la ponderation master/loudness suive le
  // toggle Mix/Master (refonte 2026-04-30).
  let normalized = normalizeIds(parsed, uploadType);
  const capsSignals = {
    mCorr,
    mLra,
    mTruePeak,
    voiceVsInstruDelta,
    sibilantsBand,
    presenceBand,
  };
  ({ fiche: normalized } = applyMechanicalCaps(normalized, capsSignals, uploadType));
  normalized = applyScoreFloor(normalized, previousFiche);
  normalized = applyAdviceLock(normalized, previousFiche, previousCompletions);
  return normalized;
}

// ─────────────────────────────────────────────────────────────
// generateEvolution — suivi inter-versions.
// Recoit l ecoute + fiche d une version precedente (prev) et
// celles de la nouvelle version (curr), et produit un objet
// structure des evolutions destine au "bandeau evolution"
// affiche au-dessus de la fiche.
//
// Output JSON :
//   {
//     "resume":      "string (1 phrase, ~90 chars max)",
//     "progres":     ["string court", ...],   // 0-4
//     "regressions": ["string court", ...],   // 0-4
//     "persistants": ["string court", ...],   // 0-4
//     "nouveaux":    ["string court", ...],   // 0-4 — points apparus en V2
//     "dominante":   "progres" | "regressions" | "neutre"
//   }
//
// IMPORTANT : si l ecoute V1 ou V2 est vide, on renvoie un objet
// neutre plutot que de halluciner — la comparaison n a pas de
// fondement.
// ─────────────────────────────────────────────────────────────
async function generateEvolution(prev, curr, intent, locale) {
  const isFr = (locale || 'fr').toLowerCase().startsWith('fr');
  // Garde-fous : si l ecoute manque d un cote, pas d evolution exploitable.
  if (!prev || !curr || !prev.listening || !curr.listening) {
    return null;
  }

  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const intentStr = hasIntent ? intent.trim() : '';

  // Compaction des fiches : on ne garde que ce qui sert a la comparaison
  // (title, score, why) pour limiter la taille du prompt.
  const compactFiche = (f) => {
    if (!f || !Array.isArray(f.elements)) return null;
    return {
      globalScore: typeof f.globalScore === 'number' ? f.globalScore : null,
      summary: typeof f.summary === 'string' ? f.summary : '',
      elements: f.elements.map((el) => ({
        cat: el.cat,
        items: (el.items || []).map((it) => ({
          title: it.title,
          score: typeof it.score === 'number' ? it.score : null,
          why: typeof it.why === 'string' ? it.why.slice(0, 240) : '',
        })),
      })),
    };
  };

  const prevPack = {
    listening: prev.listening,
    fiche: compactFiche(prev.fiche),
  };
  const currPack = {
    listening: curr.listening,
    fiche: compactFiche(curr.fiche),
  };

  const intentBlock = hasIntent ? `

INTENTION ARTISTIQUE DECLAREE PAR L ARTISTE (vaut pour les deux versions sauf mention contraire):
"${intentStr}"

Une evolution qui rapproche de cette intention est un PROGRES, meme si elle peut sembler etre un defaut hors contexte. Une evolution qui s en eloigne est une REGRESSION.
` : '';

  const systemPrompt = `Tu es ingenieur du son. Tu recois DEUX ECOUTES qualitatives du MEME morceau a deux moments differents (V_PRECEDENTE puis V_NOUVELLE) ainsi que les diagnostics correspondants. Ta tache : produire un SUIVI court et factuel des evolutions entre les deux versions, destine a etre affiche dans un bandeau discret au-dessus de la fiche de la nouvelle version.${intentBlock}

REGLES DE FER :
- Tu ne mesures rien (pas de LUFS, pas de BPM, pas de Hz). Tu compares ce que les deux ecoutes decrivent et ce que les scores reflètent.
- N invente RIEN. Si une zone n est pas evoquee dans les deux ecoutes, tu n en parles pas.
- Si l evolution est nulle ou minime, les listes peuvent etre vides. NE FABRIQUE pas de progres pour remplir.
- Items courts : une phrase, ~70 caracteres max, ${isFr ? 'francais' : 'anglais'} naturel et direct, pas de jargon obscur.
- Resume : UNE phrase ~90 caracteres max qui synthetise la dominante (ex : ${isFr ? '"Voix plus claire mais basse en retrait, moins d air dans le haut."' : '"Voice clearer but bass pulled back, less air up top."'}).
- Distingue : progres (mieux qu avant), regressions (moins bien qu avant), persistants (point deja note en V_PRECEDENTE et toujours present), nouveaux (apparu en V_NOUVELLE et absent de V_PRECEDENTE).
- "dominante" : "progres" si plus de progres que de regressions, "regressions" si l inverse, "neutre" sinon.
- INTERDIT : ton relationnel ("bravo", "tu as bien progresse", "j adore", "j ai aime", "j ai pris plaisir"), tape sur l epaule, simulation d emotion. Tu es un collegue ingenieur qui brief, factuel.
- INTERDIT : le mot "chantier" — prefere "ajustement", "axe", "levier".
- INTERDIT : citer une marque de plugin ou un artiste/album hors de ce que dit l ecoute.
- Si V_PRECEDENTE et V_NOUVELLE racontent en realite deux morceaux differents (longueurs/ambiances tres ecartees), renvoie un resume neutre du type ${isFr ? '"Comparaison limitee : les deux versions semblent traiter deux passages differents."' : '"Comparison limited: the two versions seem to cover different passages."'} et des listes vides.

Reponds UNIQUEMENT en JSON valide ${isFr ? 'en francais' : 'en anglais'}, sans markdown, sans backticks :
{
  "resume": "string",
  "progres": ["string", ...],
  "regressions": ["string", ...],
  "persistants": ["string", ...],
  "nouveaux": ["string", ...],
  "dominante": "progres" | "regressions" | "neutre"
}`;

  const prompt = `V_PRECEDENTE :
${JSON.stringify(prevPack, null, 2)}

V_NOUVELLE :
${JSON.stringify(currPack, null, 2)}

Produis le JSON de suivi en suivant exactement le schema ci-dessus. Pas de markdown.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === 'AbortError') throw new Error('Evolution API: timeout (60s)');
    throw fetchErr;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[evolution] API error:', res.status, body.slice(0, 300));
    throw new Error('Evolution API: ' + res.status);
  }

  const data = await res.json();
  _recordUsage(data.usage, 'evolution');
  let text = (data.content[0].text || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[evolution] no JSON in response');
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    console.error('[evolution] parse error:', e.message);
    return null;
  }

  // Normalisation defensive : on garantit la forme et les bornes (max 4 items
  // par liste, strings non vides) pour proteger l UI.
  const cleanList = (arr) =>
    Array.isArray(arr)
      ? arr.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 4)
      : [];
  const dom = ['progres', 'regressions', 'neutre'].includes(parsed.dominante) ? parsed.dominante : 'neutre';

  return {
    resume: typeof parsed.resume === 'string' ? parsed.resume.trim().slice(0, 200) : '',
    progres: cleanList(parsed.progres),
    regressions: cleanList(parsed.regressions),
    persistants: cleanList(parsed.persistants),
    nouveaux: cleanList(parsed.nouveaux),
    dominante: dom,
  };
}

// chat — appel Anthropic pour le drawer chat de fiche.
//
// Signature historique : retourne UNE STRING (le texte de la réponse).
// Préservée pour les autres callers (api/_ask.js, _translate.js, _compare.js,
// _mastering_charter.js) qui attendent une string.
//
// system peut être :
//   - une string (rétrocompat, pas de caching)
//   - un Array<{ type: 'text', text: string, cache_control?: { type: 'ephemeral' } }>
//     (mode caching activé : marquer les blocs statiques avec cache_control)
//
// Pour récupérer aussi l'usage (cf. api/_chat.js qui en a besoin pour
// logChatCost et l'admin dashboard), utiliser chatWithUsage() ci-dessous.
// opts (optionnel) :
//   - maxTokens : override de max_tokens (default 800). Indispensable pour
//     les payloads volumineux (ex. /translate : fiche complète JSON ≫ 800
//     tokens en sortie → réponse tronquée → JSON invalide → 500).
//   - model : override du modèle (default constante MODEL = Sonnet).
//     Utilisé par /translate pour basculer sur Haiku (3-4× plus rapide,
//     largement suffisant pour de la traduction sous contraintes).
async function chat(messages, system, opts) {
  const { reply } = await chatWithUsage(messages, system, opts);
  return reply;
}

// chatWithUsage — variante qui retourne { reply, usage, model } pour les
// callers qui ont besoin de tracker le coût. Sinon identique à chat().
//
// usage contient input_tokens, output_tokens, et si caching activé,
// cache_creation_input_tokens et cache_read_input_tokens.
async function chatWithUsage(messages, system, opts) {
  const modelToUse = (opts && opts.model) || MODEL;
  const maxTokensToUse = (opts && opts.maxTokens) || 800;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: modelToUse, max_tokens: maxTokensToUse, system, messages }),
  });
  if (!res.ok) throw new Error('Chat API: ' + res.status);
  const data = await res.json();
  _recordUsage(data.usage, 'chat');
  return {
    reply: data.content[0].text,
    usage: data.usage || {},
    model: data.model || modelToUse,
  };
}

module.exports = { generateFiche, chat, chatWithUsage, formulatePerception, generateEvolution, resetUsage, getUsage, MODEL };
