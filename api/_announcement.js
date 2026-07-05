/**
 * api/_announcement.js — annonce one-shot de la sortie du plugin DAW.
 *
 * Routes (gated X-Admin-Secret, ou ?secret= pour trigger depuis Safari) :
 *   POST /api/announce-plugin/send     → envoie l'annonce.
 *                                        Query params :
 *                                          dry=1              (compte sans envoyer)
 *                                          only=email1,email2 (cible ces emails —
 *                                            indispensable pour le test send David,
 *                                            bypass l'exclusion admin)
 *   GET  /api/announce-plugin/preview  → renvoie le HTML (sans envoyer).
 *
 * ⚠️ Endpoint one-shot : PAS de cron dessus. Une fois l'annonce envoyée à
 * tout le monde, il ne sert plus (on le garde pour d'éventuelles annonces
 * futures en changeant lib/announcementPlugin.js).
 */

const express = require('express');
const { sendAnnouncementToAll, buildAnnouncementHtml, SUBJECT } = require('../lib/announcementPlugin');

const router = express.Router();

// Même auth shared-secret que la newsletter (cf. api/_newsletter.js pour
// le tradeoff header vs query).
function requireAdmin(req, res, next) {
  const want = process.env.ADMIN_SECRET;
  if (!want) {
    console.error('[announce-plugin] ADMIN_SECRET not configured on server');
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
router.post('/send', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const dryRun = req.query.dry === '1' || req.query.dry === 'true';
    const onlyParam = (req.query.only || '').toString().trim();
    const onlyEmails = onlyParam
      ? onlyParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : null;

    const summary = await sendAnnouncementToAll({ dryRun, onlyEmails });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[announce-plugin/send] failed:', err.message, err.stack);
    res.status(500).json({ error: 'send_failed', detail: err.message });
  }
});

// ─── GET /preview ─────────────────────────────────────────────────
router.get('/preview', (req, res) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Announcement-Subject', SUBJECT);
    res.send(buildAnnouncementHtml());
  } catch (err) {
    console.error('[announce-plugin/preview] failed:', err.message, err.stack);
    res.status(500).json({ error: 'preview_failed', detail: err.message });
  }
});

module.exports = router;
