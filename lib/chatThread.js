/**
 * lib/chatThread.js — fil de discussion unifié par (utilisateur, titre).
 *
 * Chat unifié, étape 1 (2026-11-11) : le chat de la fiche (site) et le chat
 * du plugin DAW partagent UNE mémoire, la table `track_chat_messages`
 * (migration 060 dans versions-app). Ce module est le seul point d'accès
 * côté API :
 *   - api/_chat.js    écrit chaque échange du site (source 'site') ;
 *   - api/_plugin.js  lit le fil avant de répondre et y écrit l'échange
 *                     (source 'plugin') quand le plugin envoie context.trackId ;
 *                     GET /thread sert au plugin les messages posés sur le site.
 *
 * Le fil est PRIVÉ par personne : toutes les requêtes filtrent sur user_id
 * (issu du JWT vérifié, jamais du body). Aucune fonction ne throw : la
 * mémoire est un plus, elle ne doit jamais faire échouer une réponse.
 */

const { createClient } = require('@supabase/supabase-js');

const TABLE = 'track_chat_messages';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

let _sb = null;
function getSb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _sb;
}

/**
 * Vérifie un JWT Supabase et renvoie l'id utilisateur, ou null.
 * Sert au plugin, dont l'endpoint n'est pas derrière requireAuth (il
 * s'authentifie par secret partagé + Bearer facultatif).
 */
async function resolveUserId(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.getUser();
    if (error || !data?.user?.id) return null;
    return data.user.id;
  } catch (e) {
    console.warn('[chatThread] resolveUserId failed:', e.message);
    return null;
  }
}

/**
 * Derniers messages du fil, du plus ancien au plus récent.
 * Renvoie [] si rien, si les ids sont invalides ou en cas d'erreur.
 */
async function loadThread({ userId, trackId, limit = 16 }) {
  if (!isUuid(userId) || !isUuid(trackId)) return [];
  try {
    const { data, error } = await getSb()
      .from(TABLE)
      .select('id, role, content, source, version_id, created_at')
      .eq('user_id', userId)
      .eq('track_id', trackId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(Math.max(1, Math.min(200, limit)));
    if (error) {
      console.warn('[chatThread] loadThread failed:', error.message);
      return [];
    }
    return (data || []).reverse();
  } catch (e) {
    console.warn('[chatThread] loadThread threw:', e.message);
    return [];
  }
}

/**
 * Nouveautés du fil pour le plugin (chat unifié, étape 2 : le plugin affiche
 * les messages posés sur le site).
 *
 *   afterId > 0  → messages d'id supérieur (ce que le plugin n'a pas encore vu)
 *   afterId = 0  → première synchro : les `limit` derniers messages seulement
 *   source       → 'site' | 'plugin' pour ne garder qu'une origine (facultatif)
 *
 * Renvoie { messages, cursor } : `cursor` = id du dernier message du fil,
 * toutes origines confondues, à renvoyer tel quel au prochain appel. Il est lu
 * AVANT les messages, et les messages sont bornés par lui : un message écrit
 * entre les deux lectures sera servi au tour suivant, jamais sauté.
 * Renvoie null en cas d'erreur (le plugin garde alors son curseur).
 */
async function loadThreadSince({ userId, trackId, afterId = 0, source = null, limit = 40 }) {
  if (!isUuid(userId) || !isUuid(trackId)) return null;
  const after = Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
  const max = Math.max(1, Math.min(100, limit));
  try {
    const sb = getSb();
    const head = await sb
      .from(TABLE)
      .select('id')
      .eq('user_id', userId)
      .eq('track_id', trackId)
      .order('id', { ascending: false })
      .limit(1);
    if (head.error) {
      console.warn('[chatThread] loadThreadSince head failed:', head.error.message);
      return null;
    }
    const cursor = head.data && head.data[0] ? Number(head.data[0].id) : 0;
    if (!cursor || cursor <= after) return { messages: [], cursor: Math.max(cursor, after) };

    let q = sb
      .from(TABLE)
      .select('id, role, content, source, created_at')
      .eq('user_id', userId)
      .eq('track_id', trackId)
      .lte('id', cursor);
    if (source === 'site' || source === 'plugin') q = q.eq('source', source);
    q = after > 0
      ? q.gt('id', after).order('id', { ascending: true }).limit(max)
      : q.order('id', { ascending: false }).limit(max);
    const { data, error } = await q;
    if (error) {
      console.warn('[chatThread] loadThreadSince failed:', error.message);
      return null;
    }
    const rows = after > 0 ? (data || []) : (data || []).reverse();
    return { messages: rows, cursor };
  } catch (e) {
    console.warn('[chatThread] loadThreadSince threw:', e.message);
    return null;
  }
}

/**
 * Ajoute un échange (question de l'utilisateur + réponse de l'assistant).
 * Renvoie true si les deux lignes sont écrites.
 */
async function appendExchange({ userId, trackId, versionId = null, source, question, answer }) {
  if (!isUuid(userId) || !isUuid(trackId)) return false;
  if (source !== 'site' && source !== 'plugin') return false;
  const q = typeof question === 'string' ? question.trim() : '';
  const a = typeof answer === 'string' ? answer.trim() : '';
  if (!q || !a) return false;
  try {
    // Deux horodatages distincts : l'ordre du fil ne dépend pas de l'id seul.
    const now = Date.now();
    const base = {
      user_id: userId,
      track_id: trackId,
      version_id: isUuid(versionId) ? versionId : null,
      source,
    };
    const { error } = await getSb().from(TABLE).insert([
      { ...base, role: 'user', content: q.slice(0, 8000), created_at: new Date(now).toISOString() },
      { ...base, role: 'assistant', content: a.slice(0, 16000), created_at: new Date(now + 1).toISOString() },
    ]);
    if (error) {
      console.warn(`[chatThread] appendExchange failed (${source}):`, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[chatThread] appendExchange threw:', e.message);
    return false;
  }
}

/**
 * Transforme des messages (lignes du fil ou messages envoyés par le site) en
 * tableau { role, content } accepté par l'API du modèle.
 *
 *   maxMessages      on ne garde que les N derniers
 *   maxChars         chaque contenu est tronqué
 *   userTagFor       { plugin: '[…] ', site: '[…] ' } : préfixe ajouté aux
 *                    messages UTILISATEUR selon leur source, pour que le
 *                    modèle sache d'où vient la question (jamais sur les
 *                    réponses de l'assistant : il recopierait le marqueur)
 *   strict           true → le fil commence par un message utilisateur et
 *                    les messages consécutifs de même rôle sont fusionnés
 *                    (plugin). false → on ne retire les réponses orphelines
 *                    du début que si le fil a été raccourci (site : un fil
 *                    court qui commence par la charte mastering reste tel quel).
 */
function toModelMessages(items, { maxMessages = 16, maxChars = 0, userTagFor = null, strict = false } = {}) {
  const clean = [];
  for (const m of Array.isArray(items) ? items : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    let content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) continue;
    if (maxChars > 0 && content.length > maxChars) content = content.slice(0, maxChars) + '…';
    if (m.role === 'user' && userTagFor && m.source && userTagFor[m.source]) {
      content = userTagFor[m.source] + content;
    }
    clean.push({ role: m.role, content });
  }
  const truncated = clean.length > maxMessages;
  let out = truncated ? clean.slice(-maxMessages) : clean;
  if (strict || truncated) {
    while (out.length > 0 && out[0].role !== 'user') out = out.slice(1);
  }
  if (!strict) return out;
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ role: m.role, content: m.content });
  }
  return merged;
}

module.exports = { isUuid, resolveUserId, loadThread, loadThreadSince, appendExchange, toModelMessages };
