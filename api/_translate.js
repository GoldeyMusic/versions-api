const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();

// ─────────────────────────────────────────────────────────────
// /api/translate
// Traduit un JSON existant (fiche, écoute ou comparaison) vers
// une autre langue, en préservant strictement la structure :
//   - clés JSON inchangées (code identifiers)
//   - IDs techniques inchangés (voice-1, bass-1, …)
//   - champ "icon" inchangé (code identifier)
//   - familles dans elements_detectes : clés FR conservées
//   - scores, booléens, numériques : inchangés
//
// Body attendu :
//   {
//     type: 'fiche' | 'listening' | 'comparison',
//     content: <JSON>,               // l'objet d'origine
//     targetLocale: 'fr' | 'en',
//     sourceLocale: 'fr' | 'en'      // optionnel, pour la contextualisation
//   }
//
// Retourne : { translated: <JSON> } dans la locale cible.
// ─────────────────────────────────────────────────────────────

const FICHE_RULES = `Tu traduis une fiche d'analyse musicale produite par une IA. Le JSON doit rester RIGOUREUSEMENT identique en structure — seules les chaînes naturelles sont traduites.

À NE JAMAIS TOUCHER :
- Les clés JSON (elements, items, plan, elements_detectes, globalScore, verdict, summary, tips, cat, icon, id, p, task, daw, metered, target, linkedItemIds, score, label, detail, tools, …). Ce sont des identifiants de code.
- Le champ "icon" : doit rester exactement "voice", "synths", "bass", "drums", "fx", "lufs".
- Le champ "nature" : doit rester exactement "artistic" ou "technical" (identifiant de code, jamais traduit).
- Le champ "id" : doit rester exactement sa valeur d'origine ("voice-1", "bass-2", …).
- Les clés dans "elements_detectes" : doivent rester exactement "voix", "drums", "basses", "instruments", "spatial" (identifiants de code).
- Tous les types non-textuels : nombres (score, globalScore, duration_seconds…), booléens, null, tableaux vides.
- Les valeurs énumérées du champ "p" (priorité) : "HIGH", "MED", "LOW" — inchangées.

À TRADUIRE :
- Tous les champs texte libres : "label", "detail", "summary", "verdict", "task", "daw", "metered", "target", "tips" (array de strings), "conf" si jamais une valeur textuelle FR, et les strings contenues dans les tableaux de "elements_detectes" (ex: "kick", "caisse claire" → "kick", "snare").
- Le champ "tools" est un tableau de strings : traduire chaque string.
- Préserve les balises d'emphase *entre asterisques* telles quelles (pour l'italique ambre dans le verdict).

CAS SPÉCIAL — champ "cat" (noms canoniques par langue) :
- FR : "VOIX", "INSTRUMENTS", "BASSES & KICK", "DRUMS & PERCUSSIONS", "SPATIAL & REVERB", "MASTER & LOUDNESS".
- EN : "VOICE", "INSTRUMENTS", "BASS & KICK", "DRUMS & PERCUSSION", "SPATIAL & REVERB", "MASTER & LOUDNESS".
  Toujours "VOICE" (pas "VOCALS") car l'UI keye sur cette valeur.

TON :
- Écris comme un ingénieur du son natif de la langue cible. Pas de traduction mot-à-mot calquée.
- Respecte les interdits de vocabulaire existants côté FR (ni "chantier", ni simulation de relation humaine, ni "merci", "content de t entendre", etc.).
- Aucun commentaire, aucune note, aucun markdown. JSON strict uniquement.`;

const LISTENING_RULES = `Tu traduis une écoute qualitative produite par une IA. C'est un JSON avec des champs textuels narratifs qui décrivent ce qu'on entend dans un morceau.

À NE JAMAIS TOUCHER :
- Les clés JSON (impression, points_forts, a_travailler, espace, dynamique, voix, instruments, elements_detectes, …). Identifiants de code.
- Dans "elements_detectes" (si présent), les clés "voix", "drums", "basses", "instruments", "spatial" sont inchangées.
- Nombres, booléens, null, tableaux vides.

À TRADUIRE :
- Toutes les valeurs textuelles (strings et tableaux de strings).
- Les listes d'éléments détectés dans elements_detectes : traduire chaque string (ex: "caisse claire" → "snare", "chœurs" → "backing vocals").

TON :
- Style d'un ingé son qui décrit ce qu'il entend à un confrère. Pas de vocabulaire de détection automatique ("j'ai détecté", "absent", "présent").
- Pas de "chantier" en FR ; en EN, éviter les tournures relationnelles trop familières.
- Aucun commentaire, aucun markdown. JSON strict uniquement.`;

const COMPARISON_RULES = `Tu traduis un delta de comparaison entre deux versions d'un morceau. Le JSON a la structure :
{ "resume": "...", "progres": [{titre, detail}], "regressions": [{titre, detail}], "inchanges": [{titre, detail}] }

À NE JAMAIS TOUCHER :
- Les clés JSON ("resume", "progres", "regressions", "inchanges", "titre", "detail"). Identifiants de code.
- La structure du tableau (garde le même nombre d'items, le même ordre).

À TRADUIRE :
- Les valeurs de "resume", "titre", "detail".

TON :
- Producteur qui raconte à un confrère. Phrases naturelles. Pas de vocabulaire de script ("score en hausse", "element apparu").
- Aucun commentaire, aucun markdown. JSON strict uniquement.`;

function rulesFor(type) {
  if (type === 'listening') return LISTENING_RULES;
  if (type === 'comparison') return COMPARISON_RULES;
  return FICHE_RULES; // fiche par défaut
}

function targetName(locale) {
  if (locale === 'en') return 'ENGLISH';
  return 'FRENCH';
}

router.post('/', async (req, res) => {
  try {
    const { type, content } = req.body;
    const targetLocale = (req.body.targetLocale || '').toString().toLowerCase().slice(0, 2);
    const sourceLocale = (req.body.sourceLocale || '').toString().toLowerCase().slice(0, 2);

    if (!content || typeof content !== 'object') {
      return res.status(400).json({ error: 'content (JSON) requis' });
    }
    if (!['fr', 'en'].includes(targetLocale)) {
      return res.status(400).json({ error: 'targetLocale invalide (fr ou en)' });
    }
    if (!['fiche', 'listening', 'comparison'].includes(type)) {
      return res.status(400).json({ error: 'type invalide (fiche | listening | comparison)' });
    }
    // Si source = target, rien à faire.
    if (sourceLocale && sourceLocale === targetLocale) {
      return res.json({ translated: content });
    }

    const system = `Tu es un traducteur expert pour une app d'analyse musicale (FR ↔ EN).

[CONTRAINTE ABSOLUE DE LANGUE] Tous les champs textuels naturels du JSON doivent être rendus en ${targetName(targetLocale)} dans ta sortie. Les clés JSON et les identifiants de code restent STRICTEMENT inchangés.

${rulesFor(type)}

FORMAT DE SORTIE : JSON valide uniquement. Pas de markdown, pas de backticks, pas de préambule, pas de commentaire.`;

    const userMsg = `Traduis l'objet JSON ci-dessous en ${targetName(targetLocale)}, en respectant toutes les règles du system prompt. Retourne UNIQUEMENT le JSON traduit.

JSON SOURCE :
${JSON.stringify(content, null, 2)}`;

    // Fiche et écoute peuvent être volumineuses (2-4k tokens) → on augmente
    // largement la limite pour éviter les troncatures qui cassent le JSON.
    // Modèle Haiku : 3-4× plus rapide que Sonnet, largement suffisant pour
    // de la traduction avec contraintes structurelles.
    // 16000 tokens : confortable pour les fiches complètes les plus volumineuses
    // (8000 trop juste, observé en prod sur le titre "lacher prise" V5).
    const raw = await chat([{ role: 'user', content: userMsg }], system, {
      maxTokens: 16000,
      model: 'claude-haiku-4-5-20251001',
    });

    let parsed;
    try {
      let cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      // Certains retours peuvent être encadrés de texte — on extrait le premier objet JSON complet
      const start = cleaned.indexOf('{');
      if (start === -1) throw new Error('Aucun JSON dans la réponse');
      let depth = 0, end = -1, inString = false, escaped = false;
      for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }

      let jsonText;
      if (end === -1) {
        // Repair JSON tronqué (meme logique que claude.js generateFiche).
        // On ferme les paires ouvertes et on coupe la derniere paire incomplete.
        // Mode degrade : la fiche traduite peut perdre 1-2 items en queue, mais
        // le client s'en sort avec ce qu'on lui rend (mieux que 500).
        console.warn('[translate] JSON truncated, attempting repair...');
        let repair = cleaned.slice(start);
        repair = repair.replace(/,\s*"[^"]*":\s*"[^"]*$/, '');
        repair = repair.replace(/,\s*"[^"]*$/, '');
        const openBraces = (repair.match(/\{/g) || []).length - (repair.match(/\}/g) || []).length;
        const openBrackets = (repair.match(/\[/g) || []).length - (repair.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets; i++) repair += ']';
        for (let i = 0; i < openBraces; i++) repair += '}';
        jsonText = repair;
      } else {
        jsonText = cleaned.slice(start, end + 1);
      }

      // Pre-repair des glitches de generation Claude observes sur claude.js
      // ("score">N au lieu de "score":N). Aligne le comportement entre les
      // deux endpoints.
      const repaired = jsonText
        .replace(/("\w+")\s*>\s*(-?\d)/g, '$1:$2')
        .replace(/("\w+")\s*=\s*(-?\d)/g, '$1:$2');
      if (repaired !== jsonText) {
        console.warn('[translate] applied JSON glitch repair (operator-instead-of-colon)');
        jsonText = repaired;
      }

      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[translate] parse error:', e.message);
      // Pas de `raw` renvoyé en prod — fuite de prompt interne sinon.
      return res.status(500).json({ error: 'format_invalid' });
    }

    return res.json({ translated: parsed });
  } catch (err) {
    console.error('[translate] error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
