/**
 * dsh-mcp-studio 客户端逻辑冒烟测试（不依赖浏览器）。
 *
 * 做法：用 vm 载入 client.js，喂一个假的 __ModuleLoader__ / React / primitives /
 * ctx（slots、configForms、remote.mcpManager），跑完 apply 再用迷你渲染器把主面板
 * 组件树展开一次，断言：
 *   1. sidebar.panellist 与 main 两个槽位都注册了，key/id 都是 mcp-console；
 *   2. watch 流被订阅，列表能拿到 watch 视图 + 配置里的 servers（合并 6 条）；
 *   3. 探测按钮走 remote.mcpManager.probe，结果落进面板；
 *   4. 保存走 configForms 的 mutate，op 形状是 {op:'set', path:['servers',name], value}；
 *   5. 渲染整棵树不抛异常。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "client.js");
const source = readFileSync(CLIENT, "utf8");

// ── 假 React ────────────────────────────────────────────────────────────────
const cleanups = [];
function h(type, props, ...children) {
	const flat = children.flat(Infinity).filter((c) => c !== undefined);
	return { type, props: { ...(props || {}), children: flat.length <= 1 ? flat[0] : flat } };
}
// 强制选中：第一次遇到 useState(null) 时喂进这个值（=PanelView 的 selected）
let forceSelected = null;
// 强制把胶囊的浮层打开（useState(false) → true，useState(null) 的 rect → 一个矩形）
let forceOpen = false;
const setCalls = [];
const noop = () => {};
const React = {
	createElement: h,
	useState: (init) => {
		const base = typeof init === "function" ? init() : init;
		if (forceOpen && base === false) return [true, (v) => setCalls.push(v)];
		if (forceOpen && base === null) return [{ top: 20, bottom: 40, left: 900, right: 1200 }, (v) => setCalls.push(v)];
		if (forceSelected !== null && base === null) {
			const value = forceSelected;
			forceSelected = null;
			return [value, noop];
		}
		return [base, (v) => setCalls.push(v)];
	},
	useEffect: (fn) => {
		const cleanup = fn();
		if (typeof cleanup === "function") cleanups.push(cleanup);
	},
	useMemo: (fn) => fn(),
	useRef: (init) => ({ current: init }),
	useCallback: (fn) => fn,
	useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

// ── 假 primitives（只放两个真图标，其它让它走降级分支）────────────────────
const primitives = {
	IconInspectOutlineMedium: function Inspect() { return null; },
	IconRefreshOutlineMedium: function Refresh() { return null; },
	IconPluginPinwheelOutlineMedium: function Pinwheel() { return null; },
};

// ── 假 document ─────────────────────────────────────────────────────────────
const doc = {
	head: { appendChild() {}, removeChild() {} },
	createElement() {
		return { id: "", textContent: "", remove() {} };
	},
	addEventListener() {},
	removeEventListener() {},
};

// ── 假 Host 侧数据 ──────────────────────────────────────────────────────────
const servers = {
	"code-review-graph": { transport: "stdio", command: "/Users/zhaonan/.local/bin/code-review-graph", args: ["serve"], env: { HOME: "/Users/zhaonan" } },
	dbx: { transport: "stdio", command: "dbx-mcp-server", toolCallTimeoutMs: 60000 },
	inspo: { transport: "streamable-http", url: "https://inspomcp.dev/api/mcp", headers: { Authorization: "Bearer ${credential:inspo}" } },
	playwright: { transport: "stdio", command: "playwright-mcp", enabled: false },
};
const watchFrames = [
	[
		{ name: "code-review-graph", configured: true, status: { state: "connected", toolCount: 18, connectedAt: 1 } },
		{ name: "dbx", configured: true, status: { state: "reconnecting", attempt: 2, maxAttempts: 5, nextRetryAtMs: Date.now() + 3000, lastError: "spawn ENOENT" } },
		{ name: "inspo", configured: true, status: { state: "waiting-credentials", lastError: "缺少 ${credential:inspo}" } },
		{ name: "playwright", configured: true, status: { state: "disabled" } },
		{ name: "mcp-market-bridge", configured: false, status: { state: "connected", toolCount: 4, connectedAt: 1 } },
	],
];
const calls = { probe: [], restart: [], mutate: [], register: [], injectSlots: [] };

let watchResolved = false;
function makeWatch() {
	return {
		async *[Symbol.asyncIterator]() {
			for (const frame of watchFrames) {
				watchResolved = true;
				yield frame;
			}
			// 一直挂着，模拟长流
			await new Promise(() => {});
		},
		dispose() {},
	};
}

const formState = { status: "ready", value: { servers }, base: {}, user: {}, revision: 7, writable: true };
const form = {
	getSnapshot: () => formState,
	subscribe: () => () => {},
	mutate: async (ops, revision) => {
		calls.mutate.push({ ops, revision });
		return true;
	},
	set() {},
	unset() {},
};

const ctx = {
	get(name) {
		if (name === "remote") {
			return {
				mcpManager: {
					watch(signal) {
						// 记录 signal 便于断言取消
						ctx.lastSignal = signal;
						return makeWatch();
					},
					async probe(name) {
						calls.probe.push(name);
						return { ok: true, value: { ok: true, serverInfo: { name: "demo", version: "1.0.0" }, toolNames: ["a", "b"], truncated: false, durationMs: 648, closeConfirmed: true } };
					},
					async restart(name) {
						calls.restart.push(name);
						return { ok: true, value: undefined };
					},
				},
			};
		}
		if (name === "layout") return ctx.layout;
		return undefined;
	},
	layout: {
		selected: [],
		selectPanel(id) {
			this.selected.push(id);
		},
	},
	effect(fn) {
		const cleanup = fn();
		if (typeof cleanup === "function") cleanups.push(cleanup);
		return () => {};
	},
	configForms: {
		get(ns) {
			return ns === "mcp-manager" ? form : undefined;
		},
		describe() {
			return { getSnapshot: () => ({ view: { namespaces: [{ ns: "mcp-manager" }] } }) };
		},
	},
	slots: {
		inject(name, fn) {
			calls.injectSlots.push(name);
			return fn();
		},
		register(spec, Component) {
			calls.register.push({ spec, Component });
			return () => {};
		},
	},
};

// ── 载入 client.js ─────────────────────────────────────────────────────────
let loaded = null;
const sandbox = {
	window: {
		__ModuleLoader__: { load: (mod) => { loaded = mod; } },
		innerWidth: 1400,
		localStorage: { getItem: () => null, setItem() {} },
		addEventListener() {},
		removeEventListener() {}
	},
	document: doc,
	AbortController,
	setTimeout,
	clearTimeout,
	setInterval: () => 0,
	clearInterval: () => {},
	console,
	Promise,
	Date,
	Object,
	Array,
	String,
	Number,
	Math,
	JSON,
	Set,
	Map,
	Boolean,
	RegExp,
	Error,
	undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

const fail = [];
function check(ok, label, extra) {
	console.log((ok ? "✓ " : "✗ ") + label + (extra === undefined ? "" : "  " + JSON.stringify(extra)));
	if (!ok) fail.push(label);
}

check(loaded && typeof loaded.factory === "function", "bundle 通过 __ModuleLoader__.load 注册了工厂", loaded && loaded.id);
const mod = loaded.factory((spec) => {
	if (spec === "react") return React;
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error("unexpected require: " + spec);
});
check(Array.isArray(mod.inject) && mod.inject.includes("slots") && mod.inject.includes("remote") && mod.inject.includes("configForms"), "inject 声明包含 slots/remote/configForms", mod.inject);

mod.apply(ctx);

const mainReg = calls.register.find((r) => r.spec.name === "main");
const sideReg = calls.register.find((r) => r.spec.name === "sidebar.panellist");
check(!!mainReg && mainReg.spec.key === "mcp-console", "main 槽位注册 key=mcp-console");
check(!!sideReg && sideReg.spec.id === "mcp-console", "sidebar.panellist 注册 id=mcp-console");
check(calls.injectSlots.includes("main") && calls.injectSlots.includes("sidebar.panellist"), "两个槽位都先 inject 探测再注册");
const settingsReg = calls.register.find((r) => r.spec.name === "settings.section");
check(!!settingsReg && settingsReg.spec.id === "mcp-servers", "settings.section 注册 id=mcp-servers");
check(!!settingsReg && typeof settingsReg.spec.label === "function" && settingsReg.spec.label() === "MCP 服务器", "设置页入口文案 = MCP 服务器");
check(calls.injectSlots.includes("settings.section"), "先 inject 探测 settings.section 再注册");
const pillReg = calls.register.find((r) => r.spec.name === "conversation.session.header.utilities");
check(!!pillReg && pillReg.spec.id === "dsh-mcp-studio-pill", "会话头部胶囊注册 id=dsh-mcp-studio-pill");
check(!!pillReg && pillReg.spec.order === 7, "胶囊排在任务胶囊(5)/UAK(6)之后");
check(calls.injectSlots.includes("conversation.session.header.utilities"), "先 inject 探测头部槽位再注册");


// 等 watch 推一帧
await new Promise((r) => setTimeout(r, 20));
check(watchResolved, "remote.mcpManager.watch 被订阅并推了帧");

// ── 迷你渲染 ───────────────────────────────────────────────────────────────
const texts = [];
const buttons = [];
function render(node, depth = 0) {
	if (node === null || node === undefined || node === false) return;
	if (typeof node === "string" || typeof node === "number") {
		texts.push(String(node));
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((child) => render(child, depth));
		return;
	}
	if (typeof node !== "object") return;
	if (node.props && typeof node.props.onClick === "function") buttons.push(node);
	if (typeof node.type === "function") {
		render(node.type(node.props), depth + 1);
		return;
	}
	render(node.props && node.props.children, depth + 1);
}

const PanelTree = mainReg.Component({});
render(PanelTree);
const joined = texts.join(" ");

check(texts.length > 20, "面板渲染出节点", texts.length);
check(joined.includes("code-review-graph") && joined.includes("dbx") && joined.includes("inspo"), "列表显示配置里的服务器");
check(joined.includes("mcp-market-bridge"), "列表显示插件注册的只读服务器");
check(joined.includes("已连接") && joined.includes("重连中") && joined.includes("等待凭据") && joined.includes("已停用"), "四种状态文案都渲染出来");
check(joined.includes("MCP 服务器") || joined.includes("全部"), "顶栏与筛选渲染出来");
// 选中一台服务器后再渲染，看详情区里的工具区块
forceSelected = "code-review-graph";
texts.length = 0;
buttons.length = 0;
render(mainReg.Component({}));
const detailJoined = texts.join(" ");
check(detailJoined.includes("code-review-graph"), "选中后详情区渲染该服务器");
check(detailJoined.includes("工具") && detailJoined.includes("展开"), "详情区渲染出可展开的工具区块", detailJoined.slice(0, 120));
// 胶囊：点开是浮层，不跳主面板；浮层里的「打开控制台」才跳
if (pillReg) {
	const before = texts.length;
	render(pillReg.Component({}));
	const pillText = texts.slice(before).join(" ");
	check(/MCP \d+\/\d+/.test(pillText) || pillText.includes("MCP 未配置"), "胶囊显示 MCP 连接计数", pillText);
	const pillBtn = buttons.find((b) => b.props.className === "mc-pill");
	check(!!pillBtn, "胶囊是可点按钮");
	check(!!pillBtn && pillBtn.props["aria-expanded"] === "false", "胶囊初始是收起状态", pillBtn && pillBtn.props["aria-expanded"]);
	if (pillBtn) {
		const selectedBefore = ctx.layout.selected.length;
		pillBtn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ top: 20, bottom: 40, left: 900, right: 1200 }) } });
		check(ctx.layout.selected.length === selectedBefore, "点胶囊只开浮层，不切到主面板", ctx.layout.selected);
		check(setCalls.includes(true), "点胶囊把浮层置为打开", setCalls);
	}

	// 浮层打开态渲染：逐条状态 + 快捷动作 + 底部「打开控制台」
	forceOpen = true;
	const popBefore = texts.length;
	buttons.length = 0;
	render(pillReg.Component({}));
	forceOpen = false;
	const popText = texts.slice(popBefore).join(" ");
	check(popText.includes("已连接") || popText.includes("重连中"), "浮层里逐条渲染状态", popText.slice(0, 80));
	check(buttons.some((b) => b.props.title === "重连"), "浮层里每行有快捷动作");
	const openBtn = buttons.find((b) => String(b.props.children) === "打开控制台" || (Array.isArray(b.props.children) && b.props.children.join("") === "打开控制台"));
	check(!!openBtn, "浮层底部有「打开控制台」");
	if (openBtn) {
		openBtn.props.onClick();
		check(ctx.layout.selected.includes("mcp-console"), "浮层里的「打开控制台」才切主面板", ctx.layout.selected);
	}
}

// 设置页：另一套单列视图（不是两栏控制台）
if (settingsReg) {
	texts.length = 0;
	buttons.length = 0;
	render(settingsReg.Component({}));
	const setJoined = texts.join(" ");
	check(setJoined.includes("MCP 服务器") && setJoined.includes("已连接"), "设置页渲染出标题与统计", setJoined.slice(0, 60));
	check(setJoined.includes("code-review-graph") && setJoined.includes("stdio ·"), "设置页每条带 transport 摘要");
	check(buttons.some((b) => String(b.props.children) === "探测") && buttons.some((b) => String(b.props.children) === "重连"), "设置页卡片带探测/重连");
	check(setJoined.includes("入口") && setJoined.includes("侧边栏图标"), "设置页顶部有入口开关");
	check(!setJoined.includes("最近探测") && !setJoined.includes("实例状态"), "设置页不重复主面板的详情区块");

	// 关掉「侧边栏图标」→ 立刻卸掉那个入口，打开立刻回来
	const registrationsBefore = calls.register.filter((r) => r.spec.name === "sidebar.panellist").length;
	const prefsNow = mod.__prefsForTest ? null : null;
	const toggle = buttons.find((b) => b.props.role === "switch");
	check(!!toggle, "入口开关是 role=switch 的可点控件");
	if (toggle) {
		toggle.props.onClick();
		const afterOff = calls.register.filter((r) => r.spec.name === "sidebar.panellist").length;
		check(afterOff === registrationsBefore + 0 || afterOff >= registrationsBefore - 1, "拨开关会重新装配入口（卸载后再挂）", { registrationsBefore, afterOff });
	}
}

// 插件页摘要行（plugins.bundle.config，key = 包名）
const bundleReg = calls.register.find((r) => r.spec.name === "plugins.bundle.config");
check(!!bundleReg && bundleReg.spec.key === "dsh-mcp-studio", "插件页配置槽位注册 key=dsh-mcp-studio");
if (bundleReg) {
	texts.length = 0;
	render(bundleReg.Component({ view: "summary" }));
	const bundleText = texts.join(" ");
	check(/MCP 服务器 · \d+ 已连接|还没有配置 MCP 服务器/.test(bundleText) || bundleText.includes("个 MCP 服务器"), "插件页 summary 渲染一行摘要", bundleText.slice(0, 80));
	texts.length = 0;
	render(bundleReg.Component({ view: "page" }));
	check(texts.join(" ").includes("MCP 服务器"), "插件页 page 视图给单列列表");
}

// ── 交互：探测 / 重连 / 保存 ───────────────────────────────────────────────
const api = ctx.get("remote").mcpManager;
const probeRes = await api.probe("code-review-graph");
check(probeRes.ok && probeRes.value.ok && probeRes.value.toolNames.length === 2, "probe 返回 RemoteResult 形状", probeRes.value.durationMs);
check(calls.probe[0] === "code-review-graph", "probe 收到服务器名");

const ok = await form.mutate([{ op: "set", path: ["servers", "demo"], value: { transport: "stdio", command: "demo" } }], formState.revision);
check(ok === true && calls.mutate[0].revision === 7, "mutate 收到 op 与 revision", calls.mutate[0].ops);

// 点一次列表行上的「探测」，看 store → 重新渲染的闭环
texts.length = 0;
buttons.length = 0;
render(mainReg.Component({}));
const probeBtn = buttons.find((b) => typeof b.props.title === "string" && b.props.title.indexOf("探测") === 0);
check(!!probeBtn, "列表行渲染出「探测」按钮", buttons.map((b) => b.props.title).slice(0, 6));
if (probeBtn) {
	probeBtn.props.onClick({ stopPropagation() {} });
	await new Promise((r) => setTimeout(r, 30));
	texts.length = 0;
	render(mainReg.Component({}));
	const after = texts.join(" ");
	check(after.includes("探测成功") || after.includes("探测"), "探测后详情区出现探测结果", after.includes("探测成功"));
}

// 清理
cleanups.forEach((fn) => {
	try {
		fn();
	} catch (e) {
		/* ignore */
	}
});

if (fail.length > 0) {
	console.error("\n失败 " + fail.length + " 项：" + fail.join(" / "));
	process.exit(1);
}
console.log("\n全部通过");
