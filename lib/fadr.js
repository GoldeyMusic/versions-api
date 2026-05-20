const fetch = require('node-fetch');
const BASE = 'https://api.fadr.com';
const h = () => ({ 'Authorization':`Bearer ${process.env.FADR_API_KEY}`,'Content-Type':'application/json' });

async function analyzeFile(buffer, filename, extension, mimeType, onProgress) {
  onProgress?.('upload', 10);
  const r1 = await fetch(`${BASE}/assets/upload2`, { method:'POST', headers:h(), body:JSON.stringify({ name:filename, extension }) });
  if (!r1.ok) throw new Error(`Fadr upload2: ${r1.status}`);
  const { url, s3Path } = await r1.json();

  onProgress?.('upload', 30);
  await fetch(url, { method:'PUT', headers:{'Content-Type':mimeType}, body:buffer });

  const r2 = await fetch(`${BASE}/assets`, { method:'POST', headers:h(), body:JSON.stringify({ s3Path, name:filename, extension, group:`${filename}-group` }) });
  if (!r2.ok) throw new Error(`Fadr asset: ${r2.status}`);
  const { asset } = await r2.json();

  onProgress?.('stems', 50);
  const r3 = await fetch(`${BASE}/assets/analyze/stem`, { method:'POST', headers:h(), body:JSON.stringify({ _id: asset._id }) });
  if (!r3.ok) throw new Error(`Fadr stem: ${r3.status}`);
  const { task } = await r3.json();

  let result = task;
  let attempts = 0;
  while (!result.status?.complete && attempts < 30) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`${BASE}/tasks/query`, { method:'POST', headers:h(), body:JSON.stringify({ _ids: [task._id] }) });
    const data = await poll.json();
    result = data.tasks?.[0] || result;
    attempts++;
    onProgress?.('analyzing', Math.round(50 + Math.min(40, attempts * 1.4)));
  }

  await new Promise(r => setTimeout(r, 3000));
  const ra = await fetch(`${BASE}/assets/${asset._id}`, { headers:{'Authorization':`Bearer ${process.env.FADR_API_KEY}`} });
  const finalAsset = ra.ok ? (await ra.json()).asset : asset;
  result.asset = finalAsset;
  onProgress?.('done', 100);
  return result;
}

// Normalisation enharmonique de la tonalite renvoyee par Fadr.
// Fadr utilise systematiquement les dieses ("D#:maj", "G#:maj", "Bb:min", ...)
// alors que la convention de lecture varie selon le mode :
//   - MAJEUR : on prefere les bemols quand l equivalent dieses n'a pas de
//     vraie tonalite standard (D# majeur = 9 dieses theoriques, Eb majeur
//     = 3 bemols, l ecriture standard). Idem A# → Bb, G# → Ab.
//   - MINEUR : on prefere les dieses (C# mineur, F# mineur, G# mineur)
//     plutot que leurs enharmoniques bemols qui sont rares.
// On normalise ici pour que l affichage et le prompt Claude soient lisibles
// en notation standard. Format de sortie : "Eb maj", "F# min", "C maj".
function normalizeKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return rawKey;
  const k = rawKey.trim();
  if (!k) return k;

  // Format Fadr "D#:maj" / "Bb:min" — sinon on tente de parser
  let note, modeRaw;
  if (k.includes(':')) {
    const parts = k.split(':');
    note = parts[0];
    modeRaw = (parts[1] || '').toLowerCase();
  } else {
    // Cas exotique "Am" / "C#m" / "Eb"
    const m = k.match(/^([A-G][b#]?)(m)?$/i);
    if (!m) return k;
    note = m[1];
    modeRaw = m[2] ? 'min' : 'maj';
  }
  const isMinor = modeRaw.startsWith('min');
  const modeStr = isMinor ? 'min' : 'maj';

  // Tables de conversion enharmonique selon le mode.
  const SHARP_TO_FLAT = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
  const FLAT_TO_SHARP = { 'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#' };
  // Convention pour chaque mode : quelle ecriture preferer pour les notes alterees.
  // MAJ : on bascule en bemols pour D#/A#/G# (Eb/Bb/Ab). On garde C# (Db rare en pop)
  //       et F# (Gb 6 bemols vs F# 6 dieses, on garde F# par habitude pop).
  // MIN : on bascule en dieses pour Db/Gb/Ab (C#/F#/G#). On garde Eb min et Bb min
  //       (ecritures standards en pop pour les modes mineurs).
  const MAJOR_PREFER_FLAT = new Set(['D#', 'A#', 'G#']);
  const MINOR_PREFER_SHARP = new Set(['Db', 'Gb', 'Ab']);

  let normNote = note;
  if (!isMinor && MAJOR_PREFER_FLAT.has(note)) normNote = SHARP_TO_FLAT[note];
  else if (isMinor && MINOR_PREFER_SHARP.has(note)) normNote = FLAT_TO_SHARP[note];

  return `${normNote} ${modeStr}`;
}

function extractFadrData(task) {
  const a = task.asset || {};
  const meta = a.metaData || {};

  // NOTE — limite connue de l API Fadr (DSP_PLAN, investigation 2026-04-27).
  // Cas observe : UI Fadr affiche "78bpm G maj" comme tonalite globale d un
  // morceau, mais l API /assets/analyze/stem renvoie meta.key="D:min" sur le
  // meme fichier. La timeline d accords UI (B min, D maj, G maj) est coherente
  // avec G majeur (I, iii, V), confirmant que la tonalite UI est la bonne et
  // que c est notre API qui est dans le faux.
  // Hypothese : cache cote Fadr (le meme fichier audio re-analyse plusieurs
  // fois renvoie la meme valeur erronee, puisque Fadr ne re-execute pas son
  // algorithme sur un hash deja vu). Confirme par test sur un autre titre :
  // Fadr a renvoye la bonne tonalite (D#:maj, normalisee Eb maj). Donc bug
  // ponctuel cote Fadr, pas systemique.
  // En attendant correction de leur cote : edition manuelle cote Versions
  // + detection maison en phase 2 (DSP_PLAN).

  const bpm = meta.tempo || a.bpm || null;
  const rawKey = meta.key || a.musicalKey || null;
  const key = rawKey ? normalizeKey(rawKey) : null;
  console.log('[fadr] extracted — bpm:', bpm, 'key:', key, rawKey && rawKey !== key ? `(raw: ${rawKey})` : '');
  return {
    bpm,
    key,
    lufs: meta.lufs || a.lufs || null,
    stems: a.stems || [],
    midi: a.midi || [],
    chords: meta.chords || a.chords || [],
    duration: meta.length ? Math.round(meta.length / meta.sampleRate) : null,
  };
}

// ─── DSP_PLAN B.1 — Téléchargement des stems Fadr ────────────────────
// Récupère les URLs signées des N stems sur l'asset Fadr et les fetch en
// buffers RAM (vocals, drums, bass, other — typiquement 4-stem). Pas de
// stockage côté nous, les buffers sont jetés après mesure DSP.
//
// Mode dégradé (B.1) : si un stem échoue (timeout, 4xx, audio corrompu),
// on continue sans lui — Phase 3 (B.2-B.5) traitera les stems disponibles
// uniquement et signalera l'absence dans le prompt Claude.
//
// Shape Fadr observée (api/assets/analyze/stem → poll → /assets/:_id) :
//   asset.stems = ["68f...", "68f...", ...]   <-- juste des string IDs
// (vérifié sur prod 2026-04-28 — voir fadr_stems_count en DB).
// Pour avoir le name (vocals/drums/bass/other) et l'URL audio, il faut
// faire un GET /assets/{stemId} par stem qui retourne { asset: {...} }
// avec audioUrl ou url presignée S3 (valable ~15 min).
// On garde le support des shapes "objet" au cas où Fadr nous renverrait
// les stems déjà résolus (cas plan upgrade ou évolution API).
//
// @param {Object} asset — l'asset Fadr final (task.asset ou task.result.asset)
// @param {Object} [opts]
// @param {number} [opts.timeoutMs=30000] — timeout par stem (download URL + fetch audio)
// @returns {Promise<Array<{name, stemType, buffer, sizeBytes}>|null>}
async function downloadStems(asset, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const rawStems = (asset?.stems || []);
  if (!rawStems.length) {
    console.warn('[fadr.downloadStems] aucun stem sur asset', asset?._id || '?');
    return null;
  }
  const t0 = Date.now();

  // Étape 0 : résoudre chaque stem en objet complet { _id, name, audioUrl?, ... }.
  // Si rawStems[i] est un string ID, on fetch GET /assets/{id} pour récupérer
  // le full asset (avec name + URL). Si c'est déjà un objet, on garde tel quel.
  const resolveStemAsset = async (s) => {
    if (s && typeof s === 'object') return s;
    if (typeof s !== 'string') return null;
    const stemId = s;
    try {
      const r = await fetch(`${BASE}/assets/${stemId}`, { headers: h() });
      if (r.ok) {
        const j = await r.json();
        return j?.asset || { _id: stemId };
      }
      console.warn(`[fadr.downloadStems] resolve ${stemId.slice(-6)}: HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[fadr.downloadStems] resolve ${stemId.slice(-6)} error:`, err.message);
    }
    // Fallback : on a juste l'ID, on essaiera quand même les endpoints download
    return { _id: stemId };
  };

  const fetchSignedUrl = async (stem) => {
    // Fallback rapide si l'URL est déjà sur le stem (cas idéal après resolve)
    if (stem.audioUrl) return stem.audioUrl;
    if (stem.url) return stem.url;
    if (stem.signedUrl) return stem.signedUrl;
    const stemId = stem._id || stem.id;
    if (!stemId) return null;
    // Endpoint canonique Fadr (GET avec ID dans path)
    try {
      const r = await fetch(`${BASE}/assets/download/${stemId}`, { headers: h() });
      if (r.ok) {
        const j = await r.json();
        if (j?.url) return j.url;
      }
    } catch (_) { /* fallback ci-dessous */ }
    // Fallback : POST signed-url style
    try {
      const r2 = await fetch(`${BASE}/assets/download`, {
        method: 'POST', headers: h(),
        body: JSON.stringify({ _id: stemId }),
      });
      if (r2.ok) {
        const j2 = await r2.json();
        if (j2?.url) return j2.url;
      }
    } catch (_) { /* on laisse retourner null */ }
    return null;
  };

  const downloadOne = async (stem) => {
    const label = stem.name || stem.stemType || (stem._id ? stem._id.slice(-6) : 'unknown');
    const tStem = Date.now();
    try {
      const signedUrl = await Promise.race([
        fetchSignedUrl(stem),
        new Promise((_, reject) => setTimeout(() => reject(new Error('signed-url-timeout')), Math.min(10000, timeoutMs))),
      ]);
      if (!signedUrl) {
        console.warn(`[fadr.downloadStems] ${label} : pas d'URL signée`);
        return null;
      }
      const audioRes = await Promise.race([
        fetch(signedUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('audio-fetch-timeout')), timeoutMs)),
      ]);
      if (!audioRes.ok) {
        console.warn(`[fadr.downloadStems] ${label} HTTP ${audioRes.status}`);
        return null;
      }
      const ab = await audioRes.arrayBuffer();
      const buffer = Buffer.from(ab);
      const elapsed = ((Date.now() - tStem) / 1000).toFixed(1);
      console.log(`[fadr.downloadStems] ${label}: ${(buffer.length / 1024).toFixed(0)}KB en ${elapsed}s`);
      return {
        name: label,
        stemType: classifyStem(label),
        buffer,
        sizeBytes: buffer.length,
      };
    } catch (err) {
      console.warn(`[fadr.downloadStems] ${label} échec:`, err.message);
      return null;
    }
  };

  // Étape 1 : résoudre tous les stems IDs → objets complets (en parallèle)
  const resolved = await Promise.all(rawStems.map(resolveStemAsset));
  const stems = resolved.filter(Boolean);
  if (!stems.length) {
    console.warn(`[fadr.downloadStems] aucun stem résolu sur ${rawStems.length} IDs`);
    return null;
  }
  // Log de debug : on affiche les noms résolus pour diagnostiquer la suite
  console.log(`[fadr.downloadStems] résolus: ${stems.map((s) => s.name || (s._id || '').slice(-6)).join(', ')}`);

  // Étape 2 : téléchargement en parallèle de tous les stems résolus
  const results = await Promise.all(stems.map(downloadOne));
  const ok = results.filter(Boolean);
  console.log(`[fadr.downloadStems] ${ok.length}/${stems.length} stems téléchargés en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return ok.length ? ok : null;
}

// Mappe le nom Fadr ("vocals", "Drums", "bass-stem", …) vers nos types
// canoniques pour Phase 3 (B.2 measureStem). Inconnu → 'other'.
//
// IMPORTANT : Fadr nomme ses stems sous la forme "{userFilename}-{stemType}"
// (ex : "maquette voix temoin.mp3-bass"). On NE DOIT regarder QUE le suffixe
// après le dernier '-' pour ne pas tomber sur le nom du fichier utilisateur.
// Bug 2026-05-20 : un fichier "maquette voix temoin.mp3" contient "voix"
// dans son nom -> tous les stems classifies 'vocal' (y compris bass/drums/
// other) -> stemsArr cote front ne trouve plus drums/bass/other -> jauge
// voix vs instru se masque silencieusement (mode degrade VoiceVsInstruBlock).
function classifyStem(rawName) {
  const full = (rawName || '').toLowerCase();
  // On extrait le suffixe après le dernier '-'. Si pas de '-', on fallback
  // sur tout le nom (cas où Fadr fournirait directement le stemType pur).
  const dashIdx = full.lastIndexOf('-');
  const suffix = dashIdx >= 0 ? full.slice(dashIdx + 1) : full;
  if (suffix.includes('vocal') || suffix === 'voice') return 'vocal';
  if (suffix.includes('drum') || suffix.includes('percu')) return 'drums';
  if (suffix.includes('bass')) return 'bass';
  return 'other';
}

module.exports = { analyzeFile, extractFadrData, downloadStems, classifyStem };
