/**
 * lib/emailFooter.js — ligne éditeur commune à tous les emails envoyés
 * aux utilisateurs Versions (ajout 2026-10-20) : « Versions est édité par
 * Archipel Audio », lien vers archipelaudio.com.
 *
 * À placer sous la ligne « Versions — analyse mix & mastering… » du
 * pied de page. `color` reprend la couleur grise du pied de page appelant.
 */

const ARCHIPEL_URL = 'https://www.archipelaudio.com';

function archipelFooterLine(locale = 'fr', color = '#999') {
  const isEn = locale === 'en';
  const lead = isEn ? 'Versions is published by' : 'Versions est édité par';
  return `<p style="margin:6px 0 0;font-size:11px;color:${color}">${lead} <a href="${ARCHIPEL_URL}" style="color:${color};text-decoration:underline">Archipel Audio</a>.</p>`;
}

module.exports = { archipelFooterLine, ARCHIPEL_URL };
