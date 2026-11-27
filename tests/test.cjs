"use strict";
// node tests/test.cjs：logic.js 的纯函数；web.js 放在最小的假 DOM 里跑（和宿主一样拼进 function(host)），核对重画时机。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const logic = require("../logic.js");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- 假 DOM：只有 web.js 用到的那些 ----------
function createPage({ prefs = {} } = {}) {
  const observers = new Set();
  let queued = false;
  let mutations = 0;
  const notify = (parent) => {
    if (!parent.isConnected) return; // 只观察挂在页面上的节点
    mutations += 1;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const o of observers) o.cb([]);
    });
  };
  let root = null;
  class El {
    constructor(tag, match) {
      this.tagName = tag;
      this.match = match; // closest() 认的选择器
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.style = { setProperty() {} };
      this.text = "";
      this.listeners = {};
    }
    get isConnected() {
      let n = this;
      while (n.parentElement) n = n.parentElement;
      return n === root;
    }
    get textContent() {
      return this.text + this.children.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      for (const c of this.children) c.parentElement = null;
      this.children = [];
      this.text = String(v);
      notify(this);
    }
    get previousElementSibling() {
      const p = this.parentElement;
      const i = p ? p.children.indexOf(this) : -1;
      return i > 0 ? p.children[i - 1] : null;
    }
    appendChild(c) {
      c.remove();
      c.parentElement = this;
      this.children.push(c);
      notify(this);
      return c;
    }
    remove() {
      const p = this.parentElement;
      if (!p) return;
      p.children.splice(p.children.indexOf(this), 1);
      this.parentElement = null;
      notify(p);
    }
    insertAdjacentElement(where, c) {
      assert.equal(where, "afterend");
      c.remove();
      const p = this.parentElement;
      p.children.splice(p.children.indexOf(this) + 1, 0, c);
      c.parentElement = p;
      notify(p);
      return c;
    }
    closest(sel) {
      for (let n = this; n; n = n.parentElement) if (n.match === sel) return n;
      return null;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    dispatch(type) {
      for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {} });
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, bottom: 10, width: 10, height: 10 };
    }
  }
  root = new El("body");
  const header = root.appendChild(new El("header"));
  const nav = header.appendChild(new El("nav"));
  const main = root.appendChild(new El("main"));
  const shell = main.appendChild(new El("div", '[data-slot="composer-shell"]'));
  const composer = shell.appendChild(new El("textarea"));

  let frames = [];
  const store = new Map(Object.entries(prefs));
  const subs = new Map();
  let overlay = null;
  const host = {
    React: { useEffect: (fn) => void fn() },
    h: () => null,
    storage: {
      get: (k, f) => (store.has(k) ? store.get(k) : f),
      subscribe: (k, fn) => ((subs.get(k) ?? subs.set(k, []).get(k)).push(fn), () => {}),
      use: (k, f) => (store.has(k) ? store.get(k) : f),
      set: (k, v) => (store.set(k, v), (subs.get(k) ?? []).forEach((fn) => fn(v))),
    },
    dom: { composer: () => composer },
    lang: () => "en",
    useLang: () => "en",
    t: (zh, en) => en,
    register: (slot, C) => (overlay = C),
    settings: () => {},
    onDispose: () => {},
  };
  const context = vm.createContext({
    document: {
      body: root,
      createElement: (tag) => new El(tag),
      createDocumentFragment: () => new El("#fragment"),
      querySelectorAll: (sel) => (sel.startsWith("nav:has(") ? [nav] : []),
    },
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {
        observers.add(this);
      }
      disconnect() {
        observers.delete(this);
      }
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    setInterval: () => 1,
    clearInterval: () => {},
    location: { hash: "" },
    window: { innerWidth: 1000, innerHeight: 800 },
  });
  vm.runInContext(`(function(host){${read("logic.js")}\n;\n${read("web.js")}\n})`, context)(host);

  /** 跑完当前排着的帧和它们引起的 DOM 变化通知；返回跑了几帧。 */
  async function settle(max = 20) {
    await new Promise((r) => setTimeout(r, 0)); // 先让已经发生的 DOM 变化通知到 MutationObserver
    let ran = 0;
    for (; ran < max && frames.length; ran++) {
      const batch = frames;
      frames = [];
      for (const fn of batch) fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    return ran;
  }
  const tooltips = () => root.children.filter((c) => c.className === "t3x-ub-tooltip");
  return { overlay: (props) => overlay(props), settle, root, El, main, header: nav.parentElement, shell, host, tooltips, pending: () => frames.length, mutations: () => mutations };
}

const usage = (used) => ({ windows: [{ id: "5h", label: "5-hour", kind: "session", usedPercent: used, windowDurationMins: 300 }] });
const props = (over = {}) => ({
  embedded: false,
  threadKey: "t1",
  providerInstanceId: "codex",
  model: "gpt-5",
  context: { usedTokens: 1200, maxTokens: 10000 },
  providers: [{ instanceId: "codex", driver: "codex", usageLimits: usage(30) }],
  ...over,
});
const bar = (page) => page.shell.parentElement.children.find((c) => c.dataset.t3xUsageBar === "composer");
const pills = (page) => page.header.children.find((c) => c.dataset.t3xUsageBar === "header");

// ---------- logic.js ----------
test("当前套餐额度：有 modelIds 的窗口只算挡得住当前模型的；一个都挡不住时照旧看全部", () => {
  const windows = [
    { id: "gemini-5h", kind: "session", usedPercent: 10, modelIds: ["gemini-1", "antigravity-default"] },
    { id: "3p-5h", kind: "session", usedPercent: 90, modelIds: ["claude-1"] },
    { id: "quota", kind: "other", usedPercent: 50 },
  ];
  const providers = [{ instanceId: "agy", usageLimits: { windows } }];
  assert.deepEqual(logic.findActiveWindows("agy", providers, "gemini-1").map((w) => w.id), ["gemini-5h", "quota"]);
  assert.deepEqual(logic.findActiveWindows("agy", providers, "claude-1").map((w) => w.id), ["3p-5h", "quota"]);
  assert.deepEqual(logic.findActiveWindows("agy", providers, null).map((w) => w.id), ["gemini-5h", "3p-5h", "quota"]);
  const scoped = [{ instanceId: "agy", usageLimits: { windows: windows.slice(0, 2) } }];
  assert.deepEqual(logic.findActiveWindows("agy", scoped, "other-model").map((w) => w.id), ["gemini-5h", "3p-5h"]);
  assert.equal(logic.findActiveWindows("missing", providers, "gemini-1"), null);
});

// ---------- web.js ----------
test("只显示输入框下方时（顶栏关掉），画完就停，不会自己触发重画", async () => {
  const page = createPage({ prefs: { showHeader: false } });
  page.overlay(props());
  await page.settle();
  assert(bar(page), "输入框下方的状态栏画出来了");
  assert.equal(pills(page), undefined);
  assert.equal(page.pending(), 0, "画完以后不该还排着下一帧");
  page.root.appendChild(new page.El("div")); // 页面上别的变化（比如流式输出）
  assert.equal(await page.settle(), 0, "无关的 DOM 变化不排重画");
});

test("只显示顶栏时（输入框状态栏关掉），画完就停", async () => {
  const page = createPage({ prefs: { showComposer: false } });
  page.overlay(props());
  await page.settle();
  assert(pills(page), "顶栏画出来了");
  assert.equal(bar(page), undefined);
  assert.equal(page.pending(), 0, "画完以后不该还排着下一帧");
  page.root.appendChild(new page.El("div"));
  assert.equal(await page.settle(), 0, "无关的 DOM 变化不排重画");
});

test("数据没变时不重建节点（悬停中的按钮不会被换掉）；数据变了才重建", async () => {
  const page = createPage();
  page.overlay(props());
  await page.settle();
  const button = bar(page).children.at(-1);
  const before = page.mutations();
  page.overlay(props()); // T3 每次渲染都会传一份新的 props，内容一样
  await page.settle();
  assert.equal(bar(page).children.at(-1), button, "同样的数据不重建按钮");
  assert.equal(page.mutations(), before, "同样的数据不动 DOM");
  page.overlay(props({ providers: [{ instanceId: "codex", driver: "codex", usageLimits: usage(60) }] }));
  await page.settle();
  assert.notEqual(bar(page).children.at(-1), button, "额度变了才重建");
  assert.match(bar(page).textContent, /40%/);
});

test("T3 重新渲染把状态栏挪走后会补回来", async () => {
  const page = createPage();
  page.overlay(props());
  await page.settle();
  bar(page).remove(); // 模拟 T3 重渲染时把插进去的节点丢了
  await page.settle();
  assert(bar(page), "输入框下方的状态栏补回来了");
  assert.equal(page.pending(), 0);
});

test("输入框被 T3 挪到别处、原来的状态栏还挂着时，跟过去", async () => {
  const page = createPage();
  page.overlay(props());
  await page.settle();
  const other = page.root.appendChild(new page.El("section"));
  other.appendChild(page.shell); // 输入框换了位置，状态栏还留在原来的父节点里
  await page.settle();
  assert.equal(bar(page)?.previousElementSibling, page.shell, "状态栏跟到输入框后面");
});

test("关掉一处时，它的悬停提示一起收起；另一处重建不关这一处的提示", async () => {
  const page = createPage();
  page.overlay(props());
  await page.settle();
  pills(page).children[0].dispatch("mouseenter");
  assert.equal(page.tooltips().length, 1, "悬停顶栏按钮出提示");
  page.overlay(props({ context: { usedTokens: 2400, maxTokens: 10000 } })); // 只有输入框下方的内容变了
  await page.settle();
  assert.equal(page.tooltips().length, 1, "输入框下方重建不关顶栏的提示");
  page.host.storage.set("showHeader", false);
  await page.settle();
  assert.equal(pills(page), undefined);
  assert.equal(page.tooltips().length, 0, "顶栏关掉后提示不留在页面上");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`✗ ${name}\n  ${error.message.split("\n").join("\n  ")}`);
    }
  }
  console.log(failed ? `\n${failed} 项失败` : `\n全部通过（${tests.length} 项）`);
  process.exitCode = failed ? 1 : 0;
})();
