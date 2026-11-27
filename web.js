// 用量与上下文状态栏：订阅 chat.overlay 状态，挂载到对话顶栏右侧和主输入框下方。
const { React, h } = host;

const DEFAULT_PREFS = {
  showHeader: true,
  showComposer: true,
  showContext: true,
  showActiveUsage: true,
};

function readPrefs() {
  return {
    showHeader: host.storage.get("showHeader", DEFAULT_PREFS.showHeader) !== false,
    showComposer: host.storage.get("showComposer", DEFAULT_PREFS.showComposer) !== false,
    showContext: host.storage.get("showContext", DEFAULT_PREFS.showContext) !== false,
    showActiveUsage: host.storage.get("showActiveUsage", DEFAULT_PREFS.showActiveUsage) !== false,
  };
}

function openUsagePage() {
  if (location.hash !== "#/usage") {
    location.hash = "#/usage";
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function createDriverBadge(account) {
  const badge = el("span", "t3x-ub-badge", account.short);
  badge.dataset.driver = account.driver;
  if (account.color && account.color !== "currentColor") {
    badge.style.setProperty("--t3x-ub-accent", account.color);
  }
  return badge;
}

function appendWindowGlance(parent, windows) {
  for (const entry of glanceWindows(windows)) {
    const left = remainingPercent(entry);
    const tone = usageTone(left);
    const item = el("span", "t3x-ub-win");
    item.appendChild(el("span", "t3x-ub-muted", windowTag(entry)));
    item.appendChild(
      el("span", `t3x-ub-pct${tone ? ` t3x-ub-${tone}` : ""}`, `${left}%`),
    );
    parent.appendChild(item);
  }
}

function buildWindowTooltipLines(windows, now, isZh) {
  const frag = document.createDocumentFragment();
  for (const entry of windows) {
    const left = remainingPercent(entry);
    const row = el("div", "t3x-ub-tip-block");
    const labelText = isZh
      ? `${entry.label}：剩余 ${left}%`
      : `${entry.label}: ${left}% left`;
    row.appendChild(el("div", "t3x-ub-tip-primary", labelText));
    const resetMs = entry.resetsAt ? Date.parse(entry.resetsAt) : Number.NaN;
    if (entry.resetsAt && Number.isFinite(resetMs) && resetMs > now) {
      const dur = formatDuration(resetMs - now, isZh);
      const clock = formatUpcomingTime(entry.resetsAt, now, isZh);
      const resetText = isZh
        ? `${dur}后重置 · ${clock}`
        : `Resets in ${dur} · ${clock}`;
      row.appendChild(el("div", "t3x-ub-tip-muted", resetText));
    }
    frag.appendChild(row);
  }
  return frag;
}

// 轻量浮层提示，挂载在 document.body 上，避免被容器 overflow 裁切。
function createTooltipManager() {
  let pop = null;
  let activeAnchor = null;

  function hide() {
    activeAnchor = null;
    if (pop) {
      pop.remove();
      pop = null;
    }
  }

  function show(anchor, side, renderContent) {
    hide();
    activeAnchor = anchor;
    pop = el("div", "t3x-ub-tooltip");
    renderContent(pop);
    document.body.appendChild(pop);

    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const margin = 8;
    let left = rect.left + rect.width / 2 - popRect.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - popRect.width - margin, left));
    let top = side === "bottom" ? rect.bottom + 6 : rect.top - popRect.height - 6;
    if (top < margin) top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - popRect.height - 6);
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function attach(anchor, side, renderContent) {
    anchor.addEventListener("mouseenter", () => show(anchor, side, renderContent));
    anchor.addEventListener("mouseleave", () => {
      if (activeAnchor === anchor) hide();
    });
    anchor.addEventListener("focusin", () => show(anchor, side, renderContent));
    anchor.addEventListener("focusout", () => {
      if (activeAnchor === anchor) hide();
    });
  }

  /** 提示的锚点在 root 里面时收起（这一处要重建或移除了）；别处的提示不动。 */
  function hideIn(root) {
    for (let n = activeAnchor; n; n = n.parentElement) if (n === root) return hide();
  }

  return { hide, hideIn, attach };
}

function findHeaderNav() {
  const navs = document.querySelectorAll('nav:has([data-slot="workspace-breadcrumb-text"])');
  for (const nav of navs) {
    if (!nav.closest("[data-side-chat-pane]") && nav.parentElement) {
      return nav;
    }
  }
  return null;
}

function findComposerShell() {
  const composer = host.dom.composer();
  if (!composer) return null;
  return composer.closest('[data-slot="composer-shell"]') || composer;
}

function createController() {
  const tooltip = createTooltipManager();
  let headerNode = null;
  let composerNode = null;
  // 上次画进去的内容；一样就不重建（重建会换掉鼠标下的按钮，还会触发 MutationObserver）
  let headerSig = null;
  let composerSig = null;
  // 这一处该不该显示：只有该显示的节点被 T3 重渲染挪走了才需要重画
  let wantHeader = false;
  let wantComposer = false;
  // 挂在谁旁边：T3 把它们挪走或换掉时（我们的节点还挂在原处）也要跟过去
  let headerNav = null;
  let composerShell = null;
  let latestState = null;
  let disposed = false;
  let scheduled = false;

  function removeNodes() {
    tooltip.hide();
    wantHeader = wantComposer = false;
    headerSig = composerSig = null;
    headerNav = composerShell = null;
    if (headerNode) {
      headerNode.remove();
      headerNode = null;
    }
    if (composerNode) {
      composerNode.remove();
      composerNode = null;
    }
  }

  function renderHeader(state, prefs, isZh) {
    const accounts = prefs.showHeader ? extractAccounts(state.providers) : [];
    wantHeader = accounts.length > 0;
    headerNav = wantHeader ? findHeaderNav() : null;
    const container = headerNav?.parentElement ?? null;
    if (!container) {
      if (headerNode) {
        tooltip.hideIn(headerNode);
        headerNode.remove();
        headerNode = null;
        headerSig = null;
      }
      return;
    }

    if (!headerNode) {
      headerNode = el("div", "t3x-ub-header");
      headerNode.dataset.t3xUsageBar = "header";
    }
    if (headerNode.parentElement !== container) {
      container.appendChild(headerNode);
    }

    const sig = JSON.stringify([isZh, accounts]);
    if (sig === headerSig) return;
    headerSig = sig;
    tooltip.hideIn(headerNode);
    headerNode.textContent = "";
    for (const account of accounts) {
      const btn = el("button", "t3x-ub-pill");
      btn.type = "button";
      btn.appendChild(createDriverBadge(account));
      appendWindowGlance(btn, account.windows);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        tooltip.hide();
        openUsagePage();
      });
      tooltip.attach(btn, "bottom", (pop) => {
        const heading = account.plan ? `${account.title} · ${account.plan}` : account.title;
        pop.appendChild(el("div", "t3x-ub-tip-title", heading));
        pop.appendChild(buildWindowTooltipLines(account.windows, Date.now(), isZh));
        pop.appendChild(
          el("div", "t3x-ub-tip-hint", isZh ? "点击打开用量页" : "Click to open usage"),
        );
      });
      headerNode.appendChild(btn);
    }
  }

  function renderComposer(state, prefs, isZh) {
    const ctx = prefs.showComposer && prefs.showContext ? normalizeContext(state.context) : null;
    const windows =
      prefs.showComposer && prefs.showActiveUsage
        ? findActiveWindows(state.providerInstanceId, state.providers, state.model)
        : null;
    wantComposer = Boolean(ctx || windows);
    const shell = wantComposer ? findComposerShell() : null;
    composerShell = shell?.parentElement ? shell : null;

    if (!composerShell) {
      if (composerNode) {
        tooltip.hideIn(composerNode);
        composerNode.remove();
        composerNode = null;
        composerSig = null;
      }
      return;
    }

    if (!composerNode) {
      composerNode = el("div", "t3x-ub-composer");
      composerNode.dataset.t3xUsageBar = "composer";
    }
    if (composerNode.previousElementSibling !== shell) {
      shell.insertAdjacentElement("afterend", composerNode);
    }

    const sig = JSON.stringify([isZh, ctx, windows]);
    if (sig === composerSig) return;
    composerSig = sig;
    tooltip.hideIn(composerNode);
    composerNode.textContent = "";

    if (ctx) {
      const ctxEl = el("div", "t3x-ub-context");
      ctxEl.tabIndex = 0;
      ctxEl.appendChild(el("span", "t3x-ub-muted", isZh ? "上下文" : "Context"));
      if (ctx.used !== null) {
        const track = el("span", "t3x-ub-bar");
        const fill = el("span", `t3x-ub-bar-fill${ctx.level ? ` t3x-ub-bg-${ctx.level}` : ""}`);
        fill.style.width = `max(${ctx.used}%, 3px)`;
        track.appendChild(fill);
        ctxEl.appendChild(track);
      }
      const usedStr = formatContextTokens(ctx.usedTokens);
      const countText =
        ctx.maxTokens !== null
          ? `${usedStr} / ${formatContextTokens(ctx.maxTokens)}`
          : usedStr;
      ctxEl.appendChild(el("span", "t3x-ub-muted t3x-ub-num", countText));
      if (ctx.used !== null) {
        ctxEl.appendChild(
          el("span", `t3x-ub-pct${ctx.level ? ` t3x-ub-${ctx.level}` : ""}`, `${ctx.used}%`),
        );
      }
      tooltip.attach(ctxEl, "top", (pop) => {
        const locale = isZh ? "zh-CN" : "en-US";
        const headline =
          ctx.used !== null
            ? isZh
              ? `上下文：已用 ${ctx.used}%`
              : `Context: ${ctx.used}% used`
            : isZh
              ? `上下文：已用 ${usedStr} tokens`
              : `Context: ${usedStr} tokens used`;
        pop.appendChild(el("div", "t3x-ub-tip-primary", headline));
        if (ctx.maxTokens !== null) {
          const detail = isZh
            ? `${ctx.usedTokens.toLocaleString(locale)} / ${ctx.maxTokens.toLocaleString(locale)} tokens`
            : `${ctx.usedTokens.toLocaleString(locale)} of ${ctx.maxTokens.toLocaleString(locale)} tokens`;
          pop.appendChild(el("div", "t3x-ub-tip-muted", detail));
        }
        if (ctx.threshold !== null) {
          const thText = isZh
            ? `自动压缩阈值：${formatContextTokens(ctx.threshold)}`
            : `Auto-compacts near ${formatContextTokens(ctx.threshold)}`;
          pop.appendChild(el("div", "t3x-ub-tip-muted", thText));
        }
      });
      composerNode.appendChild(ctxEl);
    } else {
      composerNode.appendChild(el("span"));
    }

    if (windows) {
      const btn = el("button", "t3x-ub-pill");
      btn.type = "button";
      btn.appendChild(el("span", "t3x-ub-muted", isZh ? "用量" : "Usage"));
      appendWindowGlance(btn, windows);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        tooltip.hide();
        openUsagePage();
      });
      tooltip.attach(btn, "top", (pop) => {
        pop.appendChild(buildWindowTooltipLines(windows, Date.now(), isZh));
        pop.appendChild(
          el("div", "t3x-ub-tip-hint", isZh ? "点击打开用量页" : "Click to open usage"),
        );
      });
      composerNode.appendChild(btn);
    }
  }

  function paint() {
    scheduled = false;
    if (disposed) return;
    if (!latestState) {
      removeNodes();
      return;
    }
    const prefs = readPrefs();
    const isZh = host.lang() === "zh";
    renderHeader(latestState, prefs, isZh);
    renderComposer(latestState, prefs, isZh);
  }

  function schedulePaint() {
    if (disposed || scheduled) return;
    scheduled = true;
    requestAnimationFrame(paint);
  }

  // 该显示的节点不在页面上、或者没挨着它的锚点了（T3 重渲染把它或锚点挪走了，或者还没找到挂载位置）才补画。
  // 只看自己记下的几个节点，不查 DOM；自己重建内容引起的变化不会走到这里，不然只显示一处时会每帧重画
  const headerLost = () => !headerNode?.isConnected || !headerNav?.isConnected || headerNode.parentElement !== headerNav.parentElement;
  const composerLost = () => !composerNode?.isConnected || !composerShell?.isConnected || composerNode.previousElementSibling !== composerShell;
  const observer = new MutationObserver(() => {
    if (!latestState || disposed) return;
    if ((wantHeader && headerLost()) || (wantComposer && composerLost())) {
      schedulePaint();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    update(state) {
      latestState = state;
      schedulePaint();
    },
    clear() {
      latestState = null;
      removeNodes();
    },
    refresh() {
      schedulePaint();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      removeNodes();
    },
  };
}

const controller = createController();

for (const key of Object.keys(DEFAULT_PREFS)) {
  host.storage.subscribe(key, () => controller.refresh());
}

function UsageBarOverlay(props) {
  const lang = host.useLang();
  const { embedded, context, providerInstanceId, providers, threadKey, model } = props;
  React.useEffect(() => {
    if (embedded) return;
    controller.update({ context, providerInstanceId, providers, threadKey, model, lang });
  }, [embedded, context, providerInstanceId, providers, threadKey, model, lang]);

  React.useEffect(() => {
    if (embedded) return;
    return () => controller.clear();
  }, [embedded]);

  return null;
}

function UsageBarSettings({ ui }) {
  host.useLang();
  const showHeader = host.storage.use("showHeader", DEFAULT_PREFS.showHeader) !== false;
  const showComposer = host.storage.use("showComposer", DEFAULT_PREFS.showComposer) !== false;
  const showContext = host.storage.use("showContext", DEFAULT_PREFS.showContext) !== false;
  const showActiveUsage =
    host.storage.use("showActiveUsage", DEFAULT_PREFS.showActiveUsage) !== false;

  return h(
    ui.Section,
    {
      title: host.t("显示区域", "Display"),
      description: host.t(
        "控制对话顶栏与输入框下方的用量和上下文信息。",
        "Control usage and context indicators in the thread header and under the composer.",
      ),
    },
    h(
      ui.Row,
      {
        title: host.t("顶栏套餐用量", "Header plan usage"),
        description: host.t(
          "在对话顶栏右侧显示当前环境各已登录套餐的 5h / 7d 剩余额度。",
          "Show 5h / 7d remaining quota for each signed-in plan in the thread header.",
        ),
        control: h(ui.Switch, {
          checked: showHeader,
          onCheckedChange: (checked) => host.storage.set("showHeader", !!checked),
        }),
      },
    ),
    h(
      ui.Row,
      {
        title: host.t("输入框下方状态栏", "Composer footer bar"),
        description: host.t(
          "在主输入框下方显示上下文用量与当前套餐剩余额度。",
          "Show context window progress and active plan usage under the main composer.",
        ),
        control: h(ui.Switch, {
          checked: showComposer,
          onCheckedChange: (checked) => host.storage.set("showComposer", !!checked),
        }),
      },
    ),
    showComposer
      ? h(
          ui.Row,
          {
            title: host.t("显示上下文进度", "Show context progress"),
            description: host.t(
              "在输入框下方左侧显示已用 token、上限和进度细条。",
              "Show used tokens, context limit, and progress bar on the left.",
            ),
            control: h(ui.Switch, {
              checked: showContext,
              onCheckedChange: (checked) => host.storage.set("showContext", !!checked),
            }),
          },
        )
      : null,
    showComposer
      ? h(
          ui.Row,
          {
            title: host.t("显示当前套餐额度", "Show active plan quota"),
            description: host.t(
              "在输入框下方右侧显示当前对话所用套餐的 5h / 7d 剩余额度。",
              "Show 5h / 7d remaining quota for the active thread plan on the right.",
            ),
            control: h(ui.Switch, {
              checked: showActiveUsage,
              onCheckedChange: (checked) => host.storage.set("showActiveUsage", !!checked),
            }),
          },
        )
      : null,
  );
}

host.register("chat.overlay", UsageBarOverlay);
host.settings(UsageBarSettings);
host.onDispose(() => controller.dispose());
