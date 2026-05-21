// lib/dsp.js
// Mesures DSP sur le master via ffmpeg ebur128 (conforme ITU-R BS.1770).
// Retourne LUFS intégré, LRA (Loudness Range) et True Peak — les 3 mesures
// objectives standard de l'industrie pour qualifier un master.
//
// Branche en parallèle de Fadr et Gemini dans le pipeline d'analyse
// (versions-api/api/analyze.js). Mode dégradé : retourne null si ffmpeg
// échoue ou timeout, le pipeline continue sans casser.

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { spawn } = require('child_process');

const TIMEOUT_MS = 60_000; // 60s max — un WAV 4 min se mesure en ~10-20s

/**
 * Calcule LUFS / LRA / True Peak d'un buffer audio via ffmpeg ebur128.
 * @param {Buffer} buffer audio (WAV/MP3/FLAC/etc., n'importe quel format
 *                        supporté par ffmpeg).
 * @returns {Promise<{ lufs: number|null, lra: number|null, truePeak: number|null }|null>}
 *          null si ffmpeg KO ou timeout (mode dégradé).
 */
function measureMaster(buffer) {
  return new Promise((resolve) => {
    if (!buffer || !buffer.length) {
      console.warn('[dsp] empty buffer');
      return resolve(null);
    }

    const t0 = Date.now();
    // -i pipe:0   : on lit le buffer depuis stdin
    // -af ebur128=peak=true : filter ITU-R BS.1770 + détection true peak
    // -f null -   : on jette la sortie audio, on ne veut que les stats stderr
    // -nostats    : moins de bruit dans stderr (on garde le summary final)
    const args = [
      '-hide_banner',
      '-nostats',
      '-i', 'pipe:0',
      '-af', 'ebur128=peak=true',
      '-f', 'null',
      '-',
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath, args);
    } catch (e) {
      console.error('[dsp] spawn error:', e.message);
      return resolve(null);
    }

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[dsp] timeout ${TIMEOUT_MS / 1000}s, killing ffmpeg`);
      try { proc.kill('SIGKILL'); } catch {}
    }, TIMEOUT_MS);

    proc.stdin.on('error', (e) => {
      // EPIPE possible si ffmpeg ferme stdin tôt — non bloquant
      if (e.code !== 'EPIPE') console.warn('[dsp] stdin error:', e.message);
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.error('[dsp] proc error:', e.message);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(null);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (code !== 0) {
        console.warn(`[dsp] ffmpeg exit ${code} in ${elapsed}s, last stderr: ${stderr.slice(-300)}`);
        return resolve(null);
      }
      const parsed = parseEbur128(stderr);
      console.log(`[dsp] master measured in ${elapsed}s — lufs:${parsed.lufs} lra:${parsed.lra} truePeak:${parsed.truePeak}`);
      resolve(parsed);
    });

    // Pipe buffer dans stdin
    try {
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch (e) {
      console.warn('[dsp] write error:', e.message);
    }
  });
}

/**
 * Parse la sortie stderr de ffmpeg ebur128 pour extraire les valeurs finales
 * du bloc "Summary:". Format ffmpeg :
 *
 *   [Parsed_ebur128_0 @ ...] Summary:
 *
 *     Integrated loudness:
 *       I:         -8.6 LUFS
 *       Threshold: -19.6 LUFS
 *
 *     Loudness range:
 *       LRA:         6.4 LU
 *
 *     True peak:
 *       Peak:       -0.3 dBFS
 *
 * On prend le DERNIER "Summary:" (lastIndexOf) car ffmpeg peut en émettre
 * plusieurs si plusieurs filtres ebur128 sont chaînés (rare mais possible).
 */
function parseEbur128(stderr) {
  const sumIdx = stderr.lastIndexOf('Summary:');
  const block = sumIdx >= 0 ? stderr.slice(sumIdx) : stderr;

  const findFloat = (re) => {
    const m = block.match(re);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const rawLufs = findFloat(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);

  // ─── Garde-fou LUFS aberrant (2026-05-21) ─────────────────────────
  // ffmpeg ebur128 peut sortir des valeurs absurdes (-70 LUFS, +20 LUFS,
  // etc.) sur certains fichiers — silence long en début, encodage exotique,
  // durée trop courte pour le gating ITU-R BS.1770, header corrompu.
  // Plage musicale réaliste : [-40, +1] LUFS. Hors borne → null (mode
  // dégradé). Le pipeline downstream (claude.js, scoring) gère déjà
  // gracieusement un LUFS null (recettes mastering qualitatives, pas de
  // verdict normatif). Mieux vaut une mesure absente qu'une mesure fausse
  // qui plombe le scoring (cf. cas serrurerie.rayan : -70.0 LUFS → score 52).
  let lufs = rawLufs;
  if (lufs != null && (lufs < -40 || lufs > 1)) {
    console.warn(`[dsp] LUFS aberrant détecté: ${lufs} — bascule en null (mode dégradé). Plage attendue [-40, +1].`);
    lufs = null;
  }

  return {
    lufs,
    lra: findFloat(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/),
    // Selon la version de ffmpeg, le label peut être "Peak:" ou "True peak max:"
    truePeak: findFloat(/(?:True peak[\s\S]*?(?:Peak|max):|Peak:)\s*(-?\d+(?:\.\d+)?)\s*dB/),
  };
}

/**
 * DSP_PLAN B.2 — mesure DSP par stem.
 * Calcule {lufs, truePeak, peak, energyBand_5_8kHz, energyBand_1_3kHz} pour
 * un stem (vocal/drums/bass/other). Les bandes 1-3 kHz et 5-8 kHz sont
 * spécifiquement pertinentes pour le stem voix (présence + sibilantes) ;
 * sur les autres stems elles servent de proxy énergétique.
 *
 * Stratégie : un seul ffmpeg par mesure (3 ffmpeg total : ebur128 + 2 bandpass).
 * Lancés en parallèle via Promise.all. Mode dégradé champ par champ : si une
 * mesure échoue, son champ est null mais les autres restent valides.
 *
 * @param {Buffer} buffer — audio du stem (n'importe quel format ffmpeg)
 * @param {string} [label] — étiquette pour les logs (ex. "vocal", "drums")
 * @returns {Promise<{lufs, truePeak, peak, energyBand_5_8kHz, energyBand_1_3kHz}|null>}
 */
async function measureStem(buffer, label = 'stem') {
  if (!buffer || !buffer.length) {
    console.warn(`[dsp.measureStem:${label}] empty buffer`);
    return null;
  }
  const t0 = Date.now();
  const [master, sibilants, presence] = await Promise.all([
    measureMaster(buffer),                                // lufs + lra + truePeak
    measureBandEnergy(buffer, 6500, 3000, `${label}/5-8k`), // 5-8 kHz : sibilantes
    measureBandEnergy(buffer, 2000, 2000, `${label}/1-3k`), // 1-3 kHz : présence
  ]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = {
    lufs: master?.lufs ?? null,
    // LRA n'a pas vraiment de sens sur un stem isolé (souvent < 1s d'air),
    // on l'omet du résultat. Conservé sur measureMaster pour le bus master.
    truePeak: master?.truePeak ?? null,
    peak: sibilants?.peak ?? presence?.peak ?? null, // peak large bande
    energyBand_5_8kHz: sibilants?.rms ?? null,        // dB mean — proxy sibilantes
    energyBand_1_3kHz: presence?.rms ?? null,         // dB mean — proxy présence
  };
  console.log(`[dsp.measureStem:${label}] ${elapsed}s — lufs:${result.lufs} truePeak:${result.truePeak} band5-8k:${result.energyBand_5_8kHz} band1-3k:${result.energyBand_1_3kHz}`);
  return result;
}

/**
 * Mesure l'énergie RMS (mean_volume) d'une bande de fréquence via
 * `bandpass` (filtre IIR Butterworth) + `volumedetect` (RMS overall).
 * Renvoie aussi le peak post-bandpass au passage (utile pour le stem
 * complet en fallback).
 *
 * @param {Buffer} buffer
 * @param {number} centerHz — centre de la bande (ex. 6500 pour 5-8 kHz)
 * @param {number} widthHz  — largeur (ex. 3000 → bande [centre±width/2])
 * @param {string} [label]  — pour logs
 * @returns {Promise<{rms: number|null, peak: number|null}|null>}
 *          rms et peak en dB (négatifs, 0 = full scale).
 */
function measureBandEnergy(buffer, centerHz, widthHz, label = 'band') {
  return new Promise((resolve) => {
    if (!buffer || !buffer.length) return resolve(null);
    const af = `bandpass=f=${centerHz}:width_type=h:w=${widthHz},volumedetect`;
    const args = [
      '-hide_banner', '-nostats',
      '-i', 'pipe:0',
      '-af', af,
      '-f', 'null', '-',
    ];
    let proc;
    try { proc = spawn(ffmpegPath, args); }
    catch (e) {
      console.warn(`[dsp.band:${label}] spawn error:`, e.message);
      return resolve(null);
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, TIMEOUT_MS);
    proc.stdin.on('error', (e) => {
      if (e.code !== 'EPIPE') console.warn(`[dsp.band:${label}] stdin:`, e.message);
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.warn(`[dsp.band:${label}] proc:`, e.message);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(null);
      if (code !== 0) {
        console.warn(`[dsp.band:${label}] exit ${code}, last stderr: ${stderr.slice(-200)}`);
        return resolve(null);
      }
      // volumedetect output :
      //   [Parsed_volumedetect_1 @ ...] mean_volume: -22.5 dB
      //   [Parsed_volumedetect_1 @ ...] max_volume: -1.5 dB
      const parseFloatOrNull = (re) => {
        const m = stderr.match(re);
        if (!m) return null;
        const n = parseFloat(m[1]);
        return Number.isFinite(n) ? n : null;
      };
      resolve({
        rms: parseFloatOrNull(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/),
        peak: parseFloatOrNull(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/),
      });
    });
    try {
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch (e) {
      console.warn(`[dsp.band:${label}] write:`, e.message);
    }
  });
}

/**
 * DSP_PLAN B.3 — mesure du champ stéréo sur le master.
 * Renvoie corrélation L/R (-1 à +1), Mid/Side ratio (% d'énergie M vs S),
 * balance L/R (différence d'énergie entre canaux en dB) et mono compat
 * (delta LUFS entre stéréo et version mixée en mono — proche de 0 = mix
 * tient en mono, > 1 LU = problèmes de phase / annulations en mono).
 *
 * Stratégie (refonte 2026-04-28) : 5-6 ffmpeg parallèles avec `pan +
 * volumedetect`. `volumedetect` a une sortie ultra-stable (`mean_volume:
 * -X dB`) que les versions de ffmpeg ne changent pas, contrairement à
 * `astats` dont le format Channel/Cross corr. varie. On extrait :
 *   - RMS_L  via pan=mono|c0=c0
 *   - RMS_R  via pan=mono|c0=c1
 *   - RMS_M  via pan=mono|c0=0.5*c0+0.5*c1   (mid)
 *   - RMS_S  via pan=mono|c0=0.5*c0-0.5*c1   (side)
 *   - LUFS_mono via pan=mono+ebur128 (existant `measureMonoLufs`)
 *
 * Puis on dérive :
 *   - balanceLR    = RMS_L − RMS_R (en dB)
 *   - midSideRatio = P_S / (P_M + P_S)  (P_X = 10^(RMS_X/10), part d'énergie en side)
 *   - correlation  = 1 − 2 × midSideRatio
 *     (mono pur → MS=0 → corr=1 ; out-of-phase pur → MS=1 → corr=−1 ;
 *      stéréo décorrélé → MS≈0.5 → corr≈0)
 *   - monoCompat   = LUFS_stereo − LUFS_mono
 *
 * @param {Buffer} buffer
 * @param {number} [stereoLufs] — LUFS stéréo déjà mesuré (évite un spawn ebur128).
 * @returns {Promise<{correlation, midSideRatio, balanceLR, monoCompat}|null>}
 */
async function measureStereoField(buffer, stereoLufs = null) {
  if (!buffer || !buffer.length) return null;
  const t0 = Date.now();
  // Lance les mesures en parallèle. 4 panel+volumedetect + 1 mono ebur128
  // (+ 1 master ebur128 si stereoLufs absent).
  const tasks = [
    measureChannelComponent(buffer, 'c0', 'L'),
    measureChannelComponent(buffer, 'c1', 'R'),
    measureChannelComponent(buffer, '0.5*c0+0.5*c1', 'M'),
    measureChannelComponent(buffer, '0.5*c0-0.5*c1', 'S'),
    measureMonoLufs(buffer),
  ];
  if (stereoLufs == null) tasks.push(measureMaster(buffer));
  const results = await Promise.all(tasks);
  const [rmsL, rmsR, rmsM, rmsS, monoMaster, freshMaster] = results;

  const lufsStereo = stereoLufs ?? freshMaster?.lufs ?? null;
  const lufsMono = monoMaster?.lufs ?? null;
  const monoCompat = (lufsStereo != null && lufsMono != null)
    ? +(lufsStereo - lufsMono).toFixed(2)
    : null;

  // Conversions dB → puissance linéaire pour le calcul mid/side.
  // -inf dB (silence pur) → on traite comme null pour éviter NaN.
  const dbToPow = (db) => (db == null || !Number.isFinite(db)) ? null : Math.pow(10, db / 10);
  const powM = dbToPow(rmsM);
  const powS = dbToPow(rmsS);

  // balanceLR : différence dB simple. Positif = plus à gauche.
  const balanceLR = (rmsL != null && Number.isFinite(rmsL) && rmsR != null && Number.isFinite(rmsR))
    ? +(rmsL - rmsR).toFixed(2)
    : null;

  // midSideRatio : part d'énergie en side. 0 = mono pur, 0.5 = stéréo
  // décorrélé, 1 = signal entièrement out-of-phase (rare).
  const midSideRatio = (powM != null && powS != null && (powM + powS) > 0)
    ? +Math.max(0, Math.min(1, powS / (powM + powS))).toFixed(3)
    : null;

  // correlation : dérivée de midSideRatio via la relation théorique
  //   |S|² / (|M|² + |S|²) = (1 − corr) / 2  quand L et R ont même énergie.
  // En pratique cette approximation est bonne à ±0.05 pour la majorité
  // des mix pop/rock. Pour des cas limites (signal mono déphasé sur 1
  // canal) on a une légère sous-estimation.
  const correlation = midSideRatio != null
    ? +Math.max(-1, Math.min(1, 1 - 2 * midSideRatio)).toFixed(3)
    : null;

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = { correlation, midSideRatio, balanceLR, monoCompat };
  console.log(`[dsp.stereo] ${elapsed}s — corr:${correlation} M/S:${midSideRatio} bal:${balanceLR} monoCompat:${monoCompat} (rmsL:${rmsL} rmsR:${rmsR} rmsM:${rmsM} rmsS:${rmsS})`);
  return result;
}

/**
 * Mesure le RMS (mean_volume) d'une combinaison de canaux via `pan` (filtre
 * de mixage stable inter-versions) + `volumedetect` (sortie texte stable
 * `mean_volume: -X dB`). Renvoie un nombre dB ou null si KO/silence.
 *
 * @param {Buffer} buffer
 * @param {string} panExpr — expression pan : 'c0', 'c1', '0.5*c0+0.5*c1', etc.
 * @param {string} [label] — pour les logs
 * @returns {Promise<number|null>}
 */
function measureChannelComponent(buffer, panExpr, label = 'ch') {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', 'pipe:0',
      '-af', `pan=mono|c0=${panExpr},volumedetect`,
      '-f', 'null', '-',
    ];
    let proc;
    try { proc = spawn(ffmpegPath, args); }
    catch (e) { console.warn(`[dsp.stereo:${label}] spawn:`, e.message); return resolve(null); }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    proc.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.warn(`[dsp.stereo:${label}] stdin:`, e.message); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); console.warn(`[dsp.stereo:${label}] proc:`, e.message); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) return resolve(null);
      // volumedetect : "[Parsed_volumedetect_X @ ...] mean_volume: -22.5 dB"
      const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      if (!m) return resolve(null);
      const v = parseFloat(m[1]);
      resolve(Number.isFinite(v) ? v : null);
    });
    try { proc.stdin.write(buffer); proc.stdin.end(); }
    catch (e) { console.warn(`[dsp.stereo:${label}] write:`, e.message); }
  });
}

/**
 * ebur128 sur le mix mono (mid uniquement). Pan filter convertit en mono
 * en mixant L et R à 50/50 (équivalent broadcast standard). Le LUFS
 * résultant est ce que l'auditeur entendrait sur un téléphone, une enceinte
 * mono Bluetooth, ou un compatible mono. Comparé au LUFS stéréo, la
 * différence quantifie la perte (ou le gain rare) en mono compat.
 */
function measureMonoLufs(buffer) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', 'pipe:0',
      // pan=mono fait la moyenne L+R. Pour stéréo input → mono output.
      '-af', 'pan=mono|c0=0.5*c0+0.5*c1,ebur128=peak=true',
      '-f', 'null', '-',
    ];
    let proc;
    try { proc = spawn(ffmpegPath, args); }
    catch (e) { console.warn('[dsp.mono] spawn:', e.message); return resolve(null); }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    proc.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.warn('[dsp.mono] stdin:', e.message); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); console.warn('[dsp.mono] proc:', e.message); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) return resolve(null);
      resolve(parseEbur128(stderr));
    });
    try { proc.stdin.write(buffer); proc.stdin.end(); }
    catch (e) { console.warn('[dsp.mono] write:', e.message); }
  });
}

module.exports = { measureMaster, measureStem, measureStereoField };
