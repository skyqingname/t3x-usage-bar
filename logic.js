// 纯逻辑：窗口筛选、百分比与重置时间格式化、套餐提取。
// 浏览器中与 web.js 拼接在 function(host) 内执行；Node 测试通过 @node-only 导出。

const GLANCE_KINDS = ["session", "weekly"];
const MINUTES_PER_DAY = 24 * 60;

const DRIVER_META = {
  claudeAgent: { label: "Claude", short: "C", color: "#d97757" },
  anthropic: { label: "Anthropic", short: "A", color: "#d97757" },
  codex: { label: "Codex", short: "O", color: "currentColor" },
  openai: { label: "OpenAI", short: "O", color: "currentColor" },
  antigravity: { label: "Antigravity", short: "G", color: "#5b87bf" },
  gemini: { label: "Gemini", short: "G", color: "#5b87bf" },
  cursor: { label: "Cursor", short: "Cu", color: "currentColor" },
  opencode: { label: "OpenCode", short: "OC", color: "currentColor" },
  openrouter: { label: "OpenRouter", short: "OR", color: "currentColor" },
  ollama: { label: "Ollama", short: "OL", color: "currentColor" },
};

function remainingPercent(win) {
  const used = Number(win?.usedPercent);
  if (!Number.isFinite(used)) return 0;
  return Math.round(100 - Math.max(0, Math.min(100, used)));
}

function tightestWindow(windows) {
  return windows.reduce((low, next) =>
    remainingPercent(next) < remainingPercent(low) ? next : low,
  );
}

/** 取最紧的 5h（session）和 7d（weekly）窗口；都没有时取全局最紧的窗口。 */
function glanceWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return [];
  const byKind = [];
  for (const kind of GLANCE_KINDS) {
    const matching = windows.filter((entry) => entry && entry.kind === kind);
    if (matching.length > 0) byKind.push(tightestWindow(matching));
  }
  if (byKind.length > 0) return byKind;
  return [tightestWindow(windows)];
}

function windowTag(entry) {
  const mins = entry?.windowDurationMins;
  if (typeof mins === "number" && Number.isFinite(mins) && mins > 0) {
    return mins % MINUTES_PER_DAY === 0
      ? `${mins / MINUTES_PER_DAY}d`
      : `${Math.round(mins / 60)}h`;
  }
  return String(entry?.label ?? entry?.id ?? "");
}

function usageTone(leftPercent) {
  if (leftPercent <= 10) return "error";
  if (leftPercent <= 20) return "warning";
  return null;
}

function contextTone(usedPercent) {
  if (usedPercent === null) return null;
  if (usedPercent >= 90) return "error";
  if (usedPercent >= 80) return "warning";
  return null;
}

function formatContextTokens(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 999500) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatDuration(ms, isZh) {
  const totalMins = Math.max(1, Math.round(ms / 60000));
  const days = Math.floor(totalMins / MINUTES_PER_DAY);
  const hours = Math.floor((totalMins % MINUTES_PER_DAY) / 60);
  const mins = totalMins % 60;
  if (days > 0) {
    if (hours > 0) return isZh ? `${days}天${hours}小时` : `${days}d ${hours}h`;
    return isZh ? `${days}天` : `${days}d`;
  }
  if (hours > 0) {
    if (mins > 0) return isZh ? `${hours}小时${mins}分钟` : `${hours}h ${mins}m`;
    return isZh ? `${hours}小时` : `${hours}h`;
  }
  return isZh ? `${mins}分钟` : `${mins}m`;
}

function formatUpcomingTime(iso, now, isZh) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts);
  const nowDate = new Date(now);
  const sameDay =
    date.getFullYear() === nowDate.getFullYear() &&
    date.getMonth() === nowDate.getMonth() &&
    date.getDate() === nowDate.getDate();
  const locale = isZh ? "zh-CN" : "en-US";
  const opts = sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

function providerTitle(provider) {
  const custom = typeof provider?.displayName === "string" ? provider.displayName.trim() : "";
  if (custom) return custom;
  const meta = DRIVER_META[provider?.driver];
  return meta ? meta.label : String(provider?.driver ?? "Provider");
}

function providerMeta(provider) {
  const meta = DRIVER_META[provider?.driver];
  const title = providerTitle(provider);
  return {
    title,
    short: meta ? meta.short : title.slice(0, 2).toUpperCase(),
    color: provider?.accentColor || (meta ? meta.color : "currentColor"),
  };
}

function extractAccounts(providers) {
  if (!Array.isArray(providers)) return [];
  const result = [];
  const seen = new Set();
  for (const p of providers) {
    if (!p || !p.usageLimits || !Array.isArray(p.usageLimits.windows)) continue;
    if (p.usageLimits.windows.length === 0) continue;
    const key = String(p.instanceId ?? `${p.driver}:${providerTitle(p)}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = providerMeta(p);
    const plan =
      (typeof p.usageLimits.plan === "string" && p.usageLimits.plan.trim()) ||
      (typeof p.auth?.plan === "string" && p.auth.plan.trim()) ||
      null;
    result.push({
      key,
      instanceId: p.instanceId ?? null,
      driver: p.driver ?? "",
      title: meta.title,
      short: meta.short,
      color: meta.color,
      plan,
      windows: p.usageLimits.windows,
    });
  }
  return result;
}

function findActiveWindows(providerInstanceId, providers, model) {
  if (!providerInstanceId || !Array.isArray(providers)) return null;
  const match = providers.find((p) => p && p.instanceId === providerInstanceId);
  const windows = match?.usageLimits?.windows;
  if (!Array.isArray(windows) || windows.length === 0) return null;
  // 带 modelIds 的窗口只挡列出的模型（比如 Antigravity 的 Gemini 和 Claude / GPT 各有额度）：只看挡得住当前模型的
  const limiting = model ? windows.filter((w) => !Array.isArray(w?.modelIds) || w.modelIds.includes(model)) : windows;
  return limiting.length > 0 ? limiting : windows;
}

function normalizeContext(context) {
  if (!context || typeof context.usedTokens !== "number" || !Number.isFinite(context.usedTokens)) {
    return null;
  }
  const maxTokens =
    typeof context.maxTokens === "number" && Number.isFinite(context.maxTokens) && context.maxTokens > 0
      ? context.maxTokens
      : null;
  const rawPct =
    maxTokens !== null && typeof context.usedPercentage === "number" && Number.isFinite(context.usedPercentage)
      ? context.usedPercentage
      : maxTokens !== null
        ? (context.usedTokens / maxTokens) * 100
        : null;
  const used = rawPct !== null ? Math.round(Math.max(0, Math.min(100, rawPct))) : null;
  const threshold =
    typeof context.autoCompactThreshold === "number" &&
    Number.isFinite(context.autoCompactThreshold) &&
    context.autoCompactThreshold > 0
      ? context.autoCompactThreshold
      : null;
  return {
    usedTokens: context.usedTokens,
    maxTokens,
    used,
    level: contextTone(used),
    threshold,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    remainingPercent,
    glanceWindows,
    windowTag,
    usageTone,
    contextTone,
    formatContextTokens,
    formatDuration,
    formatUpcomingTime,
    extractAccounts,
    findActiveWindows,
    normalizeContext,
  };
}
