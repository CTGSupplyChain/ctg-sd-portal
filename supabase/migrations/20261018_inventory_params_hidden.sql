-- Hidden SKUs (master_sku.hidden_at) are out of scope of v_inventory_params.
-- Per-brand inventory policy: inventory_policy_brand overrides inventory_policy_config (id=1) column by column.
-- v_inventory_params now resolves settings per brand. With no override rows its output is identical to before.
create or replace view public.v_inventory_params with (security_invoker = on) as
WITH last_wk AS (
  SELECT max(week_start_date) AS d FROM sales_history
), cfgb AS (
  SELECT b.brand,
    COALESCE(o.z_a, g.z_a) AS z_a, COALESCE(o.z_b, g.z_b) AS z_b, COALESCE(o.z_c, g.z_c) AS z_c,
    COALESCE(o.abc_a_cut, g.abc_a_cut) AS abc_a_cut, COALESCE(o.abc_b_cut, g.abc_b_cut) AS abc_b_cut,
    COALESCE(o.cv_cap, g.cv_cap) AS cv_cap, COALESCE(o.default_cv, g.default_cv) AS default_cv,
    COALESCE(o.min_history_wk, g.min_history_wk) AS min_history_wk,
    COALESCE(o.run_rate_weeks, g.run_rate_weeks) AS run_rate_weeks,
    COALESCE(o.review_wk, g.review_wk) AS review_wk, COALESCE(o.lt_sigma_wk, g.lt_sigma_wk) AS lt_sigma_wk,
    COALESCE(o.order_cost_rm, g.order_cost_rm) AS order_cost_rm, COALESCE(o.holding_rate, g.holding_rate) AS holding_rate,
    COALESCE(o.planning_basis, g.planning_basis) AS planning_basis
  FROM (SELECT DISTINCT brand FROM master_sku) b
  CROSS JOIN (SELECT * FROM inventory_policy_config WHERE id = 1) g
  LEFT JOIN inventory_policy_brand o ON lower(o.brand) = lower(b.brand)
), scope AS (
  SELECT m.sku, m.brand, m.project_id, m.description, m.status,
    GREATEST(COALESCE(m.lead_time_wk, 4), 1) AS lt, COALESCE(m.moq, 0) AS moq, m.landed_price,
    c.z_a, c.z_b, c.z_c, c.abc_a_cut, c.abc_b_cut, c.cv_cap, c.default_cv, c.min_history_wk,
    c.run_rate_weeks, c.review_wk, c.lt_sigma_wk, c.order_cost_rm, c.holding_rate, c.planning_basis
  FROM master_sku m JOIN cfgb c ON c.brand = m.brand
  WHERE m.status = 'Active' AND m.hidden_at IS NULL AND NOT (m.sku IN (SELECT old_sku FROM sku_successor))
), wks AS (
  SELECT s.sku, g.wk::date AS wk
  FROM scope s, last_wk,
  LATERAL generate_series((last_wk.d - 7 * (GREATEST(s.run_rate_weeks, 26) - 1))::timestamp with time zone, last_wk.d::timestamp with time zone, '7 days'::interval) g(wk)
), series AS (
  SELECT w.sku, w.wk, COALESCE(sum(h.qty), 0::bigint)::numeric AS q
  FROM wks w LEFT JOIN sales_history h ON h.sku = w.sku AND h.week_start_date = w.wk
  GROUP BY w.sku, w.wk
), run AS (
  SELECT s.sku,
    avg(s.q) FILTER (WHERE s.wk > ((SELECT d FROM last_wk) - 7 * sc.run_rate_weeks)) AS mu_run,
    stddev_samp(s.q) FILTER (WHERE s.wk > ((SELECT d FROM last_wk) - 7 * sc.run_rate_weeks)) AS sd_wk,
    count(*) FILTER (WHERE s.q > 0::numeric) AS wks_with_sales,
    sum(s.q) AS total_26wk
  FROM series s JOIN scope sc ON sc.sku = s.sku
  GROUP BY s.sku
), roll AS (
  SELECT s.sku, sum(s2.q) AS bucket
  FROM series s JOIN scope sc ON sc.sku = s.sku
  JOIN series s2 ON s2.sku = s.sku AND s2.wk > (s.wk - 7 * sc.lt) AND s2.wk <= s.wk
  WHERE s.wk >= ((SELECT d FROM last_wk) - 7 * 25 + 7 * (sc.lt - 1))
  GROUP BY s.sku, s.wk
), cvlt AS (
  SELECT roll.sku, CASE WHEN avg(roll.bucket) > 0::numeric THEN stddev_samp(roll.bucket) / avg(roll.bucket) ELSE NULL::numeric END AS cv_lt
  FROM roll GROUP BY roll.sku
), fc AS (
  SELECT f.sku, sum(f.forecast_qty)::numeric / 13::numeric AS mu_fc
  FROM demand_forecast f
  WHERE f.model_used <> 'superseded'::text
    AND f.week_start_date >= date_trunc('week'::text, CURRENT_DATE::timestamp with time zone)::date
    AND f.week_start_date < (date_trunc('week'::text, CURRENT_DATE::timestamp with time zone)::date + 91)
  GROUP BY f.sku
), stock AS (
  SELECT v_stock_current.portal_sku AS sku, COALESCE(v_stock_current.usable_current, 0) AS usable,
    COALESCE(v_stock_current.incoming_current, 0) AS incoming, v_stock_current.snapshot_date
  FROM v_stock_current
), base AS (
  SELECT sc.*, r.mu_run, r.sd_wk, r.wks_with_sales, COALESCE(f.mu_fc, 0::numeric) AS mu_fc,
    CASE sc.planning_basis
      WHEN 'run_rate'::text THEN COALESCE(r.mu_run, 0::numeric)
      WHEN 'forecast'::text THEN COALESCE(f.mu_fc, 0::numeric)
      ELSE GREATEST(COALESCE(r.mu_run, 0::numeric), COALESCE(f.mu_fc, 0::numeric))
    END AS mu,
    CASE WHEN r.wks_with_sales < sc.min_history_wk OR c.cv_lt IS NULL THEN sc.default_cv ELSE LEAST(c.cv_lt, sc.cv_cap) END AS cv_used,
    CASE WHEN r.wks_with_sales < sc.min_history_wk OR c.cv_lt IS NULL THEN 'default'::text ELSE 'measured'::text END AS cv_source,
    CASE WHEN r.mu_run > 0::numeric THEN r.sd_wk / r.mu_run ELSE NULL::numeric END AS cv_wk,
    COALESCE(st.usable, 0) AS usable, COALESCE(st.incoming, 0) AS incoming, st.snapshot_date
  FROM scope sc
  LEFT JOIN run r ON r.sku = sc.sku LEFT JOIN cvlt c ON c.sku = sc.sku
  LEFT JOIN fc f ON f.sku = sc.sku LEFT JOIN stock st ON st.sku = sc.sku
), abc AS (
  SELECT b.*, b.mu * 52::numeric AS annual_units,
    b.mu * 52::numeric * COALESCE(b.landed_price, 0::numeric) AS annual_value,
    sum(b.mu * 52::numeric * COALESCE(b.landed_price, 0::numeric)) OVER (PARTITION BY b.brand ORDER BY (b.mu * 52::numeric * COALESCE(b.landed_price, 0::numeric)) DESC, b.sku)
      / NULLIF(sum(b.mu * 52::numeric * COALESCE(b.landed_price, 0::numeric)) OVER (PARTITION BY b.brand), 0::numeric) AS cum_share
  FROM base b
), cls AS (
  SELECT a.*,
    CASE WHEN a.landed_price IS NULL OR a.annual_value = 0::numeric THEN 'C'::text
         WHEN a.cum_share <= a.abc_a_cut THEN 'A'::text
         WHEN a.cum_share <= a.abc_b_cut THEN 'B'::text ELSE 'C'::text END AS abc,
    CASE WHEN a.cv_wk IS NULL THEN 'Z'::text WHEN a.cv_wk < 0.5 THEN 'X'::text WHEN a.cv_wk < 1.0 THEN 'Y'::text ELSE 'Z'::text END AS xyz
  FROM abc a
), calc AS (
  SELECT c.*, CASE c.abc WHEN 'A'::text THEN c.z_a WHEN 'B'::text THEN c.z_b ELSE c.z_c END AS z FROM cls c
), p AS (
  SELECT k.*, round(sqrt(power(k.z * k.cv_used * k.mu * k.lt::numeric, 2::numeric) + power(k.z * k.mu * k.lt_sigma_wk, 2::numeric))) AS ss FROM calc k
)
SELECT sku, brand, project_id, description, lt AS lead_time_wk, moq, landed_price,
  round(mu_run, 1) AS run_rate_wk, round(mu_fc, 1) AS forecast_wk, round(mu, 1) AS planning_wk,
  planning_basis, round(cv_used, 2) AS cv_lt, cv_source, abc, xyz, abc || xyz AS segment, z,
  ss AS safety_stock,
  round(mu * lt::numeric + ss) AS rop_min,
  round(mu * (lt::numeric + review_wk) + ss) AS max_level,
  CASE WHEN landed_price > 0::numeric AND mu > 0::numeric
       THEN GREATEST(round(sqrt(2::numeric * mu * 52::numeric * order_cost_rm / (holding_rate * landed_price))), moq::numeric)
       ELSE moq::numeric END AS eoq,
  usable, incoming, usable + incoming AS stock_position, snapshot_date,
  CASE WHEN mu > 0::numeric THEN round(usable::numeric / mu, 1) ELSE NULL::numeric END AS woc_usable,
  CASE
    WHEN mu = 0::numeric THEN 0::numeric
    WHEN (usable + incoming)::numeric > round(mu * lt::numeric + ss) THEN 0::numeric
    WHEN moq > 0 THEN ceil((round(mu * (lt::numeric + review_wk) + ss) - (usable + incoming)::numeric) / moq::numeric) * moq::numeric
    ELSE round(mu * (lt::numeric + review_wk) + ss) - (usable + incoming)::numeric
  END AS suggested_order_qty,
  CASE
    WHEN mu = 0::numeric AND usable > 0 THEN 'No demand'::text
    WHEN mu = 0::numeric THEN 'No signal'::text
    WHEN usable <= 0 THEN 'Stocked out'::text
    WHEN usable::numeric < ss THEN 'Below safety stock'::text
    WHEN (usable + incoming)::numeric <= round(mu * lt::numeric + ss) THEN 'Order now'::text
    WHEN usable::numeric > (1.5 * round(mu * (lt::numeric + review_wk) + ss)) THEN 'Excess'::text
    ELSE 'OK'::text
  END AS status,
  (SELECT d FROM last_wk) AS sales_through,
  review_wk,
  CASE WHEN mu > 0::numeric THEN round((mu * (lt::numeric + review_wk) + ss) / mu, 1) ELSE NULL::numeric END AS target_woc
FROM p;
