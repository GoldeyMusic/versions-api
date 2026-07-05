/**
 * lib/announcementPlugin.js — annonce one-shot : sortie du plugin DAW.
 *
 * Email statique (même contenu pour tout le monde), envoyé via Resend à
 * tous les users confirmés (admins exclus, sauf mode `only`). Réutilise
 * listRecipients / sendEmailViaResend de lib/newsletter.js.
 *
 * Contenu validé par David le 2026-07-05 (ton newsletter AudioKit :
 * direct, personnel, signé David Abakan). Image hébergée sur le front :
 * https://versions.studio/email-plugin-annonce.jpg (pushée le 2026-07-05).
 *
 * Usage : voir api/_announcement.js (endpoints /send + /preview, gated
 * X-Admin-Secret, params ?dry=1 et ?only=email1,email2).
 */

const { listRecipients, sendEmailViaResend, findUserByEmail } = require('./newsletter');

const APP_BASE = () => process.env.APP_BASE_URL || 'https://versions.studio';

const SUBJECT = 'Le plugin VERSiONS est sorti — votre assistant, directement dans votre DAW';

// ─── Template ─────────────────────────────────────────────────────
// Même shell visuel que la newsletter (light-only, 560px, wordmark amber,
// footer désabonnement) mais corps rédactionnel type "lettre" : paragraphes,
// screenshot, bullets, CTA unique vers /plugin.
function buildAnnouncementHtml() {
  const base = APP_BASE();
  const pluginUrl = `${base}/plugin`;
  const imgUrl = `${base}/email-plugin-annonce.jpg`;
  const unsubscribe = 'mailto:contact@versions.studio?subject=Désabonnement%20newsletter';

  const p = (html) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#333">${html}</p>`;
  const li = (title, body) => `<li style="margin:0 0 12px;font-size:14.5px;line-height:1.6;color:#333"><strong style="color:#1a1a1a">${title}</strong> : ${body}</li>`;

  const bodyHtml = `
    ${p('Hello tout le monde 👋')}
    ${p('Grande nouvelle : <strong style="color:#1a1a1a">le plugin VERSiONS est disponible.</strong>')}
    ${p('Jusqu’ici, pour avoir un avis sur votre mix, il fallait exporter, uploader, attendre l’analyse. Maintenant, l’assistant vit directement dans votre session — il entend ce qui joue, et il vous répond pendant que vous mixez.')}

    <a href="${pluginUrl}" target="_blank" style="display:block;margin:8px 0 20px">
      <img src="${imgUrl}" width="480" alt="Le plugin VERSiONS dans une session : metering temps réel et assistant IA" style="display:block;width:100%;max-width:480px;height:auto;border-radius:12px;border:1px solid #e0d8cc" />
    </a>

    ${p('Concrètement :')}
    <ul style="margin:0 0 20px;padding-left:20px">
      ${li('Metering pro, gratuit et illimité', 'LUFS, true peak, spectre, image stéréo — en direct sur votre master ou sur chaque piste')}
      ${li('Un chat qui voit votre session', '<em>« ma basse masque mon kick ? »</em> — il répond en s’appuyant sur vos mesures et les plugins que vous possédez, pas en théorie')}
      ${li('L’écoute express', '30 secondes d’écoute, un verdict clair dans le chat, sans quitter votre DAW')}
      ${li('Une instance par piste, une vue d’ensemble', 'détection de masquage, équilibres entre pistes, conseils qui tiennent compte de tout ce qui joue')}
    </ul>

    ${p('Compatible AU + VST3 : Logic, Ableton, Cubase, Studio One, Reaper… Sur Mac et Windows.')}
    ${p('C’est en ligne dès maintenant.')}
    ${p('Gratuit avec votre compte versions.studio — le plugin vous demandera juste de vous connecter à l’ouverture.')}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 28px">
      <tr>
        <td align="center" style="background:#f5b056;border-radius:10px">
          <a href="${pluginUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;letter-spacing:0.01em">Découvrir le plugin</a>
        </td>
      </tr>
    </table>

    ${p('Une dernière chose, et pas la moindre :')}
    ${p('Ce plugin est fait pour vous accompagner pendant que vous mixez, donc autant le construire ensemble. Il vous manque une mesure ? Une question à laquelle il répond mal ? Dites-le-nous — répondez simplement à ce mail.')}
    ${p('À très vite,<br>Goldey')}
  `;

  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>${SUBJECT}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;padding:40px 16px">
  <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e0d8cc">
        <tr>
          <td align="center" style="padding:36px 32px 20px;background:#ffffff;border-bottom:1px solid #e0d8cc">
            <div style="font-size:32px;font-weight:800;letter-spacing:0.04em;color:#f5b056;margin-bottom:6px">VERSiONS</div>
            <div style="font-size:12px;font-weight:500;letter-spacing:0.08em;color:#999;text-transform:uppercase">Le plugin est là</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;background:#ffffff">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 32px;border-top:1px solid #e0d8cc;background:#faf7f2">
            <p style="margin:0;font-size:12px;color:#666;line-height:1.5">Tu reçois ce mail parce que tu as un compte Versions. <a href="${unsubscribe}" style="color:#666;text-decoration:underline">Me désabonner</a>.</p>
            <p style="margin:12px 0 0;font-size:11px;color:#999">Versions — analyse mix &amp; mastering pour artistes · <a href="https://versions.studio" style="color:#999;text-decoration:underline">versions.studio</a></p>
          </td>
        </tr>
      </table>
  </td></tr>
</table>
</body></html>`;
}

// ─── Orchestrator ─────────────────────────────────────────────────
// Même mécanique que sendNewsletterToAll : séquentiel + throttle 150ms,
// erreurs user-level capturées, résumé renvoyé à l'appelant.
async function sendAnnouncementToAll({ dryRun = false, onlyEmails = null } = {}) {
  let recipients;
  if (Array.isArray(onlyEmails) && onlyEmails.length > 0) {
    recipients = [];
    for (const email of onlyEmails) {
      const u = await findUserByEmail(email);
      if (u) recipients.push(u);
      else console.warn(`[announce-plugin] only-mode: user not found for ${email} — skipped`);
    }
  } else {
    recipients = await listRecipients();
  }

  const html = buildAnnouncementHtml();
  const summary = {
    subject: SUBJECT,
    only: onlyEmails || null,
    total: recipients.length,
    sent: 0,
    failed: 0,
    errors: [],
    dryRun,
  };

  for (const r of recipients) {
    if (dryRun) {
      summary.sent += 1;
      continue;
    }
    const result = await sendEmailViaResend({ to: r.email, subject: SUBJECT, html });
    if (result.ok) {
      summary.sent += 1;
      console.log(`[announce-plugin] sent → ${r.email}`);
    } else {
      summary.failed += 1;
      summary.errors.push({ email: r.email, error: result.error });
    }
    await new Promise(res => setTimeout(res, 150));
  }

  console.log(`[announce-plugin] done — sent=${summary.sent} failed=${summary.failed} total=${summary.total}`);
  return summary;
}

module.exports = {
  SUBJECT,
  buildAnnouncementHtml,
  sendAnnouncementToAll,
};
