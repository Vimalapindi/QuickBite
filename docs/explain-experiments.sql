-- Reproduces the "before/after index" numbers in LOADTEST.md. Run against a scratch database:
--   psql -U quickbite -d quickbite_test -f docs/explain-experiments.sql
-- Timings differ per machine; compare the plan shapes and the ratio.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DROP TABLE IF EXISTS exp_items, exp_orders;
CREATE TABLE exp_items AS SELECT g AS id,
  (ARRAY['Spicy','Royal','Golden','Smoky','Fresh'])[1+g%5] || ' ' || (ARRAY['Biryani','Pizza','Noodles','Burger','Curry','Wrap','Taco','Salad'])[1+g%8] || ' ' || g AS name
  FROM generate_series(1,500000) g;
CREATE TABLE exp_orders AS SELECT g AS id, (g % 20000) AS rid,
  (ARRAY['PLACED','PAID','CONFIRMED','DELIVERED','DELIVERED','DELIVERED'])[1+g%6] AS status, now() - (g || ' seconds')::interval AS placed
  FROM generate_series(1,500000) g;
ANALYZE exp_items; ANALYZE exp_orders;

\echo '--- BEFORE: dish search without index'
EXPLAIN (ANALYZE) SELECT id FROM exp_items WHERE name ILIKE '%biryani 4242%';
CREATE INDEX exp_items_trgm ON exp_items USING gin (name gin_trgm_ops); ANALYZE exp_items;
\echo '--- AFTER: GIN trigram index'
EXPLAIN (ANALYZE) SELECT id FROM exp_items WHERE name ILIKE '%biryani 4242%';

\echo '--- BEFORE: restaurant order list without index'
EXPLAIN (ANALYZE) SELECT id FROM exp_orders WHERE rid = 777 AND status = 'DELIVERED' ORDER BY placed DESC LIMIT 20;
CREATE INDEX exp_orders_idx ON exp_orders (rid, status, placed DESC); ANALYZE exp_orders;
\echo '--- AFTER: composite index'
EXPLAIN (ANALYZE) SELECT id FROM exp_orders WHERE rid = 777 AND status = 'DELIVERED' ORDER BY placed DESC LIMIT 20;
DROP TABLE exp_items, exp_orders;
