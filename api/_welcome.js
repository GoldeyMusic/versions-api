/**
 * api/_welcome.js — envoi manuel du mail de bienvenue abonné.
 *
 * L'envoi normal est automatique (webhook Stripe, api/_billing.js sur
 * invoice.billing_reason === 'subscription_create'). Ces endpoints servent :
 *   - à rattraper un abonné qui a souscrit AVANT la mise en place du mail ;
 *   - à prévisualiser / tester le template sans passer par un checkout.
 *
 * Routes (gated X-Admin-Secret, ou ?secret= pour trigger depuis Safari) :
 *   POST /api/welcome-email/send?to=email&plan=sub_pro[&credits=30][&dry=1]
 *   GET  /api/welcome-email/preview?plan=sub_pro[&name=David][&credits=30]
 */

const express = require('express');
const { sendSubscriberWelcome, buildWelcomeHtml, PLAN_META } = require('../lib/welcomeSubscriber');
const { findUserByEmail } = require('../lib/newsletter');

const router = express.Router();

// Même auth shared-secret que newsletter / announce-plugin.
function requireAdmin(req, res, next) {
  const want = process.env.ADMIN_SECRET;
  if (!want) {
    console.error('[welcome-email] ADMIN_SECRET not configured on server');
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
    const to = (req.query.to || '').toString().trim().toLowerCase();
    const planKey = (req.query.plan || '').toString().trim();
    const credits = parseInt(req.query.credits || '0', 10) || null;
    const dryRun = req.query.dry === '1' || req.query.dry === 'true';

    if (!to) return res.status(400).json({ error: 'to_required' });
    if (!PLAN_META[planKey]) {
      return res.status(400).json({ error: 'plan_invalid', allowed: Object.keys(PLAN_META) });
    }

    // Résout le user pour personnaliser le prénom (pas bloquant si absent).
    const user = await findUserByEmail(to);
    if (!user) console.warn(`[welcome-email] no Supabase user found for ${to} — sending unpersonalized`);

    const result = await sendSubscriberWelcome({
      userId: user?.userId || null,
      email: to,
      planKey,
      credits,
      dryRun,
    });
    if (!result.ok) return res.status(500).json({ ok: false, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[welcome-email/send] failed:', err.message, err.stack);
    res.status(500).json({ error: 'send_failed', detail: err.message });
  }
});

// ─── GET /preview ─────────────────────────────────────────────────
router.get('/preview', (req, res) => {
  try {
    const planKey = (req.query.plan || 'sub_pro').toString().trim();
    const meta = PLAN_META[planKey];
    if (!meta) {
      return res.status(400).json({ error: 'plan_invalid', allowed: Object.keys(PLAN_META) });
    }
    const credits = parseInt(req.query.credits || '0', 10) || meta.credits;
    const firstName = (req.query.name || '').toString().trim();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(buildWelcomeHtml({ firstName, planLabel: meta.label, credits }));
  } catch (err) {
    console.error('[welcome-email/preview] failed:', err.message, err.stack);
    res.status(500).json({ error: 'preview_failed', detail: err.message });
  }
});

module.exports = router;
