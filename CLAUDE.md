# Versions API — Notes de contexte (backend)

Snapshot pour reprendre proprement le backend depuis Cowork. Le frontend
a son propre `CLAUDE.md` dans `~/versions-app/`.

## Architecture

- **Stack** : Node 20 + Express, déployé sur Railway. Mounted comme
  serverless function sur Vercel (cf. `vercel.json` + `api/index.js`)
  pour les anciens redirects ; la prod tourne sur Railway.
- **Repo** : `~/versions-api/` — anciennement `~/decode-api/` (renommé
  2026-05-05).
- **Deploy** : `git push origin main` → Railway auto-deploy.
- **DB** : Supabase Postgres + Storage. Clients :
  - `SUPABASE_ANON_KEY` pour la vérif du JWT user via `requireAuth`
    (`lib/auth.js`).
  - `SUPABASE_SERVICE_ROLE_KEY` pour tout le reste (bypass RLS).
- **Logs** : Railway dashboard. Pas d'APM.

## Routes (`api/_*.js`)

Toutes montées dans `server.js` (préfixées `/api/<name>`). L'auth varie
selon la route :

| Préfixe              | Auth                              | Rôle |
|---|---|---|
| `/api/analyze`       | `requireAuth` (Bearer JWT)        | Pipeline d'analyse Gemini/Fadr/Claude |
| `/api/chat`          | `requireAuth` + chatLimiter       | Chat fiche |
| `/api/ask`           | `requireAuth` + askLimiter        | Q/A spot sur fiche |
| `/api/listen`        | `requireAuth` + listenLimiter     | Génération `listening` Gemini |
| `/api/compare`       | `requireAuth` + compareLimiter    | Compare 2 versions |
| `/api/translate`     | `requireAuth` + translateLimiter  | i18n FR↔EN cache versions |
| `/api/mastering-charter` | `requireAuth` + masteringCharterLimiter | Génération charter |
| `/api/audio`         | `requireAuth` + audioLimiter      | Signed URL audio |
| `/api/storage`       | `requireAuth` + storageLimiter    | Upload direct Storage |
| `/api/account`       | mixte (Bearer ou token signé)     | Request/confirm deletion |
| `/api/billing`       | Bearer pour `/checkout` + `/cancel-subscription`, signature Stripe pour `/webhook` | Stripe |
| `/api/internal`      | `X-Notify-Secret`                 | Webhooks Supabase DB (signup, deletion, feedback) |
| `/api/newsletter`    | `X-Admin-Secret` (ou `?secret=`)  | Newsletter mensuelle |
| `/api/welcome-email` | `X-Admin-Secret` (ou `?secret=`)  | Mail de bienvenue abonné (envoi manuel + preview) |
| `/api/stats`         | `?token=` vs `STATS_TOKEN`        | Stats publiques plugin (dashboard Archipel) |

Le router `/api/billing` doit être monté **avant** `express.json()`
global parce que `/billing/webhook` a besoin du raw body pour la
signature Stripe (`express.raw()` attaché dans le router lui-même).

Le router `/api/stats` est monté **avant le CORS global** parce que
le dashboard Archipel (`archipelaudio.com`) n'est pas dans
`ALLOWED_ORIGINS` — le router gère son propre CORS.

Le rate-limit (`lib/rateLimit.js`) est appliqué **après** `requireAuth`
pour cibler par `user.id` (et non par IP). Fallback IP-based via
`ipKeyGenerator` (express-rate-limit v8, IPv6-safe).

## Pipeline d'analyse (`api/_analyze.js`)

POST `/api/analyze/start` reçoit le multipart audio, débite 1 crédit
via `debitOrdered` (`lib/credits.js`), pose un job en mémoire, et
lance le pipeline async :

1. Upload Supabase Storage (path `tmp/<userId>/...`)
2. **Mesures DSP** (`lib/dsp.js` — ffmpeg ebur128/loudnorm/silence) →
   `measures_done`. LUFS sanitizé à [-40, +1] (mode dégradé sinon).
3. **Fadr** (`lib/fadr.js`) → BPM, key, stems metrics → `fadr_done`.
4. **Listening Gemini** (`lib/gemini.js`) → `listening_done`. Cache
   par `audio_hash` (`gemini_listening_cache`).
5. **Diagnostic Claude Sonnet 4.6** (`lib/claude.js`) → fiche complète
   → `measures_done` → `complete`.
6. **Persist backend** (`lib/persistAnalysis.js`) — insère
   `tracks`/`versions` en service_role. Le job state expose
   `persistedTrackId` / `persistedVersionId` pour que le front route
   direct sans repasser par `saveAnalysis` côté client.

Si quelque chose plante, `refundCreditIfDebited` rembourse le débit.
Polling `/status/:jobId` côté front (intervalle 3s + Page Visibility).

`analyzeLimiter` n'est PAS appliqué globalement sur `/api/analyze`
(le polling le ferait 429). Il est posé dans `_analyze.js` sur
`/start` et `/diagnose` uniquement (les routes coûteuses).

## Protection crédits — 4 paliers

Architecturé fin mai 2026 après 4 cas observés de crédit débité sans
fiche persistée. Détaillé dans `~/versions-app/CLAUDE.md` (section
"Protection des crédits — 4 paliers"). Le palier 4 (persist backend)
est ce qui ferme structurellement le bug ; les paliers 1-3 sont des
filets côté front et un cron Supabase de refund (`refund_orphan_debits`,
toutes les 30 min, fenêtre 7 jours).

## Webhook Stripe (`api/_billing.js`)

Events écoutés (l'event est dispatché dans `handleStripeEvent`) :

| Event Stripe                            | Action backend |
|---|---|
| `checkout.session.completed` (mode=payment) | Pack one-shot → crédite bucket `pack` (à vie) |
| `invoice.paid` (avec subscription)      | Abo → crédite bucket `sub` (cumulé), maj `monthly_grant`/`renews_at` |
| `customer.subscription.updated` (cancel_at_period_end false → true) | Notif ops "Intention d'annulation" — pas de mouvement DB |
| `customer.subscription.deleted`         | Purge `subscription_balance`, reset méta abo, notif ops "Abo résilié" |
| `charge.refunded`                       | Notif ops uniquement (pas de touche aux crédits) |

Idempotence : `credit_events.stripe_event_id` UNIQUE + check préalable
dans `applyCreditDelta` / `purgeSubscriptionBalance`.

**Format API Stripe** : depuis 2025-04-30.basil, `invoice.subscription`
est déplacé vers `invoice.parent.subscription_details.subscription`, et
`invoice.charge` → `invoice.payments[]`. Helpers `getInvoiceSubscriptionId`
et `fetchStripeNetForInvoice` (commit 8eb9f64) lisent les deux formats.
Pin pas posé volontairement — on suit l'API la plus récente.

**Crédits — modèle Splice** (2026-04-29) : 2 buckets dans `user_credits`
(`subscription_balance` purgeable à résiliation, `pack_balance` à vie),
mirror dans `balance_remaining`. Débit ordonné via RPC
`debit_credits_ordered` (sub d'abord, puis pack). Cumul abo (pas de
reset mensuel) — purge uniquement sur `subscription.deleted`.

## Newsletter mensuelle (`lib/newsletter.js` + `api/_newsletter.js`)

Tirée par un cron externe le 1er de chaque mois. Calcule par user :
analyses (`credit_events.reason='debit_analysis'`), versions uploadées
(jointure `tracks → versions`), meilleur score (`analysis_result.fiche.globalScore`),
progression (moyenne deltas positifs entre versions consécutives d'une
même track), recos appliquées (`mix_note_completions`), crédits restants.

Deux templates HTML inline (`shellHtml` + `renderActiveHtml` /
`renderInactiveHtml`). Palette charte amber (`#f5b056` accents,
`#d4900e` petits textes), light-only. Conseil rotatif du mois
(pool de 12). Envoi via Resend avec header `List-Unsubscribe`
(bouton natif Gmail/Outlook).

**Endpoints** (gated `X-Admin-Secret` ou `?secret=`) :
- `POST /api/newsletter/send` — params `?month=YYYY-MM&wide=1&only=a,b&dry=1`
- `GET /api/newsletter/preview?email=...` — rendu HTML sans envoi

**Mois résumé par défaut** = mois précédent (cron sur le 1er → récap du
mois écoulé). `?wide=1` étend la fenêtre à 2 mois (utile pour le tout
premier envoi). `?only=email1,email2` bypass la liste d'exclusion admin
— c'est comme ça que David et Abakan peuvent recevoir la newsletter
(sinon filtrés par `ADMIN_EMAILS` dans `listRecipients`).

**Cron** à configurer en externe (cron-job.org ou Railway cron) :
`0 9 1 * *` → `POST https://<api>/api/newsletter/send?secret=...`.

## Notifications ops (`lib/notifyOps.js` + `api/_internal.js`)

- **Signup** : webhook Supabase DB sur INSERT `auth.users` →
  `/api/internal/notify-signup` → mail "Nouvel inscrit".
- **Deletion** : webhook Supabase DB sur DELETE `auth.users` →
  `/api/internal/notify-deletion` → mail "Compte supprimé".
- **Feedback** : webhook Supabase DB sur INSERT `public.feedback` →
  `/api/internal/notify-feedback` → mail "Nouvel avis testeur" avec
  NPS color-coded + verbatims.
- **Billing** : envois directs depuis `api/_billing.js` (pack acheté,
  abo créé, abo résilié, intention d'annulation, refund).

Destinataire : `OPS_NOTIFY_EMAIL` (default `contact@versions.studio`).
Sender ops : `RESEND_FROM` (default `onboarding@resend.dev` tant que
versions.studio pas vérifié dans Resend).

Sender user (mails account + newsletter) : `RESEND_USER_FROM` (default
`Versions <contact@versions.studio>`). Suppose le domaine vérifié.

## Suppression de compte (`api/_account.js`)

Flow 2-step pour éviter les suppressions accidentelles + hijack de
session :
1. `POST /api/account/request-deletion` (Bearer) → envoie mail avec
   token signé HMAC 1h.
2. `POST /api/account/confirm-deletion` (body=token) → appel RPC
   `delete_user_account(p_user_id)` (service_role) qui purge en
   cascade toutes les tables liées + `auth.users`. Email "À bientôt"
   au user. Webhook Supabase DELETE auto → notif ops.

## Variables d'env (Railway)

Critiques :
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `FADR_API_KEY`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `INTERNAL_NOTIFY_SECRET` (header X-Notify-Secret webhooks Supabase)
- `ADMIN_SECRET` (newsletter — fail-closed si absent)
- `STATS_TOKEN` (stats plugin — fail-closed si absent, query param `?token=`)
- `DELETION_TOKEN_SECRET` (HMAC tokens suppression compte)

Optionnelles :
- `RESEND_FROM`, `RESEND_USER_FROM`, `OPS_NOTIFY_EMAIL`
- `APP_BASE_URL` (default `https://versions.studio`)
- `ALLOWED_ORIGINS` (CORS whitelist, default prod + localhost:5173)
- `MONETIZATION_ENABLED` (toggle débit côté pipeline analyze)

## Livré récemment

**2026-11-06** :
- **Genre à l'écoute (D.2)** : `lib/gemini.js` demande dans les deux
  templates un `genre_estime` (vocabulaire contraint `GENRE_VOCAB` de
  `lib/genreRules.js`, 68 labels tous rattachés à une famille) + des
  `genre_indices`, et de juger points forts / à travailler avec les codes
  de ce genre. `lib/claude.js` : quand rien n'est déclaré, cette estimation
  est le POINT DE DEPART de `inferred_genre` (gardée sauf contradiction
  flagrante) et seules les familles correspondantes sont injectées (prompt
  court). Les écoutes en cache antérieures n'ont pas le champ → charte
  complète comme avant. Nouvelle famille `rock_blues` ; regex des familles
  sans frontière finale (« classique », « acoustique » matchent).
  `bench_listening_models.js` affiche `genre=…` par fichier ;
  `bench_listening_versions.js --versions <uuid,…>` rejoue l'écoute sur l'audio
  stocké d'une version (option `skipCache` d'`analyzeListening` pour forcer
  l'appel malgré le cache par hash). Test 2026-11-06 : Die With a Smile →
  « pop ballade retro » (avant : « indie folk pop »), Le Freak → « disco ».
- **Charte par esthétique (D.1)** : `lib/genreRules.js` — 14 familles
  (rétro/soul, lo-fi/boom-bap, trap, club, ambient, indie rock, metal, folk,
  jazz/classique, country, latin, pop maximaliste, reggae/dub, néo-soul),
  chacune avec « CRAFT (ne pas pénaliser) » + « NE JAMAIS reprocher » +
  cibles loudness du genre ; 5 règles de scoring (élément aligné et propre
  → ≥ 85, item = suggestion artistic/low ; cibles loudness du genre, pas
  -14 LUFS ; vrais défauts restent des défauts). Injectée dans `genreBlock`
  (genre déclaré → familles reconnues par mots-clés, sinon charte entière ;
  genre à inférer → charte entière). `mechanicalCaps` reçoit
  `genreFamilies` : cap LRA neutralisé pour club/metal/trap/pop maximaliste,
  cap voix masquée neutralisé pour indie rock/ambient/club. Bench :
  `--genre "..."` force le genre déclaré (`scripts/bench_fiche_models.js`).
  D.2 (classifieur de genre à l'écoute) toujours à faire.
- **Stems exploités (basse / drums / instrus)** : `lib/dsp.js::measureStem`
  mesure désormais, par type de stem, des bandes ciblées + un RMS large
  bande de référence (`rmsWide`) : bass 20-60 / 60-150 Hz, drums 60-150 /
  8-12 kHz, other 2-4 kHz, tous 200-500 Hz (voix inchangée : 1-3 / 5-8 kHz).
  `lib/claude.js` en déduit des « PROXYS PAR STEM » (sub vs fondamentale,
  partage kick/basse 60-150, bas-médium chargé, dureté 2-4 kHz, air drums)
  exprimés en relatif, avec la règle « un proxy seul ne fait pas un item :
  l'écoute confirme ». Coût : +2 ffmpeg par stem en parallèle (~+1 s) —
  surveiller `timings.fadr_ms`/`total_ms` dans /admin après déploiement.
- **Pont plugin → site, niveau A** (`api/_plugin.js`, `expressSiteNudge`) :
  après une écoute express sur un bus master (ou sans `channelType`), le
  verdict se termine par une relance personnalisée (solde lu via
  `plugin_get_account` : « il te reste N analyses complètes » ou lien
  `/pricing` si 0). Jamais sur une piste isolée. Best-effort. Niveau B
  (bouton + solde dans le plugin) = release plugin, non fait.
- **Timings pipeline (instrumentation)** : `markTiming(jobId, key, ms)` dans
  `api/_analyze.js` (fadr_ms, listening_ms, rag_ms, fiche_ms, evolution_ms)
  + `startedAt` posé au /start → `total_ms` ; `logAnalysisCost({ timings })`
  écrit `analysis_cost_logs.timings` (jsonb, migration 058 versions-app —
  à appliquer AVANT de déployer, sinon l'insert coût échoue, non fatal).
  Bug corrigé au passage : les `jobs.set` de démarrage du pipeline
  remplaçaient le job sans spread → `userId`/`creditDebited` perdus →
  `refundCreditIfDebited` ne remboursait jamais un échec après ce point.
- **Écoute Gemini BLOQUANTE** (`api/_analyze.js`, helper `listenOrThrow` +
  `notifyListeningOutage`). Avant : échec Gemini → `listening = null`, fiche
  générée sans écoute ni RAG, crédit débité, aucune alerte (panne 402 "prepayment
  credits depleted" invisible 10 jours début nov.). Maintenant : 1 relance
  après 4 s, puis throw `listening_unavailable:` → catch global → job
  `status:error` code `analysis_listening_unavailable` (`lib/jobErrors.js`),
  crédit remboursé par `refundCreditIfDebited`, email ops throttlé 1/h avec
  diagnostic (402/quota vs autre). Front : `errorAnalysisListening` FR/EN +
  case dans `src/lib/backendErrors.js`. Cache Gemini par hash inchangé.
- **Modèle fiche configurable** : env Railway `CLAUDE_FICHE_MODEL` (vide =
  `claude-sonnet-4-6`), lu à chaque appel par `lib/claude.js::ficheModel()`.
  `lib/costTracker.js` tarifie par modèle (`CLAUDE_RATES`, préfixe d'id).
  Bancs d'essai : `scripts/bench_fiche_models.js` (rejoue generateFiche sur
  des analyses en base, plusieurs modèles, rapport .md/.json dans
  `scripts/bench_out/`) et `scripts/bench_listening_models.js` (écoute Gemini
  Flash vs Pro sur un dossier audio). Clés dans `.env.bench` (gitignoré).
- **Grille tarifaire 2026-11-06** (audit, section Pricing) :
  - Catalogue : `sub_solo` 6,99 €/4 analyses (nouveau), `sub_indie` 14,99/12
    (recommandé), `sub_pro` 29,99/30 ; `pack_6` « Pack Projet » 14,99 €/6
    (remplace `pack_5`, archivé via `scripts/archive_legacy_packs.js`),
    `pack_1` conservé en secondaire. Création des prix :
    `node scripts/init_stripe_catalog.js --only=pack_6,sub_solo` (sans
    `--only` le script recrée des doublons de prix). Env Vercel :
    `VITE_STRIPE_PRICE_PACK_6`, `VITE_STRIPE_PRICE_SUB_SOLO`.
  - **Résiliation → crédits de grâce 90 j** (migration 057 versions-app) :
    `customer.subscription.deleted` appelle `convertSubscriptionToGrace`
    (RPC `convert_subscription_to_grace`) au lieu de purger. Colonnes
    `user_credits.grace_balance` / `grace_expires_at`, débit ordonné abo →
    grâce → pack, cron pg_cron `expire-grace-credits` (04:10 UTC) qui
    journalise `grace_expired`. `purgeSubscriptionBalance` reste dispo.
  - **Pause / reprise** : `GET /api/billing/subscription` (statut Stripe),
    `POST /pause-subscription` (pause_collection 'void'), `POST
    /resume-subscription`. Aucun mouvement DB : plus de invoice.paid →
    `plugin_is_subscriber()` retombe en gratuit 2 j après `monthly_renews_at`,
    la reprise relance tout via invoice.paid. Webhook `subscription.updated`
    notifie ops sur transition `pause_collection`. UI : ReglagesScreen.
- **Emails d'activation** (`lib/lifecycleRunner.js`, `lib/lifecycleEmails.js`,
  `api/_lifecycle.js`, mount `/api/lifecycle`). 3 mails, un seul envoi par
  user (table `lifecycle_emails_sent`, migration 056 versions-app) :
  `activation_j2` (≥ 2 j, aucune analyse ni express), `example_j7` (≥ 7 j,
  et J2 envoyé depuis ≥ 5 j), `v2_nudge` (1re fiche ≥ 3 j, aucun titre à
  2 versions, solde ≥ 1). Plafond 20/passage, priorité v2 > j2 > j7.
  `POST /api/lifecycle/run?dry=1` pour voir le plan ; `/test?kind=&to=`
  pour un envoi réel vers soi ; `/preview?kind=` pour le HTML. Cron externe
  quotidien à configurer (10h Paris). Opt-out = `markOptOut(userId)` (insère
  les 3 kinds) sur demande mail.
- **Banc d'essai modèles fiche (10 titres, PureMix actif)** : Sonnet 4.6
  écart 3,3 pts / 51 s / 0,077 € · **Sonnet 5.5 écart 2,6 pts / 16 s /
  0,057 € → retenu** · Opus 5.5 écart 2,3 pts / 41 s / 0,149 €, 6-10 items
  med par fiche (trop) → non retenu. Particularités 5.x câblées dans
  `lib/claude.js::requestTuning` : pas de `temperature` (400), thinking
  compté dans max_tokens → `between_tools` (Sonnet) / `adaptive` (Opus, qui
  refuse between_tools) + budget élargi ; `responseText()` lit le premier
  bloc `text` (les 5.x peuvent renvoyer des blocs thinking avant). Env :
  `CLAUDE_5_THINKING`, `CLAUDE_5_EFFORT`. Bascule prod = `CLAUDE_FICHE_MODEL`.
- **Prompt caching fiche : NON retenu** à ce volume. Mesuré sur juin→nov. :
  14 % des analyses arrivent < 5 min après la précédente (TTL 5 min, write
  ×1,25) et 43 % < 60 min (TTL 1 h, write ×2) → net négatif dans les deux
  cas. À reconsidérer au-delà de ~20 analyses/jour. Le chat garde son cache
  (tours à quelques secondes d'écart).
- Quick wins audit (versions-app) : routes publiques `/pricing` `/tarifs`
  `/plugin`, seed signup 2 crédits (migration 055 appliquée en prod),
  bandeau `NextVersionNudge` fin de V1, copy express 5 → 15.

**2026-07-22** :
- **🔥 Page blanche = traduction auto du navigateur vs React (versions-app).**
  Cause enfin identifiée grâce à la télémétrie posée la veille : 4 entrées
  `client_errors` chez verdoljose2 (Edge 150 / Windows, page `/fiche/...`),
  toutes `Failed to execute 'removeChild' on 'Node': The node to be removed is
  not a child of this node`, source `react-boundary`. C'est LA signature d'une
  traduction automatique de navigateur : elle remplace les nœuds de texte que
  React gère, puis React tente de retirer des nœuds qui ne sont plus là →
  exception → arbre entier démonté → page blanche. Déclencheur : `index.html`
  déclarait `<html lang="en">` sur du contenu FRANÇAIS, donc Edge détectait
  l'incohérence et traduisait. Fix (versions-app) : `lang="fr"` +
  `translate="no"` + `class="notranslate"` + `<meta name="google"
  content="notranslate">` dans `index.html`, et `document.documentElement.lang`
  synchronisé avec le sélecteur FR/EN dans `App.jsx`. Aucune perte pour
  l'utilisateur (l'app sert déjà FR et EN nativement). **Règle : sur une SPA
  React, déclarer la bonne langue ET bloquer la traduction navigateur — sinon
  crash aléatoire, invisible chez le dev, et qui survit à tous les déploiements
  puisqu'il vient d'un réglage du navigateur de l'utilisateur.**
- **🔥 Idempotence serveur anti-double-débit sur `/start`** (`api/_analyze.js`).
  Le fix front du 2026-07-21 (remontage React, cf. ci-dessous) N'A PAS suffi :
  oliviermess@orange.fr, abonné le 2026-07-21 22:32 CEST (donc bundle rechargé
  FRAIS via la redirection Stripe, postérieur au déploiement front de 18:59
  CEST), a quand même été double-débité sur ses 3 analyses suivantes. Leçon :
  ne JAMAIS faire dépendre le débit de la bonne tenue du navigateur. Garde
  serveur autoritaire : `recentStarts` (Map module-scope, fenêtre 120 s,
  clé `${userId}:${audioHash}`, purge périodique). Au `/start`, on calcule le
  hash tôt depuis `req.file.buffer` (path multipart = path actif du site) ;
  si un start identique est encore chaud, on renvoie SON `jobId` (`deduped:true`)
  sans créer de 2ᵉ job, sans re-débiter, sans relancer Fadr/Claude. Paths sans
  buffer (storagePath direct / plugin) : `dedupKey` null → comportement
  inchangé (le plugin a sa propre dédup). Testé sur 5 cas (double-fire 20 s,
  autre audio, ré-analyse >2 min, autre user, sans buffer). Fenêtre 120 s sûre :
  bien au-dessus du double-fire (~20 s), et une ré-analyse identique tape de
  toute façon le cache Gemini par `audio_hash`. **NB** : le fix front reste en
  place (defense-in-depth) mais son efficacité réelle est incertaine — le
  serveur est désormais la source de vérité anti-double-débit.

**2026-07-21bis** :
- **Télémétrie de crash front** (`api/_client_error.js`, mount dans `server.js`).
  `POST /api/client-error` PUBLIC (le crash peut précéder l'auth), rate-limité
  par IP en mémoire (10/h, purge auto), payload 8 kb, champs tronqués côté
  serveur. Trois sorties : Railway logs (`grep [client-error]`), table Supabase
  `client_errors` (migration 047 versions-app, **APPLIQUÉE**), notif ops email
  throttlée à 1/h. Côté front : `src/lib/crashReporter.js` (window.onerror +
  unhandledrejection, cap 3 rapports/page + dédup par message, user_id/email
  lus du token localStorage sans importer le client supabase — il doit marcher
  même si c'est l'init supabase qui a crashé) + `RootErrorBoundary` dans
  `main.jsx` (écran sombre "Recharger la page" au lieu d'une page blanche) +
  `<body style="background:#0a0b14">` inline dans `index.html`. Motivation :
  page blanche non diagnosticable chez verdoljose2 (Windows/Edge 150) sans lui
  demander de manipuler sa console. CSP inchangé (`connect-src` autorisait déjà
  le domaine Railway).
- **🔥 DOUBLE DÉBIT sur CHAQUE analyse** (versions-app, root cause trouvée
  2026-07-21). Symptôme DB : deux `credit_events.debit_analysis` avec des
  `job_id` différents à ~20 s d'intervalle, deux entrées `analysis_cost_logs`
  (Fadr + Claude payés 2×, ~0,55 € au lieu de 0,25 €), mais UNE seule version
  persistée. Mécanique : `App.jsx` montait le wrapper centré du contenu de
  façon CONDITIONNELLE (`showWelcomeTopbar ? <div>{renderContent()}</div> :
  renderContent()`). La structure de l'arbre changeait donc à chaque bascule
  d'écran → React démontait/remontait TOUT le contenu. Au premier résultat
  partiel, `handleLoaded` bascule sur l'écran fiche ; comme l'analyse n'est pas
  finie, la branche `case "fiche"` réaffiche `LoadingScreen` → nouveau montage
  → son effet `[config]`, sans verrou, refaisait upload + `POST /start` → 2ᵉ
  crédit. L'écart de ~20 s = la durée d'un upload. Deux corrections : (1)
  wrapper TOUJOURS monté, neutralisé par `display: contents` (ne jamais
  reconditionner ce wrapper) ; (2) verrou `inFlightRuns` au niveau module dans
  `LoadingScreen.jsx`, clé = titre+version+empreinte fichier, libéré dans le
  `finally` du run (une relance volontaire reste possible, le mode resume n'est
  pas concerné). Impact mesuré avant fix : verdoljose2 7 analyses/7 en double
  (14 crédits), serrurerie.rayan 2, chrisedenmusic 1.
- **Auto-réparation du cache front** (versions-app) : le cache localStorage des
  projets était rendu AVANT le fetch réseau et accepté sur un simple
  `Array.isArray`. Un cache de forme invalide fait donc crasher le render →
  page blanche, ET le crash empêche le refresh d'écraser le cache : la panne
  s'auto-entretient et SURVIT AUX DÉPLOIEMENTS (le poison est dans le
  navigateur). Trois protections : clé versionnée `versions_projects_cache_v2`
  (invalide d'office tout cache ancien — c'est le levier "réparer à distance"),
  validation de forme à la lecture, et purge des clés `versions_*` par
  l'ErrorBoundary au premier crash (session Supabase préservée). Bumper le
  suffixe de la clé est LE geste à refaire si un utilisateur se retrouve
  bloqué en page blanche persistante.
- **Express : cap upload 20 → 64 Mo** (`api/_plugin.js`). Une session 192 kHz
  produit ~23 Mo de WAV 16-bit stéréo pour 30 s → `file_too_large` systématique
  (cas verdoljose2 sous Cubase). Gemini reçoit le fichier via la File API, pas
  de limite inline 20 Mo → relever le cap est sans risque. Fix complémentaire
  côté plugin : downsample 48 kHz dans `captureSnapshotWav`
  (`PluginProcessor.cpp`, LagrangeInterpolator) — à embarquer dans la prochaine
  release ; le fix backend suffit pour débloquer les utilisateurs actuels.

**2026-07-21** :
- **Stats publiques plugin** (`api/_stats.js`, mount dans `server.js`).
  `GET /api/stats/downloads?token=XXX` — renvoie total téléchargements,
  inscrits (`auth.users` via GoTrue admin API), breakdown 7j/30j, et
  daily 90 jours (`plugin_downloads`). Auth par token statique `STATS_TOKEN`
  (fail-closed 403). CORS pour `archipelaudio.com` (router monté avant
  le CORS global). `Cache-Control: max-age=300`. Consommé par le cockpit
  Archipel (`server/audiopass-mail/admin.py`, section Vue d'ensemble).
  **À configurer** : ajouter `STATS_TOKEN` sur Railway (générer un token
  aléatoire, puis reporter la même valeur dans le `.env` du serveur
  Archipel comme `VERSIONS_STATS_TOKEN`).

**2026-07-14** :
- **Mail de bienvenue abonné** (`lib/welcomeSubscriber.js` + `api/_welcome.js`).
  Envoi automatique dans `handleSubscriptionInvoice` (`api/_billing.js`)
  UNIQUEMENT sur `invoice.billing_reason === 'subscription_create'` — jamais
  sur les renouvellements. Contenu validé par David (pas de rappel résiliation,
  pas de montant) : fonctions des analyses, avantage plugin illimité (écoute
  express + chat IA), crédits cumulables, CTA `/analyse`. Même shell visuel
  que l'annonce plugin (560px, wordmark amber, light-only). `sendSubscriberWelcome`
  ne throw jamais (webhook safety). Envoi manuel de rattrapage :
  `POST /api/welcome-email/send?to=email&plan=sub_pro[&credits=N][&dry=1]`,
  preview `GET /api/welcome-email/preview?plan=sub_pro[&name=X]` — gated
  `X-Admin-Secret` ou `?secret=`. Prénom résolu via Admin API + `profiles.prenom`
  (fallback "Salut,"). Premier envoi réel : verdoljose2@gmail.com (sub_pro
  du 2026-07-14, souscrit avant la mise en place du mail).

**2026-05-31** :
- **Endpoint `POST /api/billing/cancel-subscription`** dans `api/_billing.js`.
  Auth Bearer JWT. Lookup `stripe_subscription_id` dans `user_credits`,
  appelle `stripe.subscriptions.update(subId, { cancel_at_period_end: true })`.
  Idempotent (no-op silencieux si déjà `cancel_at_period_end` ou
  `status: 'canceled'`). Renvoie `{ ok: false, reason: 'missing_sub_id' }`
  si l'user a un `monthly_grant > 0` mais pas de `stripe_subscription_id`
  côté DB (cas des abos pré-fix-webhook 2026-05-27) — le front bascule
  alors sur le mailto contact, pas de régression. La notif ops part
  automatiquement via le handler `customer.subscription.updated`
  existant (event coché côté Stripe Dashboard 2026-05-31).

**2026-05-27** :
- **Newsletter mensuelle utilisateurs** (`lib/newsletter.js`,
  `api/_newsletter.js`, mount dans `server.js`). Stats par user via
  Supabase service_role, 2 templates HTML light-only (charte amber
  `#f5b056` / `#d4900e`), pool de 12 conseils rotatifs, envoi Resend
  avec header `List-Unsubscribe`. Params `?month=YYYY-MM`, `?wide=1`
  (fenêtre 2 mois pour premier envoi), `?only=email1,email2` (bypass
  liste admins), `?dry=1`, `?secret=` (auth en query pour iPhone).
  GET `/preview?email=...` pour preview HTML sans envoi.
- **Notif intention d'annulation** — handler
  `customer.subscription.updated` dans `_billing.js` qui détecte la
  transition `cancel_at_period_end: false → true` via
  `event.data.previous_attributes`. Notif ops uniquement, pas de
  mouvement DB (l'abo reste actif jusqu'à `current_period_end`, puis
  le handler `.deleted` existant prend le relais).

**2026-05-26** :
- **Fix webhook Stripe abonnements** (commit 8eb9f64) — API Stripe
  basil/clover (2025-04-30) déplace `invoice.subscription` vers
  `invoice.parent.subscription_details.subscription` et supprime
  `invoice.charge`. Helpers `getInvoiceSubscriptionId(invoice)` et
  `fetchStripeNetForInvoice()` lisent les 2 formats. Symptôme avant fix :
  le sub Indie 14,99€ de TbGKrKW0qWrCx6Y débité par Stripe sans
  contrepartie côté Versions (silencieusement rejeté).

**2026-05-21** : voir détail dans `~/versions-app/CLAUDE.md` section
"Livré 2026-05-21" (hotfix ReferenceError persistAnalysisResult,
patch IPv6 rateLimit, garde-fou LUFS aberrant, refonte
question "masterisé ?").

## Écoute express plugin (`/api/plugin/express`)

Phase 3 niveau 2 du plugin DAW. Reçoit un extrait WAV ~30-60 s en multipart
(`ExpressClient` côté plugin), lance une écoute Gemini courte
(`lib/gemini.js::analyzeListening` sur buffer inline, < 20 Mo) et renvoie un
verdict texte dans le chat du plugin.

Garde-fou coût (migration `versions-app/supabase/migrations/033_plugin_express_quota.sql`,
**APPLIQUÉE sur Supabase le 2026-06-05**) :
- Table `plugin_express_usage` (user_id + mois 'YYYY-MM' + compteur).
- RPC `plugin_express_consume()` (SECURITY DEFINER, lit `auth.uid()`,
  check + incrément atomique avec `for update`, 15 écoutes/mois) appelée
  AVANT l'écoute — 429 `express_quota` si dépassé.
- RPC `plugin_express_refund()` appelée dans le catch si l'écoute Gemini
  échoue (politique "jamais débiter sur échec", cf. crédits 4 paliers).
- Appel via le JWT user (`Authorization: Bearer`) → quota effectif
  seulement quand le plugin envoie un token (Phase 2.B auth). Sans token =
  mode dégradé (helper `callExpressQuotaRpc` renvoie null, pas de blocage).

### Profil utilisateur + mode stem (DÉPLOYÉ, commits 1b55c40 / 4cc8afb)

`/api/plugin/express` lit 4 champs de form optionnels (`userLevel`,
`userMonitors`, `userHeadphones`, `userGenres`) + `channelType`, et les injecte
dans le prompt Gemini via `opts.extraContext` (apposé au prompt dans
`lib/gemini.js::analyzeListening`) :
- **Profil** : bloc « contexte d'écoute SEULEMENT, n'en parle que si un point y
  gagne » (niveau → vocabulaire ; monitors/casques → contextualiser sans
  inventer de specs).
- **Mode stem** : si `channelType` n'est pas un bus de somme (`/master|mix
  bus|music bus/i`), bascule en « PISTE ISOLÉE » → évalue comme un stem
  (timbre/dynamique/transitoires), NE commente PAS l'absence des autres
  instruments ni l'équilibre du mix, étiquetage prudent des instruments
  (« le bas du spectre de ce bus », pas « la basse »).
- Sur `main` = en phase avec `origin/main` → **auto-déployé sur Railway**.
  Validé par David (drum bus / instrument bus). Réf : `versions-plugin/docs/
  EXPRESS_PROFILE_BACKEND.md`.

## Points en suspens

- **Configurer cron mensuel newsletter** sur cron-job.org (ou Railway
  cron) — `0 9 1 * *`, POST `https://<api>/api/newsletter/send` avec
  header `X-Admin-Secret`. Sans `?wide=1` (le premier envoi manuel l'a
  déjà utilisé, les suivants couvrent juste le mois écoulé).
- **Corriger le barème des verdicts** : 75/100 ne devrait pas
  déclencher "aïe aïe aïe". La calibration vit dans le system prompt
  de `lib/claude.js` (cherche "ECHELLE GLOBALE OBLIGATOIRE" et les
  consignes verdict). Probablement à remonter le seuil "verdict
  négatif" autour de 60-65 et ajouter une zone neutre 70-79.
- **Vérifier le domaine versions.studio dans Resend** (DNS SPF/DKIM).
  Sans ça, les mails partant avec `from: Versions <contact@versions.studio>`
  échouent — actuellement `RESEND_USER_FROM` peut fallback sur
  `onboarding@resend.dev` mais c'est moche en prod.
- **Idempotence des notifs ops** (faible priorité) — Stripe peut retry
  un event sur transient failure → mail dupliqué. Pas de table dédiée
  pour l'instant. Si ça devient bruyant, créer `notified_stripe_events`
  avec UNIQUE sur `event_id`.
- **Enrichir le pool de conseils newsletter** (`lib/newsletter.js`) —
  actuellement `CONSEILS_DU_MOIS` = 12 entrées (un par mois, rotatif
  annuel) et `IDEES_PROCHAINE_SESSION` = 4 entrées (template inactif).
  Les users qui restent abonnés reçoivent toujours le même conseil au
  même mois d'une année sur l'autre. Passer à **36+ tips** côté actif
  (mix, monitoring, workflow DAW, mastering prep) et étoffer les idées
  du template inactif. Stratégie de rotation à revoir : hash
  `(userId, month)` pour ne pas envoyer 2 fois le même conseil à un
  même user. **À terme** : conseils dynamiques basés sur les vraies
  analyses du mois (recurring weaknesses dans les fiches → conseil
  ciblé). Tracké aussi dans `~/versions-app/docs/ROADMAP.md` Bloc 4.

## Abonnements annuels (2026-11-11)

- `scripts/init_stripe_catalog.js` : `ANNUAL_SUBSCRIPTIONS` (69 / 149 / 299 €), prix `recurring.interval = 'year'` posé sur le MÊME produit que le mensuel, `metadata.credits` = enveloppe MENSUELLE, `metadata.plan_key` = clé de base. Lancer avec `--only=sub_solo_year,sub_indie_year,sub_pro_year` (sinon doublons de prix). Le script charge `.env.bench` (y poser `STRIPE_SECRET_KEY`). Si `STRIPE_PRICE_WHITELIST` est définie sur Railway, y ajouter les 3 nouveaux prix.
- `api/_billing.js` : `handleSubscriptionInvoice` lit `price.recurring.interval`. Annuel → livre le 1er mois, `monthly_renews_at` = début de période + 1 mois, écrit `sub_interval / sub_period_start / sub_period_end` (UPDATE séparé ; si la migration 059 manque, un abonnement annuel fait échouer le webhook pour que Stripe rejoue, un mensuel journalise seulement). Les 11 mois suivants sont livrés EN BASE par `grant_annual_monthly_credits()` (pg_cron horaire, migration 059 dans versions-app) — aucun code API.
- `GET /api/billing/subscription` renvoie `interval` et `nextGrantAt`. `POST /pause-subscription` refuse l'annuel (`annual_no_pause`).
- `customer.subscription.deleted` remet `sub_interval / sub_period_*` à NULL (monthly_grant = 0 arrête déjà la livraison).
- Libellés Solo ajoutés à `lib/welcomeSubscriber.js` (PLAN_META) et `lib/lifecycleEmails.js` (PLAN_LABELS).
