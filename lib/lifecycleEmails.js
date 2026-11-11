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
        'Your first two analyses are on us: upload a mix or a master and get your verdict in a few minutes.',
        'Tes deux premières analyses sont offertes : importe un mix ou un master et reçois ton verdict en quelques minutes.',
      ],
      [
        'Then apply two recommendations and upload your V2 with your second free analysis: Versions compares it with the V1 and shows you what has moved.',
        'Ensuite, applique deux recos et importe ta V2 avec ta deuxième analyse offerte : Versions la compare à la V1 et te montre ce qui a bougé.',
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

// ─── Emails d'activation (audit 2026-11-05, quick win 7) ──────────────
// Textes validés par David le 2026-11-06. Un seul bouton par mail, aucune
// brique technique nommée, tutoiement. Sélection + envoi : lib/lifecycleRunner.js.

function hello(firstName, isEn) {
  const n = (firstName || '').trim();
  if (isEn) return n ? `Hi ${n},` : 'Hi,';
  return n ? `Salut ${n},` : 'Salut,';
}

// E1 — J+2 après inscription, aucune analyse.
function buildActivationNudgeEmail({ locale = 'fr', firstName = null } = {}) {
  const base = APP_BASE();
  const isEn = locale === 'en';
  const plugin = `${base}/plugin`;
  const html = account().renderUserEmail({
    locale,
    titleFr: 'Tes deux analyses offertes t\'attendent',
    titleEn: 'Your two free analyses are waiting',
    paras: [
      [hello(firstName, true), hello(firstName, false)],
      [
        'Your Versions account is ready, with two free analyses waiting. Upload a mix or a master and, within minutes, you get a score, a release verdict and the priority actions, element by element: vocals, low end, drums, space, master.',
        'Ton compte Versions est prêt et deux analyses t\'y attendent, offertes. Dépose un mix ou un master, et en quelques minutes tu as un score, un verdict de sortie et les actions prioritaires, élément par élément : voix, basses, batterie, espace, master.',
      ],
      [
        'The first analysis tells you where your track stands. The second one is for your V2: Versions compares it with the V1 and shows you what moved.',
        'La première analyse te dit où en est ton titre. La deuxième, c\'est pour ta V2 : Versions la compare à la V1 et te montre ce qui a bougé.',
      ],
      [
        `Working in a DAW? The Versions plugin gives you feedback right inside your session: <a href="${plugin}" style="color:#ff8a1f;text-decoration:none">versions.studio/plugin</a>`,
        `Tu travailles dans ton DAW ? Le plugin Versions te donne un avis directement dans ta session : <a href="${plugin}" style="color:#ff8a1f;text-decoration:none">versions.studio/plugin</a>`,
      ],
    ],
    cta: { href: `${base}/analyse`, labelFr: 'Analyser mon titre', labelEn: 'Analyze my track' },
    footerFr: 'Une question ? Écris-nous à contact@versions.studio, on lit tout.',
    footerEn: 'A question? Write to us at contact@versions.studio, we read everything.',
  });
  return { subject: isEn ? 'Your two free analyses are waiting' : 'Tes deux analyses offertes t\'attendent', html };
}

// E2 — J+7, toujours aucune analyse.
function buildExampleEmail({ locale = 'fr', firstName = null } = {}) {
  const base = APP_BASE();
  const isEn = locale === 'en';
  const analyse = `${base}/analyse`;
  const html = account().renderUserEmail({
    locale,
    titleFr: 'À quoi ressemble une fiche Versions',
    titleEn: 'What a Versions report looks like',
    paras: [
      [hello(firstName, true), hello(firstName, false)],
      [
        'No mix at hand yet? See what Versions says about a track: the verdict, the score, the points to fix with precise settings, and the evolution between two versions.',
        'Pas encore de mix sous la main ? Regarde ce que Versions dit d\'un titre : le verdict, le score, les points à reprendre avec les réglages précis, et l\'évolution entre deux versions.',
      ],
      [
        `When you have a track to share, your two free analyses are still there: <a href="${analyse}" style="color:#ff8a1f;text-decoration:none">versions.studio/analyse</a>`,
        `Quand tu auras un titre à faire écouter, tes deux analyses offertes sont toujours là : <a href="${analyse}" style="color:#ff8a1f;text-decoration:none">versions.studio/analyse</a>`,
      ],
    ],
    cta: { href: `${base}/exemple`, labelFr: 'Voir un exemple de fiche', labelEn: 'See a sample report' },
    footerFr: 'Une question ? Écris-nous à contact@versions.studio, on lit tout.',
    footerEn: 'A question? Write to us at contact@versions.studio, we read everything.',
  });
  return { subject: isEn ? 'What a Versions report looks like' : 'À quoi ressemble une fiche Versions', html };
}

// E3 — J+3 après la première fiche, pas de V2, ≥ 1 crédit.
function buildV2NudgeEmail({ locale = 'fr', firstName = null, title = '', score = null, ficheUrl = '' } = {}) {
  const base = APP_BASE();
  const isEn = locale === 'en';
  const t = String(title || (isEn ? 'your track' : 'ton titre'));
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const scoreTxtFr = score != null ? ` est à ${score}/100` : ' est prête';
  const scoreTxtEn = score != null ? ` is at ${score}/100` : ' is ready';
  const html = account().renderUserEmail({
    locale,
    titleFr: `${t} : prêt pour ta V2 ?`,
    titleEn: `${t}: ready for your V2?`,
    paras: [
      [hello(firstName, true), hello(firstName, false)],
      [
        `Your report for “${esc(t)}”${scoreTxtEn}. The priority actions are in the diagnosis; apply two of them, upload your V2, and Versions shows you what moved, point by point.`,
        `Ta fiche pour « ${esc(t)} »${scoreTxtFr}. Les actions prioritaires sont dans le diagnostic ; applique-en deux, réimporte ta V2, et Versions te montre ce qui a bougé, point par point.`,
      ],
      [
        'Your second analysis is on us: that is what it is for.',
        'Ta deuxième analyse est offerte : elle est faite pour ça.',
      ],
      [
        'You can also tick the recommendations you applied in the report: the evolution will take them into account.',
        'Tu peux aussi cocher les recos appliquées dans la fiche : l\'évolution en tiendra compte.',
      ],
    ],
    cta: { href: ficheUrl || `${base}/dashboard`, labelFr: 'Importer ma V2', labelEn: 'Upload my V2' },
    footerFr: 'Une question ? Écris-nous à contact@versions.studio, on lit tout.',
    footerEn: 'A question? Write to us at contact@versions.studio, we read everything.',
  });
  return { subject: isEn ? `${t}: ready for your V2?` : `${t} : prêt pour ta V2 ?`, html };
}

const PLAN_LABELS = { sub_solo: 'Solo', sub_indie: 'Indie', sub_pro: 'Pro' };

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
        `Your subscription stays active ${untilEn}. After that, any unused subscription credits stay available for 90 more days, and credits bought as packs are yours to keep, with no expiry.`,
        `Ton abonnement reste actif ${untilFr}. Ensuite, tes crédits d'abonnement non utilisés restent disponibles 90 jours de plus, et tes crédits achetés en pack restent à toi, sans limite de durée.`,
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

module.exports = { buildSignupWelcomeEmail, buildCancelConfirmEmail, sendCancelConfirmEmail,
  buildActivationNudgeEmail,
  buildExampleEmail,
  buildV2NudgeEmail,
};
