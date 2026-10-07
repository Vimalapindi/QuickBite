"""Generates monitoring/grafana/dashboards/quickbite.json. Re-run after editing: python monitoring/make_dashboard.py"""
import json, pathlib

DS = {"type": "prometheus", "uid": "prometheus"}
panels, pid = [], 0

def panel(title, exprs, x, y, w=8, h=8, unit="short", kind="timeseries", desc=""):
    global pid
    pid += 1
    p = {
        "id": pid, "type": kind, "title": title, "description": desc, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": {"unit": unit, "custom": {"lineWidth": 2, "fillOpacity": 12}}, "overrides": []},
        "targets": [{"refId": chr(65 + i), "expr": e, "legendFormat": l, "datasource": DS} for i, (e, l) in enumerate(exprs)],
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
    }
    if kind == "stat":
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "value"}
    panels.append(p)

def row(title, y):
    global pid
    pid += 1
    panels.append({"id": pid, "type": "row", "title": title, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "collapsed": False})

R = "$__rate_interval"
row("Traffic, latency and errors (RED)", 0)
panel("Requests per second", [(f'sum(rate(http_requests_total{{job="quickbite-api"}}[{R}]))', "total"), (f'sum by (route) (rate(http_requests_total{{job="quickbite-api"}}[{R}]))', "{{route}}")], 0, 1, unit="reqps")
panel("Latency percentiles", [(f'histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket[{R}])))', "p50"), (f'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[{R}])))', "p95"), (f'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[{R}])))', "p99")], 8, 1, unit="s", desc="Computed from histogram buckets, across all routes")
panel("p95 latency by route", [(f'histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[{R}])))', "{{route}}")], 16, 1, unit="s")
panel("Error rate (5xx)", [(f'sum(rate(http_requests_total{{status=~"5.."}}[{R}])) / sum(rate(http_requests_total[{R}]))', "5xx ratio")], 0, 9, unit="percentunit")
panel("Responses by status class", [(f'sum by (status) (rate(http_requests_total[{R}]))', "{{status}}")], 8, 9, unit="reqps")
panel("Rate-limit rejections (429) per second", [(f'sum by (scope) (rate(rate_limit_rejections_total[{R}]))', "{{scope}}")], 16, 9, unit="reqps")

row("Cache and database", 17)
panel("Cache hit ratio", [(f'sum(rate(cache_operations_total{{result="hit"}}[{R}])) / (sum(rate(cache_operations_total{{result="hit"}}[{R}])) + sum(rate(cache_operations_total{{result="miss"}}[{R}])))', "overall"), (f'sum by (cache) (rate(cache_operations_total{{result="hit"}}[{R}])) / (sum by (cache) (rate(cache_operations_total{{result="hit"}}[{R}])) + sum by (cache) (rate(cache_operations_total{{result="miss"}}[{R}])))', "{{cache}}")], 0, 18, unit="percentunit", desc="hits / (hits + misses)")
panel("Cache operations per second", [(f'sum by (cache, result) (rate(cache_operations_total[{R}]))', "{{cache}} {{result}}")], 8, 18, unit="ops")
panel("Postgres pool connections", [('db_pool_connections{job="quickbite-api"}', "{{state}}")], 16, 18, desc="'waiting' > 0 means requests are queueing for a DB connection: the pool is the bottleneck")

row("Orders, queue and real-time", 26)
panel("Orders created per second", [(f'sum by (outcome) (rate(orders_created_total[{R}]))', "{{outcome}}")], 0, 27, unit="ops")
panel("Order status transitions per second", [(f'sum by (to) (rate(order_status_transitions_total[{R}]))', "{{to}}")], 8, 27, unit="ops")
panel("WebSocket connections", [('sum(websocket_connections)', "connected clients")], 16, 27)
panel("Outbox backlog (unpublished events)", [('outbox_unpublished_events', "backlog")], 0, 35, desc="Should hover near 0. A growing backlog means RabbitMQ or the relay is falling behind")
panel("Outbox publish lag p95", [(f'histogram_quantile(0.95, sum by (le) (rate(outbox_publish_lag_seconds_bucket[{R}])))', "p95")], 8, 35, unit="s")
panel("Queue messages consumed per second", [(f'sum by (queue, result) (rate(queue_messages_consumed_total[{R}]))', "{{queue}} {{result}}")], 16, 35, unit="ops", desc="result=retry/dead indicates failures; dead = moved to the DLQ")
panel("Queue handler duration p95", [(f'histogram_quantile(0.95, sum by (le, queue) (rate(queue_message_processing_seconds_bucket[{R}])))', "{{queue}}")], 0, 43, unit="s")

row("Process resources (API and worker)", 51)
panel("CPU usage (cores)", [(f'rate(process_cpu_seconds_total[{R}])', "{{job}}")], 0, 52, unit="none", desc="1.0 = one full core")
panel("Resident memory", [('process_resident_memory_bytes', "{{job}}")], 8, 52, unit="bytes")
panel("Event loop lag p99", [('nodejs_eventloop_lag_p99_seconds', "{{job}}")], 16, 52, unit="s", desc="High lag = the Node.js thread is saturated (CPU-bound work blocking requests)")
panel("Heap used", [('nodejs_heap_size_used_bytes', "{{job}}")], 0, 60, unit="bytes")
panel("GC pause time", [(f'sum by (job) (rate(nodejs_gc_duration_seconds_sum[{R}]))', "{{job}}")], 8, 60, unit="s")
panel("Targets up", [('up', "{{job}}")], 16, 60)

dash = {
    "uid": "quickbite-overview", "title": "QuickBite Overview", "tags": ["quickbite"], "timezone": "browser",
    "schemaVersion": 39, "version": 1, "refresh": "5s", "time": {"from": "now-15m", "to": "now"},
    "panels": panels,
}
out = pathlib.Path(__file__).parent / "grafana" / "dashboards" / "quickbite.json"
out.write_text(json.dumps(dash, indent=2))
print(f"wrote {out} with {len([p for p in panels if p['type'] != 'row'])} panels")
