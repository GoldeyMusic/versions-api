/**
 * lib/welcomeSubscriber.js — mail de bienvenue à la souscription d'un abonnement.
 *
 * Envoyé automatiquement par le webhook Stripe (api/_billing.js,
 * handleSubscriptionInvoice) UNIQUEMENT sur la création d'abo
 * (invoice.billing_reason === 'subscription_create') — jamais sur les
 * renouvellements mensuels.
 *
 * Peut aussi être déclenché manuellement via api/_welcome.js
 * (POST /api/welcome-email/send?to=...&plan=sub_pro, gated X-Admin-Secret)
 * — utile pour rattraper un abonné qui a souscrit avant la mise en place
 * de ce mail.
 *
 * Contenu validé par David le 2026-07-14. Pas de rappel de résiliation
 * (choix David), pas de montant (le reçu Stripe s'en charge). Même shell
 * visuel que lib/announcementPlugin.js (560px, wordmark amber, light-only).
 *
 * Ne throw JAMAIS : un mail raté ne doit pas faire retry le webhook Stripe
 * (le crédit est déjà appliqué en amont). Toutes les erreurs sont loggées.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendEmailViaResend, firstNameFrom } = require('./newsletter');

const APP_BASE = () => process.env.APP_BASE_URL || 'https://versions.studio';

// Libellés marketing des plans (plan_key Stripe → label affiché).
// Les crédits par défaut servent de fallback si le caller ne les passe pas
// (ex. envoi manuel sans query param) — synchronisés avec
// versions-app/src/constants/plans.js.
const PLAN_META = {
  sub_indie: { label: 'Indie', credits: 12 },
  sub_pro: { label: 'Pro', credits: 30 },
};

function buildWelcomeSubject({ planLabel, credits }) {
  return `Bienvenue dans l'abonnement ${planLabel} 🎧 — tes ${credits} analyses t'attendent`;
}

// ─── Template ─────────────────────────────────────────────────────
function buildWelcomeHtml({ firstName, planLabel, credits }) {
  const base = APP_BASE();
  const analyseUrl = `${base}/analyse`;
  const greeting = firstName ? `Salut ${escapeHtml(firstName)},` : 'Salut,';

  const p = (html) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#333">${html}</p>`;
  const h = (txt) => `<p style="margin:24px 0 12px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#d4900e">${txt}</p>`;
  const li = (html) => `<li style="margin:0 0 12px;font-size:14.5px;line-height:1.6;color:#333">${html}</li>`;
  const strong = (txt) => `<strong style="color:#1a1a1a">${txt}</strong>`;

  const bodyHtml = `
    ${p(greeting)}
    ${p(`Merci pour ta confiance — ton abonnement ${strong(planLabel)} est actif. Tes ${strong(`${credits} crédits du mois`)} sont déjà sur ton compte.`)}

    ${h('Ce que chaque analyse t’apporte')}
    <ul style="margin:0 0 20px;padding-left:20px">
      ${li(`${strong('Fiche complète')} : verdict de sortie, score sur 100, diagnostic élément par élément (voix, basses, drums, espace, master) avec des réglages concrets à appliquer.`)}
      ${li(`${strong('Chat contextuel')} : pose tes questions directement sur ta fiche, l’assistant connaît ton mix.`)}
      ${li(`${strong('Suivi d’évolution')} : uploade une V2, on te dit précisément ce qui a progressé.`)}
      ${li(`${strong('Comparaison de versions')}, export PDF et Score Card à partager.`)}
    </ul>

    ${h('Ton avantage abonné dans le plugin')}
    ${p(`Dans ton DAW, ${strong('l’écoute express et le chat IA sont désormais illimités')}. Tu gardes un retour instantané pendant que tu mixes, sans toucher à tes crédits — ceux-ci servent uniquement aux analyses complètes.`)}

    ${h('Bon à savoir')}
    ${p(`Tes crédits ${strong('se cumulent')} de mois en mois tant que ton abonnement est actif — rien ne se perd. Et si tu as des crédits achetés en pack, ils restent disponibles en plus.`)}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto">
      <tr>
        <td align="center" style="background:#f5b056;border-radius:10px">
          <a href="${analyseUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;letter-spacing:0.01em">Lancer une analyse</a>
        </td>
      </tr>
    </table>

    ${p('Bonne prod,<br>L’équipe Versions')}
  `;

  const subject = buildWelcomeSubject({ planLabel, credits });
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;padding:40px 16px">
  <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e0d8cc">
        <tr>
          <td align="center" style="padding:36px 32px 20px;background:#ffffff;border-bottom:1px solid #e0d8cc">
            <div style="font-size:32px;font-weight:800;letter-spacing:0.04em;color:#f5b056;margin-bottom:6px">VERSiONS</div>
            <div style="font-size:12px;font-weight:500;letter-spacing:0.08em;color:#999;text-transform:uppercase">Bienvenue dans l’abonnement ${escapeHtml(planLabel)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;background:#ffffff">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 32px;border-top:1px solid #e0d8cc;background:#faf7f2">
            <p style="margin:0;font-size:12px;color:#666;line-height:1.5">Une question, un souci ? Réponds simplement à ce mail ou écris-nous : <a href="mailto:contact@versions.studio" style="color:#666;text-decoration:underline">contact@versions.studio</a>.</p>
            <p style="margin:12px 0 0;font-size:11px;color:#999">Versions — analyse mix &amp; mastering pour artistes · <a href="https://versions.studio" style="color:#999;text-decoration:underline">versions.studio</a></p>
          </td>
        </tr>
      </table>
  </td></tr>
</table>
</body></html>`;
}

// ─── Résolution du prénom ─────────────────────────────────────────
// Depuis le webhook on a le user_id → Admin API getUserById + profiles.prenom.
// Toute erreur → firstName vide, le template retombe sur "Salut,".
async function resolveFirstName({ userId, email }) {
  try {
    const sb = getSupabase();
    let user = null;
    if (userId) {
      const { data, error } = await sb.auth.admin.getUserById(userId);
      if (!error) user = data?.user || null;
    }
    let prenom = null;
    if (user?.id) {
      try {
        const { data: prof } = await sb.from('profiles').select('prenom').eq('id', user.id).maybeSingle();
        prenom = prof?.prenom || null;
      } catch {}
    }
    return firstNameFrom({
      prenom,
      displayName: user?.user_metadata?.full_name || user?.user_metadata?.name || null,
      email: user?.email || email || '',
    });
  } catch (err) {
    console.warn('[welcomeSubscriber] resolveFirstName failed:', err.message);
    return firstNameFrom({ prenom: null, displayName: null, email: email || '' });
  }
}

// ─── Envoi ────────────────────────────────────────────────────────
// Renvoie { ok, subject, to } — ne throw jamais.
async function sendSubscriberWelcome({ userId = null, email, planKey, credits = null, dryRun = false }) {
  try {
    if (!email) {
      console.warn('[welcomeSubscriber] no email → skipped (userId=' + (userId || '—') + ')');
      return { ok: false, error: 'no_email' };
    }
    const meta = PLAN_META[planKey] || { label: planKey || 'abonnement', credits: credits || 0 };
    const effectiveCredits = credits && credits > 0 ? credits : meta.credits;
    const firstName = await resolveFirstName({ userId, email });
    const subject = buildWelcomeSubject({ planLabel: meta.label, credits: effectiveCredits });
    const html = buildWelcomeHtml({ firstName, planLabel: meta.label, credits: effectiveCredits });

    if (dryRun) {
      console.log(`[welcomeSubscriber] dry-run → ${email} (${planKey}, ${effectiveCredits} credits)`);
      return { ok: true, dryRun: true, subject, to: email };
    }
    const result = await sendEmailViaResend({ to: email, subject, html });
    if (result.ok) {
      console.log(`[welcomeSubscriber] sent → ${email} (${planKey})`);
      return { ok: true, subject, to: email };
    }
    console.error(`[welcomeSubscriber] send failed → ${email}:`, result.error);
    return { ok: false, error: result.error, to: email };
  } catch (err) {
    console.error('[welcomeSubscriber] threw:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  _sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return _sb;
}

module.exports = {
  PLAN_META,
  buildWelcomeSubject,
  buildWelcomeHtml,
  sendSubscriberWelcome,
};
