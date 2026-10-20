/**
 * lib/lifecycleEmails.js — contenus des emails « cycle de vie » envoyés
 * aux utilisateurs (ajout 2026-10-20) :
 *   - buildSignupWelcomeEmail  : bienvenue à tout nouvel inscrit
 *                                (POST /api/account/welcome) ;
 *   - buildCancelConfirmEmail  : confirmation de résiliation d'abonnement
 *                                (webhook Stripe subscription.updated,
 *                                cancel_at_period_end false → true).
 *   - sendCancelConfirmEmail   : résout l'email + la langue puis envoie.
 *
 * Gabarit = renderUserEmail de api/_account.js (même charte que les mails
 * de suppression de compte, pied de page Archipel Audio inclus).
 * Copy : tutoiement, aucune mention des briques techniques.
 */

const APP_BASE = () => process.env.APP_BASE_URL || 'https://versions.studio';

function account() {
  return require('../api/_account');
}

function buildSignupWelcomeEmail({ locale = 'fr' } = {}) {
  const base = APP_BASE();
  const isEn = locale === 'en';
  const plugin = `${base}/plugin`;
  const html = account().renderUserEmail({
    locale,
    titleFr: 'Bienvenue sur Versions',
    titleEn: 'Welcome to Versions',
    paras: [
      [
        'Your account is ready. Versions listens to your track and tells you where it stands: a release verdict, a breakdown element by element (vocals, instruments, low end, drums, space, master) and concrete next steps.',
        'Ton compte est prêt. Versions écoute ton morceau et te dit où il en est : un verdict de sortie, un diagnostic élément par élément (voix, instruments, basses, batterie, espace, master) et des pistes concrètes pour avancer.',
      ],
      [
        'Your first analysis is on us: upload a mix or a master and get your verdict in a few minutes.',
        'Ta première analyse est offerte : importe un mix ou un master et reçois ton verdict en quelques minutes.',
      ],
      [
        'Then upload your next version: Versions compares it with the previous one and shows you what has improved.',
        'Ensuite, envoie ta version suivante : Versions la compare à la précédente et te montre ce qui a progressé.',
      ],
      [
        `Working in a DAW? The Versions plugin gives you feedback right inside your session: <a href="${plugin}" style="color:#ff8a1f;text-decoration:none">versions.studio/plugin</a>`,
        `Tu travailles dans un DAW ? Le plugin Versions te donne un avis directement dans ta session : <a href="${plugin}" style="color:#ff8a1f;text-decoration:none">versions.studio/plugin</a>`,
      ],
    ],
    cta: {
      href: `${base}/dashboard`,
      labelFr: 'Lancer ma première analyse',
      labelEn: 'Start my first analysis',
    },
    footerFr: 'Une question ? Écris-nous à contact@versions.studio, on lit tout.',
    footerEn: 'A question? Write to us at contact@versions.studio, we read everything.',
  });
  return {
    subject: isEn ? 'Welcome to Versions' : 'Bienvenue sur Versions',
    html,
  };
}

const PLAN_LABELS = { sub_indie: 'Indie', sub_pro: 'Pro' };

function formatDate(ts, locale) {
  if (!ts) return null;
  try {
    return new Date(ts * 1000).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris',
    });
  } catch {
    return null;
  }
}

function buildCancelConfirmEmail({ locale = 'fr', planKey, endTs }) {
  const base = APP_BASE();
  const isEn = locale === 'en';
  const plan = PLAN_LABELS[planKey] || null;
  const planFr = plan ? `l'abonnement ${plan}` : 'ton abonnement';
  const planEn = plan ? `the ${plan} subscription` : 'your subscription';
  const dateFr = formatDate(endTs, 'fr');
  const dateEn = formatDate(endTs, 'en');
  const untilFr = dateFr ? `jusqu'au ${dateFr}` : "jusqu'à la fin de la période déjà payée";
  const untilEn = dateEn ? `until ${dateEn}` : 'until the end of the period already paid';

  const html = account().renderUserEmail({
    locale,
    titleFr: 'Résiliation confirmée',
    titleEn: 'Cancellation confirmed',
    paras: [
      [
        `Your cancellation of ${planEn} has been registered. You won't be charged again.`,
        `Ta résiliation de ${planFr} est bien prise en compte. Tu ne seras plus prélevé.`,
      ],
      [
        `Your subscription stays active ${untilEn}: until then, this month's credits remain available. Credits bought as packs are yours to keep, with no expiry.`,
        `Ton abonnement reste actif ${untilFr} : d'ici là, tes crédits du mois restent utilisables. Tes crédits achetés en pack restent à toi, sans limite de durée.`,
      ],
      [
        'Changed your mind? You can subscribe again at any time.',
        "Tu changes d'avis ? Tu peux te réabonner à tout moment.",
      ],
    ],
    cta: {
      href: `${base}/pricing`,
      labelFr: 'Voir les offres',
      labelEn: 'See the plans',
    },
    footerFr: 'Une question, un retour, ou envie de nous dire pourquoi tu pars ? Écris à contact@versions.studio, on lit tout.',
    footerEn: "A question, feedback, or want to tell us why you're leaving? Write to contact@versions.studio, we read everything.",
  });
  return {
    subject: isEn ? 'Your Versions subscription has been cancelled' : 'Ton abonnement Versions est résilié',
    html,
  };
}

// Ne throw jamais : un échec d'email ne doit pas faire échouer le webhook.
async function sendCancelConfirmEmail({ userId, email, planKey, endTs }) {
  try {
    let to = email && email !== '—' ? email : null;
    let locale = 'fr';
    if (userId) {
      const { data } = await account().getAdminClient().auth.admin.getUserById(userId);
      if (data?.user) {
        to = to || data.user.email || null;
        if (data.user.user_metadata?.locale === 'en') locale = 'en';
      }
    }
    if (!to) {
      console.warn('[lifecycleEmails] cancel-confirm: no recipient');
      return { ok: false, reason: 'no_recipient' };
    }
    const { subject, html } = buildCancelConfirmEmail({ locale, planKey, endTs });
    await account().sendUserEmail({ to, subject, html, locale });
    console.log(`[lifecycleEmails] cancel-confirm sent → ${to} (${planKey || 'sub'})`);
    return { ok: true };
  } catch (e) {
    console.error('[lifecycleEmails] cancel-confirm failed:', e && e.message);
    return { ok: false, reason: 'error' };
  }
}

module.exports = { buildSignupWelcomeEmail, buildCancelConfirmEmail, sendCancelConfirmEmail };
