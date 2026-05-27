/**
 * api/_newsletter.js — endpoints d'envoi et de preview de la newsletter
 * mensuelle utilisateurs.
 *
 * Routes :
 *   POST /api/newsletter/send       → tire la newsletter pour TOUS les
 *                                     users éligibles. Gated par ADMIN_SECRET.
 *                                     Query params :
 *                                       month=YYYY-MM   (optionnel)
 *                                       dry=1           (n'envoie pas, juste compte)
 *   GET  /api/newsletter/preview    → renvoie le HTML pour un email donné
 *                                     (sans envoyer). Gated par ADMIN_SECRET.
 *                                     Query params :
 *                                       email=...       (obligatoire)
 *                                       month=YYYY-MM   (optionnel)
 *                                       format=html|json (default html)
 *
 * Auth :
 *   Header `X-Admin-Secret` comparé à process.env.ADMIN_SECRET.
 *   Si ADMIN_SECRET n'est pas configuré → fail-closed (500), pour éviter
 *   de spammer la base d'users si quelqu'un déploie sans le set.
 *
 * Cron externe :
 *   Cet endpoint NE déclenche PAS d'envoi tout seul. Pour automatiser le
 *   tirage mensuel, configurer un cron externe (au choix) :
 *
 *     1) Railway cron service (`railway cron`) — recommandé si on est déjà
 *        sur Railway. Cron expression : `0 9 1 * *` (1er de chaque mois,
 *        9h UTC), commande : `curl -X POST -H "X-Admin-Secret: $ADMIN_SECRET"
 *        https://<host>/api/newsletter/send`.
 *
 *     2) cron-job.org (gratuit, externe) — configurer un job HTTP qui POST
 *        sur /api/newsletter/send avec le header X-Admin-Secret. Schedule :
 *        1er du mois à 9h.
 *
 *   Par défaut l'endpoint résume le MOIS PRÉCÉDENT (cf. lib/newsletter.js
 *   resolveMonth()) — donc déclencher le 1er à 9h envoie le récap du mois
 *   qui vient de se terminer. C'est l'usage attendu.
 */

const express = require('express');
const { sendNewsletterToAll, buildNewsletter, findUserByEmail } = require('../lib/newsletter');

const router = express.Router();

// ─── Auth shared secret ───────────────────────────────────────────
// Accepte le secret dans deux sources :
//   1. Header `X-Admin-Secret`  → cron, curl, postman (recommandé)
//   2. Query string `?secret=`  → fallback pour pouvoir déclencher
//      depuis Safari mobile (impossible d'envoyer un header custom
//      depuis la barre d'adresse).
// Tradeoff query : le secret apparaît dans les logs serveur, l'historique
// browser et les éventuels logs proxy. Acceptable ici parce qu'il sert
// uniquement à gater une route admin (pas un user-facing endpoint), mais
// privilégier le header dès qu'on a un client capable.
function requireAdmin(req, res, next) {
  const want = process.env.ADMIN_SECRET;
  if (!want) {
    console.error('[newsletter] ADMIN_SECRET not configured on server');
    return res.status(500).json({ error: 'admin_secret_not_configured' });
  }
  const got = req.headers['x-admin-secret'] || req.query.secret;
  if (!got || got !== want) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// ─── POST /send ───────────────────────────────────────────────────
// Synchrone : on attend la fin de la boucle d'envoi. Pour une base
// d'users < 500, ça reste sous le timeout HTTP par défaut de Railway/Vercel.
// Si la base grossit, passer en async + queue (BullMQ / pg-boss).
router.post('/send', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const month = (req.query.month || '').toString() || null;
    const dryRun = req.query.dry === '1' || req.query.dry === 'true';

    const summary = await sendNewsletterToAll({ month, dryRun });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[newsletter/send] failed:', err.message, err.stack);
    res.status(500).json({ error: 'send_failed', detail: err.message });
  }
});

// ─── GET /preview ─────────────────────────────────────────────────
router.get('/preview', async (req, res) => {
  try {
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'email_required' });
    }
    const month = (req.query.month || '').toString() || null;
    const format = (req.query.format || 'html').toString();

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const { subject, html, stats } = await buildNewsletter({
      userId: user.userId,
      email: user.email,
      prenom: user.prenom,
      displayName: user.displayName,
      month,
    });

    if (format === 'json') {
      return res.json({ ok: true, subject, stats, html });
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Newsletter-Subject', subject);
    res.send(html);
  } catch (err) {
    console.error('[newsletter/preview] failed:', err.message, err.stack);
    res.status(500).json({ error: 'preview_failed', detail: err.message });
  }
});

module.exports = router;
