const express = require('express');
const multer = require('multer');
console.log('[startup] env check:', {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'present' : 'MISSING',
  SUPABASE_URL: process.env.SUPABASE_URL ? 'present' : 'MISSING',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'present' : 'MISSING',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'present' : 'MISSING',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'present' : 'MISSING',
});
const cors = require('cors');
const { requireAuth } = require('./lib/auth');
const {
  chatLimiter, askLimiter, translateLimiter, compareLimiter,
  masteringCharterLimiter, listenLimiter,
  storageLimiter, audioLimiter,
} = require('./lib/rateLimit');
// analyzeLimiter est désormais appliqué directement dans _analyze.js sur
// /start et /diagnose (cf. mount /api/analyze plus bas). Pas importé ici.
const app = express();
// Railway/Vercel : trust proxy pour que express-rate-limit voie la vraie IP
// dans X-Forwarded-For (sinon tous les requests partagent la même IP edge
// et un seul user peut DoS le rate limit pour tout le monde).
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ─── CORS — whitelist explicite ───────────────────────────────────
// Liste des origines autorisées en prod. Tout le reste est rejeté.
// Permet aussi l'absence d'Origin (curl, scripts serveur-à-serveur,
// requêtes same-origin sur la même Vercel preview).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'https://versions.studio,https://www.versions.studio,http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// /api/billing/webhook a besoin du raw body (signature Stripe). Le router
// billing.js attache express.raw() directement à la route /webhook, donc
// on doit monter ce router AVANT express.json() global — sinon le body
// est déjà parsé en JSON et la signature ne match plus.
//
// NB : le router billing gère lui-même son auth (Bearer JWT pour /checkout,
// signature Stripe pour /webhook, public pour /health). On ne préfixe donc
// PAS requireAuth ici globalement.
app.use('/api/billing', require('./api/_billing'));
app.use(express.json({ limit: '1mb' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Versions API' }));

// ─── Endpoints internes (Supabase Database Webhooks) ──────────────
// Pas de requireAuth — gated par le shared secret X-Notify-Secret côté router.
// Appelés server-to-server par Supabase sur INSERT/DELETE de auth.users.
app.use('/api/internal', require('./api/_internal'));

// ─── Endpoints user-facing pour la gestion du compte ──────────────
// /request-deletion : Bearer JWT user → envoie mail de confirmation
// /confirm-deletion : token signé en body → supprime le compte via Admin API
// (cf. _account.js pour le détail du flow et de la sécurité).
app.use('/api/account', require('./api/_account'));

// ─── Newsletter mensuelle ─────────────────────────────────────────
// POST /api/newsletter/send    → tire la newsletter pour tous les users
// GET  /api/newsletter/preview → preview HTML pour un email donné
// Gated par X-Admin-Secret (cf. _newsletter.js). Pas de requireAuth :
// l'auth se fait via shared secret (cron externe, pas un user authentifié).
app.use('/api/newsletter', require('./api/_newsletter'));

// ─── Endpoints authentifiés ───────────────────────────────────────
// Tous ces routers exigent un Bearer JWT Supabase. requireAuth pose
// req.user.id et req.user.email. Les endpoints DOIVENT utiliser
// req.user.id (jamais req.body.userId) pour identifier l'auteur.
// Rate-limit appliqué après l'auth pour cibler par user.id.
// analyzeLimiter NE doit PAS être appliqué globalement sur /api/analyze :
// il bloquerait le polling /status/:jobId (toutes les 3s pendant 2-3 min
// = >10 req/h très vite → 429 + frontend coincé en boucle de polls vides).
// Le limiteur est poussé dans _analyze.js, ciblé sur /start + /diagnose
// uniquement (les routes coûteuses Gemini+Claude+Fadr).
app.use('/api/analyze', requireAuth, require('./api/_analyze'));
app.use('/api/chat', requireAuth, chatLimiter, require('./api/_chat'));
app.use('/api/mastering-charter', requireAuth, masteringCharterLimiter, require('./api/_mastering_charter'));
app.use('/api/ask', requireAuth, askLimiter, require('./api/_ask'));
app.use('/api/listen', requireAuth, listenLimiter, require('./api/_listen'));
app.use('/api/compare', requireAuth, compareLimiter, require('./api/_compare'));
app.use('/api/translate', requireAuth, translateLimiter, require('./api/_translate'));
app.use('/api/audio', requireAuth, audioLimiter, require('./api/_audio-signed-url'));
// Upload direct navigateur → Supabase (bypass limite ~4,5 Mo Vercel body).
app.use('/api/storage', requireAuth, storageLimiter, require('./api/_storage'));

// ─── Error handler ───────────────────────────────────────────────
// DOIT être déclaré APRÈS tous les app.use de routes (Express n'invoque
// les middlewares d'erreur que pour les routes montées avant). Sans ce
// handler, une MulterError (fichier trop gros, multipart cassé) retombait
// sur le handler par défaut → 500 brut, sans payload JSON. Du coup le
// front affichait "Démarrage échoué (500)" alors qu'on a un message
// "Fichier trop lourd" parfaitement adapté côté i18n.
//
// On ne crée PAS de message FR ici : tout est i18n côté front, on renvoie
// juste un code stable + (optionnel) le seuil pour que le front mette en
// forme un message localisé propre. Cf. _analyze.js qui renvoie déjà
// `error: 'audio_too_long'` / `error: 'no_credits'` sur le même modèle.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      // 80 Mo — cf. _analyze.js multer config (memoryStorage + limits.fileSize).
      // Si on remonte ce plafond un jour, on n'a qu'à changer la constante
      // multer là-bas, le client reçoit le bon chiffre via maxBytes.
      return res.status(413).json({
        error: 'file_too_large',
        maxBytes: 80 * 1024 * 1024,
      });
    }
    return res.status(400).json({ error: 'upload_failed', code: err.code });
  }
  console.error('[express] unhandled error:', err);
  return res.status(500).json({ error: 'internal_error' });
});

// Sur Vercel, l'app n'est pas listen() — elle est invoquée comme une serverless
// function via api/index.js qui réexporte cet app. Le binaire fait `node server.js`
// uniquement en local (npm start). VERCEL=1 est défini par le runtime Vercel.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Versions API running on port ${PORT}`));
}

module.exports = app;
