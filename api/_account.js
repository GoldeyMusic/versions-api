/**
 * api/_account.js — endpoints user-facing pour la gestion du compte.
 *
 * Routes :
 *   POST /api/account/welcome           → Bearer JWT user, mail de bienvenue
 *                                          (une seule fois, nouveaux comptes).
 *   POST /api/account/request-deletion  → Bearer JWT user, envoie un mail
 *                                          de confirmation avec un lien signé.
 *   POST /api/account/confirm-deletion  → token signé en body, supprime le
 *                                          compte via Supabase Admin API +
 *                                          envoie l'email d'adieu au user.
 *
 * Why : protection contre les suppressions accidentelles + sécurité contre
 * le hijack de session (un attaquant qui aurait pris la main sur le compte
 * du user ne peut pas le supprimer sans accès à sa boîte mail).
 *
 * Le user reçoit un mail "Confirme la suppression de ton compte". Il clique
 * un bouton qui pointe vers /confirm-delete-account?token=... sur le front.
 * Le front lit le token, demande une dernière confirmation visuelle, puis
 * POST le token vers /confirm-deletion qui valide et supprime.
 *
 * La notif ops à David (mail [Versions] Compte supprimé) est déclenchée
 * automatiquement par le webhook Supabase auth.users DELETE (cf. _internal.js).
 * Pas besoin de l'appeler explicitement ici.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../lib/auth');
const { notifyOps, renderOpsEmail, stripeUrl } = require('../lib/notifyOps');
const { signDeletionToken, verifyDeletionToken } = require('../lib/deletionToken');
const { archipelFooterLine } = require('../lib/emailFooter');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────

function getAdminClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const APP_BASE = () => process.env.APP_BASE_URL || 'https://versions.studio';

// Envoi direct via Resend (sans passer par notifyOps) car on cible le user,
// pas les ops. Sender = bonjour@versions.studio (cohérent avec le SMTP custom
// Supabase utilisé pour les autres mails user).
async function sendUserEmail({ to, subject, html, locale }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[_account] RESEND_API_KEY missing → email skipped:', subject);
    return;
  }
  const from = process.env.RESEND_USER_FROM || 'Versions <bonjour@versions.studio>';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[_account] resend failed:', res.status, body);
    }
  } catch (e) {
    console.error('[_account] sendUserEmail threw:', e.message);
  } finally {
    clearTimeout(t);
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Template branded Versions, paramétrable. Utilisé pour les 2 mails user
// (demande de confirmation + adieu après suppression).
function renderUserEmail({ titleFr, titleEn, paras, cta, footerFr, footerEn, locale }) {
  const isEn = locale === 'en';
  const t = isEn ? titleEn : titleFr;
  const ftr = isEn ? footerEn : footerFr;
  const taglineEn = 'Analyze · Compare · Evolve';
  const taglineFr = 'Analyse · Compare · Évolue';
  const tagline = isEn ? taglineEn : taglineFr;
  const tagFooterEn = 'Versions — mix &amp; mastering analysis for artists';
  const tagFooterFr = 'Versions — analyse mix &amp; mastering pour artistes';
  const tagFooter = isEn ? tagFooterEn : tagFooterFr;

  const parasHtml = (paras || [])
    .map(([en, fr]) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4a4654">${isEn ? en : fr}</p>`)
    .join('\n            ');

  let ctaHtml = '';
  if (cta) {
    ctaHtml = `        <tr>
          <td align="center" style="padding:0 40px 32px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background:#ff8a1f;border-radius:10px;box-shadow:0 4px 12px rgba(255,138,31,0.32)">
                  <a href="${escapeHtml(cta.href)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em">${isEn ? cta.labelEn : cta.labelFr}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px">
            <p style="margin:0 0 6px;font-size:12px;color:#7a7686">${isEn ? "The button doesn't work? Copy-paste this link in your browser:" : "Le bouton ne fonctionne pas ? Copie-colle ce lien dans ton navigateur :"}</p>
            <p style="margin:0;font-size:12px;color:#7a7686;word-break:break-all"><a href="${escapeHtml(cta.href)}" style="color:#ff8a1f;text-decoration:none">${escapeHtml(cta.href)}</a></p>
          </td>
        </tr>`;
  }

  return `<!doctype html>
<html lang="${isEn ? 'en' : 'fr'}">
<head><meta charset="utf-8"><title>${escapeHtml(t)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1820">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;padding:40px 16px">
  <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08),0 1px 0 rgba(0,0,0,0.04)">
        <tr>
          <td align="center" style="padding:40px 32px 24px;background:linear-gradient(180deg,#1a1820 0%,#0e0d12 100%)">
            <div style="font-size:32px;font-weight:800;letter-spacing:0.04em;color:#ff8a1f;margin-bottom:6px">VERSiONS</div>
            <div style="font-size:11px;font-weight:600;letter-spacing:0.18em;color:#ff8a1f;text-transform:uppercase">${tagline}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 16px">
            <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#1a1820;letter-spacing:-0.01em">${escapeHtml(t)}</h1>
            ${parasHtml}
          </td>
        </tr>
${ctaHtml}
        <tr>
          <td style="padding:24px 40px 32px;border-top:1px solid #ececef;background:#fafafa">
            <p style="margin:0;font-size:12px;color:#7a7686;line-height:1.5">${ftr}</p>
            <p style="margin:12px 0 0;font-size:11px;color:#9a96a4">${tagFooter} · <a href="https://versions.studio" style="color:#9a96a4;text-decoration:underline">versions.studio</a></p>
            ${archipelFooterLine(isEn ? 'en' : 'fr', '#9a96a4')}
          </td>
        </tr>
      </table>
    </td></tr>
</table>
</body></html>`;
}

// ─── POST /request-deletion ────────────────────────────────────────
//
// Appelé par le frontend depuis Réglages → Danger zone. User authentifié
// via Bearer JWT Supabase. Génère un token signé 1h, envoie un mail au user
// avec le lien de confirmation. NE supprime PAS le compte tant que le user
// n'a pas cliqué le lien.
router.post('/request-deletion', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const user = req.user;
    if (!user?.id || !user?.email) {
      return res.status(400).json({ error: 'invalid_user' });
    }
    // Locale stockée dans user_metadata au signup (cf. useAuth.jsx)
    const locale = user.user_metadata?.locale === 'en' ? 'en' : 'fr';
    const token = signDeletionToken({
      user_id: user.id,
      email: user.email,
      locale,
      ttlSeconds: 3600, // 1h
    });
    const confirmUrl = `${APP_BASE()}/confirm-delete-account?token=${encodeURIComponent(token)}`;

    const subject = locale === 'en'
      ? 'Confirm your Versions account deletion'
      : 'Confirme la suppression de ton compte Versions';

    const html = renderUserEmail({
      locale,
      titleFr: 'Confirme la suppression de ton compte',
      titleEn: 'Confirm your account deletion',
      paras: [
        [
          "You requested to delete your Versions account. Click the button below to confirm — this action is irreversible.",
          "Tu as demandé à supprimer ton compte Versions. Clique sur le bouton ci-dessous pour confirmer — cette action est irréversible.",
        ],
        [
          "Once confirmed, all your projects, analyses, audio files and personal data will be permanently deleted. This link is valid for 1 hour.",
          "Une fois confirmée, tous tes projets, analyses, fichiers audio et données personnelles seront définitivement supprimés. Ce lien est valable 1 heure.",
        ],
      ],
      cta: {
        href: confirmUrl,
        labelEn: 'Confirm deletion',
        labelFr: 'Confirmer la suppression',
      },
      footerFr: "Tu n'as pas demandé cette suppression ? Ignore ce mail, ton compte reste intact. Pour plus de sécurité, change ton mot de passe.",
      footerEn: "Didn't request this deletion? Ignore this email, your account stays intact. For extra safety, change your password.",
    });

    await sendUserEmail({ to: user.email, subject, html, locale });

    res.json({ ok: true });
  } catch (err) {
    console.error('[account/request-deletion] failed:', err.message, err.stack);
    res.status(500).json({ error: 'request_failed' });
  }
});

// ─── POST /confirm-deletion ────────────────────────────────────────
//
// Appelé par le frontend depuis l'écran /confirm-delete-account après
// que le user a cliqué le bouton final "Confirmer définitivement". Pas
// d'auth Bearer ici : c'est le token signé qui fait foi (le user n'a
// peut-être plus de session active s'il a cliqué le lien depuis un autre
// device).
//
// Effets :
//   1. Vérifie le token (signature HMAC + expiration + purpose)
//   2. Appelle la RPC delete_user_account(p_user_id) qui purge en cascade
//      toutes les tables, puis supprime auth.users (déclenche le webhook
//      Supabase auth.users DELETE → notif ops David).
//   3. Envoie un mail d'adieu au user (touche humaine).
router.post('/confirm-deletion', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const { token } = req.body || {};
    const payload = verifyDeletionToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'invalid_or_expired_token' });
    }

    const sb = getAdminClient();
    // Appel de la RPC service-role qui purge tout (cf. migration 027).
    // Plus propre que auth.admin.deleteUser direct : la RPC fait les DELETE
    // sur toutes les tables liées (FK pas en cascade côté DB).
    const { error: rpcError } = await sb.rpc('delete_user_account', {
      p_user_id: payload.user_id,
    });
    if (rpcError) {
      console.error('[account/confirm-deletion] delete_user_account failed:', rpcError.message);
      return res.status(500).json({ error: 'deletion_failed' });
    }

    // Envoi de l'email d'adieu (best-effort, pas de retry — si le user
    // est déjà supprimé en DB et le mail échoue, c'est pas grave).
    const goodbyeSubject = payload.locale === 'en'
      ? 'Your Versions account has been deleted'
      : 'Ton compte Versions a été supprimé';
    const goodbyeHtml = renderUserEmail({
      locale: payload.locale,
      titleFr: 'À bientôt 👋',
      titleEn: 'See you soon 👋',
      paras: [
        [
          "Your Versions account and all associated data have just been permanently deleted, as you requested.",
          "Ton compte Versions et toutes les données associées viennent d'être définitivement supprimés, comme tu l'as demandé.",
        ],
        [
          "Thanks for having tried Versions. If you change your mind one day, the door stays open — you can always create a new account on versions.studio.",
          "Merci d'avoir essayé Versions. Si un jour tu changes d'avis, la porte reste ouverte — tu peux toujours créer un nouveau compte sur versions.studio.",
        ],
      ],
      footerFr: "Une question, un retour, ou juste envie de nous dire pourquoi tu pars ? Écris à contact@versions.studio, on lit tout.",
      footerEn: "A question, feedback, or just want to tell us why you're leaving? Write to contact@versions.studio, we read everything.",
    });
    await sendUserEmail({
      to: payload.email,
      subject: goodbyeSubject,
      html: goodbyeHtml,
      locale: payload.locale,
    });

    // La notif ops à David part automatiquement via le webhook
    // Supabase auth.users DELETE (cf. _internal.js).
    res.json({ ok: true });
  } catch (err) {
    console.error('[account/confirm-deletion] failed:', err.message, err.stack);
    res.status(500).json({ error: 'confirm_failed' });
  }
});

// ─── POST /welcome ─────────────────────────────────────────────────
//
// Mail de bienvenue à tout nouvel inscrit, email ou Google (ajout
// 2026-10-20). Appelé par le front au SIGNED_IN (useAuth → sendWelcomeOnce).
//
// Garde-fous :
//   - idempotent : app_metadata.welcome_sent_at (non modifiable par le
//     user) est posé AVANT l'envoi ;
//   - jamais envoyé à un compte créé il y a plus de 48 h → les comptes
//     existants au moment de la mise en ligne ne le reçoivent pas ;
//   - jamais envoyé à une adresse non confirmée.
// Locale : body.locale (langue active dans l'app) > user_metadata.locale > fr.
const WELCOME_MAX_AGE_MS = 48 * 3600 * 1000;

router.post('/welcome', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const admin = getAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(req.user.id);
    if (error || !data?.user) return res.status(404).json({ error: 'user_not_found' });
    const u = data.user;

    if (u.app_metadata?.welcome_sent_at) return res.json({ sent: false, reason: 'already_sent' });
    if (!u.email || !(u.email_confirmed_at || u.confirmed_at)) {
      return res.json({ sent: false, reason: 'email_not_confirmed' });
    }
    const age = Date.now() - new Date(u.created_at).getTime();
    if (!(age >= 0 && age <= WELCOME_MAX_AGE_MS)) return res.json({ sent: false, reason: 'not_new' });

    const { error: upErr } = await admin.auth.admin.updateUserById(u.id, {
      app_metadata: { ...(u.app_metadata || {}), welcome_sent_at: new Date().toISOString() },
    });
    if (upErr) {
      console.error('[account/welcome] flag update failed:', upErr.message);
      return res.status(500).json({ error: 'flag_failed' });
    }

    const bodyLocale = req.body && req.body.locale;
    const locale = bodyLocale === 'en' || bodyLocale === 'fr'
      ? bodyLocale
      : (u.user_metadata?.locale === 'en' ? 'en' : 'fr');
    const { buildSignupWelcomeEmail } = require('../lib/lifecycleEmails');
    const { subject, html } = buildSignupWelcomeEmail({ locale });
    await sendUserEmail({ to: u.email, subject, html, locale });
    console.log(`[account/welcome] sent → ${u.email} (${locale})`);
    res.json({ sent: true });
  } catch (err) {
    console.error('[account/welcome] failed:', err.message);
    res.status(500).json({ error: 'welcome_failed' });
  }
});

module.exports = router;
module.exports.renderUserEmail = renderUserEmail;
module.exports.sendUserEmail = sendUserEmail;
module.exports.getAdminClient = getAdminClient;
