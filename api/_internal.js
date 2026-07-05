/**
 * api/_internal.js — endpoints appelés par Supabase Database Webhooks.
 *
 * Routes :
 *   POST /api/internal/notify-signup             → email ops "Nouvel inscrit"
 *   POST /api/internal/notify-deletion           → email ops "Compte supprimé"
 *   POST /api/internal/notify-feedback           → email ops "Nouvel avis testeur"
 *   POST /api/internal/notify-plugin-first-seen  → email ops "Plugin installé"
 *
 * Auth :
 *   Header `X-Notify-Secret` comparé à process.env.INTERNAL_NOTIFY_SECRET.
 *   Sans secret configuré côté Railway, on renvoie 500 (fail-closed) — sinon
 *   n'importe qui pourrait spammer la boîte ops avec de faux events.
 *
 * Payload Supabase Database Webhook (cf. doc Supabase) :
 *   {
 *     type: 'INSERT' | 'UPDATE' | 'DELETE',
 *     table: 'users' | 'feedback' | ...,
 *     schema: 'auth' | 'public' | ...,
 *     record:     { id, ...colonnes... },  // INSERT/UPDATE
 *     old_record: { id, ...colonnes... },  // DELETE/UPDATE
 *   }
 *
 * Ces routes ne sont PAS gated par requireAuth (elles sont appelées
 * server-to-server par Supabase, pas par un user authentifié). Elles sont
 * gated par le shared secret en header.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { notifyOps, renderOpsEmail } = require('../lib/notifyOps');

const router = express.Router();

// Client admin pour résoudre user_id → email sur les events feedback
// (le payload INSERT public.feedback ne contient que user_id, pas l'email).
// Lazy : on ne crée le client que si la route en a besoin et si la
// SERVICE_ROLE_KEY est configurée.
function getAdminClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Auth shared secret ─────────────────────────────────────
function requireSecret(req, res, next) {
  const got = req.headers['x-notify-secret'];
  const want = process.env.INTERNAL_NOTIFY_SECRET;
  if (!want) {
    console.error('[internal] INTERNAL_NOTIFY_SECRET not configured on Railway');
    return res.status(500).json({ error: 'secret_not_configured' });
  }
  if (!got || got !== want) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.use(requireSecret);

// ─── POST /notify-signup ────────────────────────────────────
router.post('/notify-signup', async (req, res) => {
  try {
    const { type, record } = req.body || {};
    if (type !== 'INSERT' || !record?.id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    const email = record.email || '—';
    const userId = record.id;
    // raw_app_meta_data.provider : 'email' | 'google' | etc.
    const provider = record.raw_app_meta_data?.provider || 'email';
    const providerLabel = provider === 'email' ? 'Email + mot de passe' : `OAuth ${provider}`;
    const createdAt = record.created_at || new Date().toISOString();
    const confirmed = !!record.email_confirmed_at;

    await notifyOps({
      subject: `[Versions] Nouvel inscrit · ${email}`,
      html: renderOpsEmail({
        title: 'Nouvel inscrit',
        intro: `${email} vient de créer un compte sur Versions.`,
        rows: [
          { label: 'Email', value: email },
          { label: 'Inscription via', value: providerLabel },
          { label: 'Email confirmé', value: confirmed ? 'Oui' : 'Pas encore' },
          { label: 'User ID', value: userId },
          { label: 'Date', value: typeof createdAt === 'string' ? createdAt.slice(0, 16).replace('T', ' ') + ' UTC' : '—' },
        ],
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-signup] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

// ─── POST /notify-deletion ──────────────────────────────────
router.post('/notify-deletion', async (req, res) => {
  try {
    const { type, old_record } = req.body || {};
    if (type !== 'DELETE' || !old_record?.id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    const email = old_record.email || '—';
    const userId = old_record.id;
    const createdAt = old_record.created_at;

    await notifyOps({
      subject: `[Versions] Compte supprimé · ${email}`,
      html: renderOpsEmail({
        title: 'Compte supprimé',
        intro: `${email} a supprimé son compte Versions. Toutes ses données ont été purgées (RPC delete_my_account).`,
        rows: [
          { label: 'Email', value: email },
          { label: 'User ID', value: userId },
          { label: 'Compte créé le', value: typeof createdAt === 'string' ? createdAt.slice(0, 10) : '—' },
          { label: 'Suppression le', value: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' },
        ],
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-deletion] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

// ─── POST /notify-feedback ──────────────────────────────────
// Déclenché par un Supabase Database Webhook sur INSERT public.feedback.
// On envoie un mail ops résumant l'avis (NPS + verbatims + contexte).
//
// Le payload Supabase ne contient que la ligne feedback (user_id, NPS,
// verbatims, version_id, track_id, route, locale, user_agent, created_at).
// Pour avoir l'email du testeur dans le mail, on résout user_id via
// l'Admin API (auth.admin.getUserById). Si la résolution échoue (clé
// SERVICE_ROLE absente, user déjà supprimé, etc.), on tombe sur l'UUID
// — la notif part quand même, on ne bloque pas pour un email manquant.
router.post('/notify-feedback', async (req, res) => {
  try {
    const { type, record } = req.body || {};
    if (type !== 'INSERT' || !record?.id || !record?.user_id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    // Résolution email du testeur (best-effort).
    let userEmail = null;
    const admin = getAdminClient();
    if (admin) {
      try {
        const { data, error } = await admin.auth.admin.getUserById(record.user_id);
        if (!error && data?.user?.email) userEmail = data.user.email;
      } catch (e) {
        console.warn('[internal/notify-feedback] getUserById failed:', e.message);
      }
    }

    // NPS color-coded comme dans la modale (FR : 0-6 détracteur, 7-8 passif, 9-10 promoteur).
    const nps = record.nps;
    let npsLabel = '—';
    if (nps !== null && nps !== undefined) {
      const seg = nps <= 6 ? 'détracteur' : (nps <= 8 ? 'passif' : 'promoteur');
      npsLabel = `${nps}/10 (${seg})`;
    }

    // Date du retour, format lisible UTC (cohérent avec les autres mails ops).
    const createdAt = record.created_at || new Date().toISOString();
    const dateLabel = typeof createdAt === 'string'
      ? createdAt.slice(0, 16).replace('T', ' ') + ' UTC'
      : '—';

    // Subject orienté tri Gmail : NPS d'abord pour repérer rapido les
    // détracteurs sans ouvrir, puis email du testeur (ou UUID en fallback).
    const subjectWho = userEmail || `user ${record.user_id.slice(0, 8)}…`;
    const subjectNps = nps !== null && nps !== undefined ? `NPS ${nps}/10` : 'sans NPS';
    const subject = `[Versions] Nouvel avis · ${subjectNps} · ${subjectWho}`;

    // Métadonnées courtes en table label/value, puis verbatims en blocks
    // pour qu'ils respirent en multi-ligne (cf. renderOpsEmail).
    const rows = [
      { label: 'Testeur', value: userEmail || record.user_id },
      { label: 'NPS', value: npsLabel },
      { label: 'Route', value: record.route || '—' },
      { label: 'Version (fiche)', value: record.version_id || null },
      { label: 'Track', value: record.track_id || null },
      { label: 'Locale', value: record.locale || null },
      { label: 'User agent', value: record.user_agent || null },
      { label: 'App version', value: record.app_version || null },
      { label: 'Date', value: dateLabel },
    ];

    // Libellés alignés sur les questions de FeedbackModal pour qu'on
    // retrouve d'un coup d'œil de quoi parle chaque verbatim.
    const blocks = [
      { label: 'Surprise · ce qui a marqué', body: record.surprise },
      { label: 'Friction · pas compris / inutile', body: record.friction },
      { label: 'Pay willingness · prix juste', body: record.paywill },
      { label: 'One-liner · pitch à un pote', body: record.oneliner },
      { label: 'Priorité · à changer en 1er', body: record.priority },
    ];

    await notifyOps({
      subject,
      html: renderOpsEmail({
        title: 'Nouvel avis testeur',
        intro: userEmail
          ? `${userEmail} a laissé un retour via la modale feedback.`
          : `Un testeur a laissé un retour via la modale feedback.`,
        rows,
        blocks,
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-feedback] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

// ─── POST /notify-plugin-first-seen ─────────────────────────
// Déclenché par un Supabase Database Webhook sur INSERT
// public.plugin_first_seen (migration 044 versions-app). La ligne est
// insérée par plugin_touch_first_seen(), greffée dans les RPC que le
// plugin appelle à chaque ouverture (plugin_get_account + les 2 status
// de quota) — INSERT ... ON CONFLICT DO NOTHING → le webhook ne part
// qu'UNE fois par user : c'est le signal "installation réelle" (vs
// simple téléchargement, cf. plugin_downloads / notif download).
// On enrichit avec le contexte funnel : téléchargement loggé ? quand ?
// et la date d'inscription (pour repérer les anciens membres).
router.post('/notify-plugin-first-seen', async (req, res) => {
  try {
    const { type, record } = req.body || {};
    if (type !== 'INSERT' || !record?.user_id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    const userId = record.user_id;
    let email = record.email || null;

    // Contexte best-effort (email manquant, inscription, download) — tout
    // échec ici ne bloque jamais la notif.
    let signedUpAt = null;
    let downloadInfo = null;
    const admin = getAdminClient();
    if (admin) {
      try {
        const { data, error } = await admin.auth.admin.getUserById(userId);
        if (!error && data?.user) {
          if (!email) email = data.user.email || null;
          signedUpAt = data.user.created_at || null;
        }
      } catch (e) {
        console.warn('[internal/notify-plugin-first-seen] getUserById failed:', e.message);
      }
      try {
        const { data: dls } = await admin
          .from('plugin_downloads')
          .select('platform, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);
        if (Array.isArray(dls) && dls.length > 0) {
          const d = dls[0];
          const when = typeof d.created_at === 'string' ? d.created_at.slice(0, 16).replace('T', ' ') + ' UTC' : '';
          downloadInfo = `${d.platform === 'mac' ? 'macOS' : 'Windows'} · ${when}`;
        } else {
          downloadInfo = 'Aucun téléchargement loggé (installé avant le gate, ou binaire partagé)';
        }
      } catch (e) {
        console.warn('[internal/notify-plugin-first-seen] downloads lookup failed:', e.message);
      }
    }

    const firstSeen = record.first_seen_at || new Date().toISOString();
    const who = email || `user ${String(userId).slice(0, 8)}…`;

    await notifyOps({
      subject: `[Versions] Plugin installé · ${who}`,
      html: renderOpsEmail({
        title: 'Première connexion depuis le plugin',
        intro: `${who} vient de se connecter depuis le plugin DAW pour la première fois — installation réelle confirmée.`,
        rows: [
          { label: 'Utilisateur', value: email || userId },
          { label: 'Première connexion', value: typeof firstSeen === 'string' ? firstSeen.slice(0, 16).replace('T', ' ') + ' UTC' : '—' },
          { label: 'Dernier téléchargement', value: downloadInfo },
          { label: 'Inscrit le', value: typeof signedUpAt === 'string' ? signedUpAt.slice(0, 10) : null },
          { label: 'User ID', value: userId },
        ],
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-plugin-first-seen] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

module.exports = router;
