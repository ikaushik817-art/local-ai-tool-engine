// Simple counters for "is it healthy?". Shown at /api/metrics in the usual Prometheus text format, when you set
// AI_METRICS_TOKEN. Kept in memory: they start from zero when the server restarts.
const counters = new Map();
const started = Date.now();

const key = (name, labels) => `${name}${labels && Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, "_")}"`).join(",")}}` : ""}`;
export const inc = (name, labels, by = 1) => counters.set(key(name, labels), (counters.get(key(name, labels)) ?? 0) + by);

export function render(extra = {}) {
    const lines = [
        "# HELP late_uptime_seconds Seconds since the server started.",
        "# TYPE late_uptime_seconds gauge",
        `late_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`,
        ...Object.entries(extra).map(([name, value]) => `${name} ${value}`),
        "# TYPE late_events_total counter",
        ...[...counters.entries()].sort().map(([k, v]) => `${k} ${Number(v.toFixed(3))}`)
    ];
    return `${lines.join("\n")}\n`;
}

export const reset = () => counters.clear();
