-- scripts/plugin_install_stats.sql
-- RPC consommée par api/_stats.js (GET /api/stats/downloads).
-- Appliquée directement sur Supabase (projet GoldeyMusic). Conservée ici
-- pour la traçabilité / un éventuel redéploiement.
--
-- « Installation unique » = un couple (email, plateforme), daté à sa 1re
-- occurrence. Ré-installs et mises à jour (même email+plateforme) ne comptent
-- qu'une fois ; le multi-plateforme (Mac + PC) compte deux installs. Les
-- emails passés dans exclude_emails (équipe interne) sont retirés des totaux.
-- La somme du breakdown quotidien (90 j) est toujours == total.

CREATE OR REPLACE FUNCTION public.plugin_install_stats(exclude_emails text[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH installs AS (
    SELECT lower(email) AS email, platform, min(created_at) AS installed_at
    FROM public.plugin_downloads
    WHERE email IS NOT NULL AND email <> ''
      AND lower(email) <> ALL (
        SELECT lower(trim(e)) FROM unnest(coalesce(exclude_emails, '{}')) AS e
      )
    GROUP BY lower(email), platform
  ),
  today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d),
  days AS (
    SELECT (t.d - g)::date AS day
    FROM today t, generate_series(0, 89) AS g
  ),
  per_day AS (
    SELECT (installed_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM installs
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'total',        (SELECT count(*) FROM installs),
    'last_7_days',  (SELECT count(*) FROM installs WHERE installed_at >= now() - interval '7 days'),
    'last_30_days', (SELECT count(*) FROM installs WHERE installed_at >= now() - interval '30 days'),
    'daily', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', coalesce(p.n, 0))
          ORDER BY d.day
        ), '[]'::jsonb)
      FROM days d
      LEFT JOIN per_day p ON p.day = d.day
    )
  );
$$;

REVOKE ALL ON FUNCTION public.plugin_install_stats(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_install_stats(text[]) TO service_role;
