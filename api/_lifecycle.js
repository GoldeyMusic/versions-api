/**
 * api/_lifecycle.js — emails d'activation (cf. lib/lifecycleRunner.js).
 *
 * Routes (gated X-Admin-Secret ou ?secret=, même mécanique que la newsletter) :
 *   POST /api/lifecycle/run                 → un passage : sélection + envoi.
 *        ?dry=1        liste le plan sans envoyer ni journaliser
 *        ?limit=20     plafond d'envois pour ce passage (défaut 20, max 500)
 *   POST /api/lifecycle/test?kind=activation_j2&to=a@b.com&locale=fr
 *                                           → envoie UN mail de test à cette
 *                                             adresse, sans journal.
 *   GET  /api/lifecycle/preview?kind=v2_nudge&locale=fr
 *                                           → HTML du mail (sans envoi).
 *
 * Cron externe (cron-job.org ou Railway cron) : tous les jours à 10h Paris,
 * POST https://<api>/api/lifecycle/run avec le header X-Admin-Secret.
 */
const express = require('express');
const { runLifecycle, sendTestEmail, buildEmail, KINDS } = require('../lib/lifecycleRunner');

const router = express.Router();

function requireAdmin(req, res, next) {
  const want = process.env.ADMIN_SECRET;
  if (!want) {
    console.error('[lifecycle] ADMIN_SECRET not configured on server');
    return res.status(500).json({ error: 'admin_secret_not_configured' });
  }
  const got = req.headers['x-admin-secret'] || req.query.secret;
  if (!got || got !== want) return res.status(401).json({ error: 'unauthorized' });
  next();
}
router.use(requireAdmin);

router.post('/run', async (req, res) => {
  try {
    const dryRun = req.query.dry === '1' || req.query.dry === 'true';
    const limit = req.query.limit != null ? Number(req.query.limit) : 20;
    const summary = await runLifecycle({ dryRun, limit });
    console.log(`[lifecycle] run dry=${dryRun} planned=${summary.planned} sent=${summary.sent} skipped=${summary.skipped} errors=${summary.errors}`);
    res.json(summary);
  } catch (err) {
    console.error('[lifecycle] run failed:', err.message);
    res.status(500).json({ error: 'run_failed', detail: err.message });
  }
});

router.post('/test', async (req, res) => {
  const kind = String(req.query.kind || '');
  const to = String(req.query.to || '');
  const locale = req.query.locale === 'en' ? 'en' : 'fr';
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind', kinds: KINDS });
  if (!/^[^@\s]+@[^@\s]+$/.test(to)) return res.status(400).json({ error: 'bad_to' });
  const r = await sendTestEmail({ kind, to, locale, firstName: req.query.name || null });
  res.json({ ok: r.ok, error: r.error || null });
});

router.get('/preview', (req, res) => {
  const kind = String(req.query.kind || '');
  const locale = req.query.locale === 'en' ? 'en' : 'fr';
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind', kinds: KINDS });
  const { html } = buildEmail(kind, { locale, firstName: req.query.name || 'David', title: 'Mon titre', score: 74, ficheUrl: 'https://versions.studio/dashboard' });
  res.type('html').send(html);
});

module.exports = router;
