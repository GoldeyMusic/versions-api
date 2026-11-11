const express = require('express');
const { chatWithUsage, MODEL } = require('../lib/claude');
const { logChatCost } = require('../lib/costTracker');
const { isUuid, appendExchange, toModelMessages } = require('../lib/chatThread');
const router = express.Router();

// Tente de charger le RAG PureMix (peut ne pas exister dans tous les envs)
let retrievePureMixContext, formatContextForPrompt;
try {
  const rag = require('../lib/rag');
  retrievePureMixContext = rag.retrievePureMixContext;
  formatContextForPrompt = rag.formatContextForPrompt;
} catch (e) {
  console.warn('[chat] RAG PureMix indisponible:', e.message);
}

// Estimation grossière du nombre de tokens consommés par OpenAI pour
// l'embedding de la requête. text-embedding-3-small ne renvoie pas le
// usage, donc on estime à 4 chars/token (heuristique standard EN/FR).
function estimateEmbedTokens(query) {
  if (!query) return 0;
  return Math.ceil(query.length / 4);
}

router.post('/', async (req, res) => {
  try {
    const {
      messages, item, daw, fadrData, listening, fiche,
      title, artist, version,
      versionId = null,
      trackId = null,
    } = req.body;
    // SÉCURITÉ : userId vient du JWT (requireAuth), pas du body.
    const userId = req.user?.id || null;
    if (!messages) return res.status(400).json({ error: 'messages required' });

    // ─── Chat unifié (étape 1, 2026-11-11) ───────────────────────────
    // Quand le site envoie trackId, la conversation est le fil du TITRE,
    // partagé avec le plugin DAW (table track_chat_messages, cf.
    // lib/chatThread.js). Le site envoie le fil tel qu'il l'affiche ; on le
    // borne ici aux 40 derniers messages et on signale au modèle les
    // questions posées depuis le plugin. Sans trackId (vieux front, titre
    // pas encore en base) : comportement historique, messages inchangés.
    const threadMode = isUuid(trackId);
    const modelMessages = threadMode
      ? toModelMessages(messages, { maxMessages: 40, userTagFor: { plugin: '[depuis le plugin DAW] ' } })
      : messages;
    if (threadMode && modelMessages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    const locale = (req.body.locale || 'fr').toString().toLowerCase().slice(0, 2);
    const isEn = locale === 'en';
    // Bloc "réponds en langue X" préfixé au system prompt.
    const chatLocaleInstruction = isEn
      ? `LANGUAGE OF OUTPUT: respond entirely in ENGLISH. Do not switch languages mid-message.\n\n`
      : '';

    // ─────────────────────────────────────────────────────────────
    // Mode "version-wide" (chat de fiche) : prompt caching activé.
    //
    // On découpe le system prompt en blocs ordonnés du PLUS STATIQUE
    // au PLUS VOLATILE. Les 3 premiers blocs sont marqués cache_control
    // ephemeral → réutilisés tant que la fiche/l'écoute ne changent pas
    // (TTL 5 min, renouvelé à chaque hit). Les blocs RAG + closing
    // ne sont pas cachés car ils varient par question.
    //
    // Limite Anthropic : 4 cache_control markers par requête. On en utilise 3.
    // ─────────────────────────────────────────────────────────────
    let systemPayload;
    let ragUsed = false;
    let embedTokens = 0;

    if (listening || fiche) {
      // Bloc 1 — charter assistant Versions. Statique, change rarement.
      const charterText = chatLocaleInstruction +
        `Tu es l'assistant Versions, ingénieur du son expert (20+ ans d'expérience), intégré dans une app d'analyse de production musicale.\n` +
        `DAW de l'utilisateur : ${daw || 'Logic Pro'}.\n\n` +
        `FORMATAGE OBLIGATOIRE : tu écris dans un petit panneau de chat intégré à l'app, pas dans un document. ` +
        `Écris en prose naturelle, en paragraphes courts. INTERDIT d'utiliser des titres (#), des tableaux, des listes à puces, des séparateurs (---), ou du gras (**). ` +
        `Pas de markdown du tout. Écris comme un collègue qui parle normalement dans un chat. ` +
        `Si tu dois lister des valeurs, intègre-les dans tes phrases (ex: "vise un pre-delay autour de 25 ms et un high-cut à 7 kHz").\n\n` +
        `Sois direct, concis, actionnable. Donne des paramètres précis quand une valeur est utile (fréquence, ratio, ms, dB). ` +
        `Alternative gratuite possible pour chaque plugin mentionné. ` +
        `Pas de salutation, pas de remerciement, pas de simulation de relation humaine. Tu es un collègue ingé qui brief, pas un ami.`;

      // Bloc 2 — meta du morceau (titre, artiste, version). Stable pendant la conv.
      const metaParts = [];
      if (title) metaParts.push(`Morceau actuellement analysé : "${title}"${artist ? ' — ' + artist : ''}.`);
      if (version) metaParts.push(`Version affichée : ${version}.`);
      if (threadMode) {
        metaParts.push(
          `Le fil de conversation couvre TOUT le titre, pas seulement cette version : il peut contenir des échanges ` +
          `sur des versions précédentes, et des questions marquées "[depuis le plugin DAW]" posées pendant le mixage ` +
          `(l'assistant du plugin y a répondu en très court, à partir des mesures en direct de la session). ` +
          `Tiens-en compte comme d'une mémoire commune, mais la fiche et l'écoute ci-dessous sont celles de la version affichée : ` +
          `en cas de divergence avec un ancien message, ce sont elles qui font foi.`
        );
      }
      const metaText = metaParts.length > 0 ? metaParts.join('\n') : '(pas de métadonnées de morceau)';

      // Bloc 3 — fiche + écoute (gros JSON, ~le plus gros morceau du prompt). Stable pendant la conv.
      const ficheBlock = [];
      if (listening) ficheBlock.push(`--- ÉCOUTE QUALITATIVE DE CE MORCEAU ---\n${JSON.stringify(listening, null, 2)}`);
      if (fiche) ficheBlock.push(`--- FICHE D'ANALYSE ACTUELLE (diagnostic + plan d'action) ---\n${JSON.stringify(fiche, null, 2)}`);
      const ficheText = ficheBlock.join('\n\n') || '(pas de fiche disponible)';

      // Bloc 4 — RAG PureMix. Varie à chaque message → JAMAIS caché.
      let ragText = '';
      if (retrievePureMixContext && listening) {
        try {
          const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
          const query = lastUserMsg?.content || lastUserMsg?.text || '';
          // On garde toute l'écoute Gemini (impression, points_forts, espace,
          // dynamique, couleur, mood…) qui ancre la recherche dans le contexte
          // sonore du morceau, ET on injecte la question utilisateur à deux
          // endroits pour qu'elle pèse dans l'embedding :
          //   - en tête de `impression` (1er champ concaténé par buildQueryFromListening)
          //   - dans `a_travailler` (le champ "problèmes à résoudre")
          // Sans ça, une question courte type "EQ classique ou dynamique ?" se
          // noierait dans 1500 chars de description sonore et la recherche
          // remonterait des extraits PureMix génériques au lieu de chunks ciblés.
          const ragInput = {
            ...listening,
            impression: query
              ? `${query} . ${listening?.impression || ''}`.trim()
              : listening?.impression,
            a_travailler: [...(listening?.a_travailler || []), query].filter(Boolean),
          };
          embedTokens = estimateEmbedTokens(query || JSON.stringify(ragInput).slice(0, 500));
          const pmChunks = await retrievePureMixContext(ragInput);
          if (pmChunks && pmChunks.length > 0) {
            const pmContext = formatContextForPrompt(pmChunks);
            if (pmContext) {
              ragUsed = true;
              ragText =
                `\n\n--- EXTRAITS DE COURS PUREMIX (transcripts d'ingénieurs de mix réels) ---\n${pmContext}\n` +
                `Ces extraits viennent d'ingénieurs de mix professionnels. Tu peux t'en inspirer pour enrichir ta réponse, ` +
                `mais ne les cite jamais verbatim et ne les attribue pas nominativement. Reformule avec tes propres mots.\n\n` +
                `L'utilisateur te pose des questions sur ce morceau, cette analyse, ou la production en général. ` +
                `Ancre tes réponses dans le contexte ci-dessus quand c'est pertinent.`;
            }
          }
        } catch (err) {
          console.warn('[chat] RAG PureMix error:', err.message);
        }
      }
      if (!ragText) {
        ragText = `\n\nL'utilisateur te pose des questions sur ce morceau, cette analyse, ou la production en général. ` +
          `Ancre tes réponses dans le contexte ci-dessus quand c'est pertinent.`;
      }

      // System payload en BLOCS — les 3 premiers sont cachables.
      // L'ordre est critique : Anthropic cache jusqu'au DERNIER bloc marqué cache_control,
      // donc on les empile du plus statique au plus volatile, et on n'en marque que les
      // statiques. Le bloc RAG (volatile) arrive après et n'est pas marqué.
      systemPayload = [
        { type: 'text', text: charterText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: metaText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ficheText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ragText },
      ];
    } else {
      // Fallback rétrocompat : ancien chat "per item" du drawer (peu utilisé).
      // Pas de caching ici (prompt trop court pour bénéficier du cache).
      const langDirective = isEn ? 'Respond in English' : 'Réponds en français';
      systemPayload = chatLocaleInstruction +
        `Tu es l'assistant Versions, expert production musicale. DAW: ${daw || 'Logic Pro'}. ` +
        `Élément: ${item?.label || ''}. ${item?.detail || ''} ` +
        `${fadrData ? `BPM: ${fadrData.bpm}, Tonalité: ${fadrData.key}` : ''} ` +
        `${langDirective}, paramètres précis, alternative gratuite pour chaque plugin.`;
    }

    const result = await chatWithUsage(modelMessages, systemPayload);

    // Fire-and-forget : on ne bloque pas la réponse au client si le log échoue.
    // logChatCost ne throw jamais (cf. costTracker.js).
    logChatCost({
      userId,
      versionId,
      messageCount: Array.isArray(modelMessages) ? modelMessages.length : 0,
      ragUsed,
      locale,
      claudeUsage: result.usage,
      embedTokens,
      claudeModel: result.model || MODEL,
    }).catch((e) => console.warn('[chat] logChatCost rejected:', e.message));

    // Mémoire commune : l'échange rejoint le fil du titre. On attend l'écriture
    // (quelques dizaines de ms) pour dire au front si c'est enregistré ; un
    // échec n'empêche jamais la réponse (appendExchange ne throw pas).
    let persisted = false;
    if (threadMode && userId) {
      const lastUser = [...messages].reverse().find((m) => m && m.role === 'user');
      persisted = await appendExchange({
        userId,
        trackId,
        versionId,
        source: 'site',
        question: lastUser?.content || '',
        answer: result.reply,
      });
    }

    return res.json({ reply: result.reply, persisted });
  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
