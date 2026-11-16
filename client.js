/**
 * dsh-mcp-console — 客户端界面。
 *
 * 手写 __ModuleLoader__ bundle（零构建步骤）：
 *   - 运行时状态来自 @deepseek-ai/dsh-mcp-manager 的远程方法
 *       mcpManager/watch  流式推送 McpManagedServerView[]
 *       mcpManager/probe  单服务器探测（McpProbeResult）
 *       mcpManager/restart 重连
 *   - 配置读写走 configForms 服务：ctx.configForms.get('mcp-manager')
 *       mutate([{op:'set', path:['servers', name], value: entry}], revision)
 *
 * 侧边栏入口在 sidebar.panellist 槽位，主面板 key 与它同 id（PANEL_ID）。
 *
 * @module dsh-mcp-console/client
 */

window.__ModuleLoader__.load({
	id: "dsh-mcp-console",
	factory: function (require) {
		var React = require("react");
		var primitives = {};
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
		} catch (primitivesUnavailable) {
			// 图标库不可用时退化为纯文字界面，不影响主流程。
			primitives = {};
		}

		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var useRef = React.useRef;
		var useCallback = React.useCallback;
		var useSyncExternalStore = React.useSyncExternalStore;

		/** 主面板 key，与侧边栏条目 id 相同，布局服务据此派发。 */
		var PANEL_ID = "mcp-console";
		/** mcp-manager 在 profile 里的条目 id，也就是配置表单的 namespace。 */
		var ENTRY_ID = "mcp-manager";
		/** 服务器名规则，与 Host 侧保持一致。 */
		var NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

		var STATUS_META = {
			connected: { tone: "ok", label: "已连接" },
			connecting: { tone: "busy", label: "连接中" },
			reconnecting: { tone: "busy", label: "重连中" },
			"waiting-credentials": { tone: "warn", label: "等待凭据" },
			disabled: { tone: "idle", label: "已停用" },
			failed: { tone: "error", label: "失败" },
			closed: { tone: "idle", label: "未连接" },
			unknown: { tone: "idle", label: "状态未知" }
		};

		// 失败原因直接用宿主枚举给用户看没意义，映射成中文。
		var FAILED_REASON = {
			"gave-up": "重连次数用尽，已放弃",
			"reconnect-disabled": "重连已关闭",
			"unclosed-generation": "上一代实例还没清理干净",
			load: "服务器加载失败",
			cleanup: "清理失败"
		};

		var FILTERS = [
			{ id: "all", label: "全部" },
			{ id: "connected", label: "已连接" },
			{ id: "issue", label: "需要处理" },
			{ id: "disabled", label: "已停用" }
		];

		// ── 入口开关（本机偏好，存 localStorage，不写配置文件）─────────────────

		var PREFS_KEY = "dsh-mcp-console:prefs";
		var DEFAULT_PREFS = { sidebarEntry: true, headerPill: true, settingsSection: true };

		function readPrefs() {
			var value = {
				sidebarEntry: DEFAULT_PREFS.sidebarEntry,
				headerPill: DEFAULT_PREFS.headerPill,
				settingsSection: DEFAULT_PREFS.settingsSection
			};
			try {
				var raw = window.localStorage.getItem(PREFS_KEY);
				if (!raw) return value;
				var parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return value;
				Object.keys(DEFAULT_PREFS).forEach(function (key) {
					if (typeof parsed[key] === "boolean") value[key] = parsed[key];
				});
			} catch (error) {
				/* localStorage 不可用（隐私模式等）时用默认值 */
			}
			return value;
		}

		function createPrefs() {
			var current = readPrefs();
			var listeners = [];
			return {
				get: function () {
					return current;
				},
				set: function (patch) {
					current = Object.assign({}, current, patch);
					try {
						window.localStorage.setItem(PREFS_KEY, JSON.stringify(current));
					} catch (error) {
						/* 存不下就只在本次会话生效 */
					}
					listeners.slice().forEach(function (listener) {
						try {
							listener();
						} catch (error) {
							/* 单个订阅者出错不影响其它人 */
						}
					});
				},
				subscribe: function (listener) {
					listeners.push(listener);
					return function () {
						var index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				}
			};
		}

		var prefs = createPrefs();

		// ── 小工具 ──────────────────────────────────────────────────────────────

		function icon(name, size) {
			var Component = primitives[name];
			if (typeof Component !== "function" && typeof Component !== "object") return null;
			if (Component === null) return null;
			return h(Component, { size: size || 16 });
		}

		function describeError(error) {
			if (error === undefined || error === null) return "未知错误";
			if (typeof error === "string") return error;
			if (typeof error.message === "string" && error.message.length > 0) return error.message;
			if (typeof error.code === "string") return error.code;
			try {
				return JSON.stringify(error);
			} catch (unserializable) {
				return String(error);
			}
		}

		function failureText(result) {
			if (!result || result.ok !== false) return "调用未返回可识别的结果";
			var error = result.error;
			if (error && typeof error.message === "string" && error.message.length > 0) {
				return error.code ? error.code + " · " + error.message : error.message;
			}
			if (error && typeof error.code === "string") return error.code;
			return describeError(error);
		}

		function statusKeyOf(view) {
			if (!view || typeof view !== "object") return "unknown";
			var status = view.status;
			if (!status || typeof status !== "object") return "unknown";
			return typeof status.state === "string" ? status.state : "unknown";
		}

		function metaOf(view) {
			return STATUS_META[statusKeyOf(view)] || STATUS_META.unknown;
		}

		function isIssue(view) {
			var key = statusKeyOf(view);
			return key === "failed" || key === "waiting-credentials" || key === "closed";
		}

		function relativeTime(atMs, now) {
			if (typeof atMs !== "number" || !isFinite(atMs)) return "";
			var delta = Math.max(0, now - atMs);
			if (delta < 5000) return "刚刚";
			if (delta < 60000) return Math.floor(delta / 1000) + " 秒前";
			if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
			if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
			return Math.floor(delta / 86400000) + " 天前";
		}

		function plural(value, unit) {
			return String(value) + " " + unit;
		}

		function statusDetail(view, now) {
			if (!view || !view.status) return "";
			var status = view.status;
			switch (status.state) {
				case "connected":
					return plural(status.toolCount, "个工具") + " · 连接于 " + relativeTime(status.connectedAt, now);
				case "connecting":
					return status.attempt > 0 ? "第 " + status.attempt + " 次尝试" : "首次尝试";
				case "reconnecting": {
					var seconds = Math.max(0, Math.ceil(((status.nextRetryAtMs || 0) - now) / 1000));
					var attempt = typeof status.attempt === "number" ? status.attempt : 1;
					var maxAttempts = typeof status.maxAttempts === "number" ? status.maxAttempts : null;
					return "第 " + attempt + (maxAttempts ? "/" + maxAttempts : "") + " 次 · " + seconds + " 秒后重试";
				}
				case "waiting-credentials":
					return status.lastError || "缺少凭据";
				case "failed":
					if (status.reason === "cleanup") {
						var confirmed = status.result && status.result.closeConfirmed;
						return "清理失败 · 传输关闭" + (confirmed ? "已确认" : "未确认");
					}
					var reasonText = FAILED_REASON[status.reason] || "原因未明";
					return reasonText + (status.lastError ? " · " + status.lastError : "");
				case "closed":
					return status.result && status.result.closeConfirmed ? "连接已关闭" : "连接未确认关闭";
				case "disabled":
					return "已在配置里停用";
				default:
					return "";
			}
		}

		// 列表/摘要行会直接显示在界面上，url 查询串里的令牌必须遮掉。
		function maskSecrets(text) {
			return String(text === undefined || text === null ? "" : text).replace(
				/([?&](?:token|access_token|api[_-]?key|key|secret|password|sig|signature|auth)=)[^&\s]+/gi,
				"$1•••"
			);
		}

		function entrySummary(entry) {
			if (!entry) return "";
			if (entry.transport === "streamable-http") return maskSecrets(entry.url || "未填 url");
			var command = entry.command || "";
			var args = Array.isArray(entry.args) ? entry.args : [];
			return maskSecrets([command].concat(args).join(" ").trim()) || "未填 command";
		}

		/** 合并「配置里的条目」与「运行时视图」：配置条目可能有、也可能还没实例。 */
		function buildModels(config, views) {
			var listed = [];
			var byName = Object.create(null);
			var servers = config && config.value && typeof config.value === "object" ? config.value.servers : undefined;
			if (servers && typeof servers === "object") {
				Object.keys(servers).forEach(function (name) {
					var model = { name: name, entry: servers[name], view: null, configured: true };
					byName[name] = model;
					listed.push(model);
				});
			}
			(views || []).forEach(function (view) {
				if (!view || typeof view.name !== "string") return;
				var existing = byName[view.name];
				if (existing) {
					existing.view = view;
					return;
				}
				var model = { name: view.name, entry: null, view: view, configured: view.configured !== false };
				byName[view.name] = model;
				listed.push(model);
			});
			listed.sort(function (a, b) {
				return String(a.name).localeCompare(String(b.name));
			});
			return listed;
		}

		function parseLines(text) {
			return String(text || "")
				.split("\n")
				.map(function (line) {
					return line.trim();
				})
				.filter(function (line) {
					return line.length > 0;
				});
		}

		function parseKeyValues(text, separator) {
			var pairs = Object.create(null);
			parseLines(text).forEach(function (line) {
				var index = line.indexOf(separator);
				if (index <= 0) return;
				var key = line.slice(0, index).trim();
				var value = line.slice(index + separator.length).trim();
				if (key.length > 0) pairs[key] = value;
			});
			return pairs;
		}

		function toLines(map) {
			if (!map || typeof map !== "object") return "";
			return Object.keys(map)
				.map(function (key) {
					return key + "=" + map[key];
				})
				.join("\n");
		}

		function toHeaderLines(map) {
			if (!map || typeof map !== "object") return "";
			return Object.keys(map)
				.map(function (key) {
					return key + ": " + map[key];
				})
				.join("\n");
		}

		// ── 状态仓库 ────────────────────────────────────────────────────────────

		function createStore() {
			var state = { views: null, watchError: null, probe: Object.create(null), busy: Object.create(null), toast: null, access: null, form: null };
			var listeners = new Set();

			function emit() {
				listeners.forEach(function (listener) {
					listener();
				});
			}

			var store = {
				getSnapshot: function () {
					return state;
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},
				patch: function (partial) {
					state = Object.assign({}, state, partial);
					emit();
				},
				setViews: function (views) {
					store.patch({ views: Array.isArray(views) ? views : [], watchError: null });
				},
				setWatchError: function (message) {
					store.patch({ watchError: message });
				},
				setBusy: function (name, busy) {
					var next = Object.assign(Object.create(null), state.busy);
					if (busy) next[name] = Date.now();
					else delete next[name];
					store.patch({ busy: next });
				},
				setProbe: function (name, record) {
					var next = Object.assign(Object.create(null), state.probe);
					next[name] = record;
					store.patch({ probe: next });
				},
				dropProbe: function (name) {
					var next = Object.assign(Object.create(null), state.probe);
					delete next[name];
					store.patch({ probe: next });
				},
				toast: function (tone, text) {
					var record = { tone: tone, text: text, at: Date.now() };
					store.patch({ toast: record });
					setTimeout(function () {
						if (state.toast === record) store.patch({ toast: null });
					}, 3600);
				}
			};
			return store;
		}

		// 探测 / 重连是三个入口都要用的动作，抽到工厂作用域里共用一份，
		// 从 store 读当前 access（懒绑定可能在渲染后才就绪），用完把 busy 收干净。
		function createRuntime(store) {
			// 探测是「新建一条临时连接」，必须可取消：宿主 probe 的 descriptor 留了 signal 位，
			// 不传的话面板卸载 / 删掉条目 / 对端不响应时按钮会永久停在「处理中…」。
			var probes = Object.create(null);

			function accessNow() {
				var snapshot = store.getSnapshot();
				return snapshot.access || { api: null, error: "正在连接 remote.mcpManager…" };
			}

			function probe(name) {
				if (probes[name]) return;
				var access = accessNow();
				if (!access.api) {
					store.toast("error", "远程方法不可用：" + (access.error || "未知原因"));
					return;
				}
				var controller = new AbortController();
				probes[name] = controller;
				store.setBusy(name, true);
				Promise.resolve()
					.then(function () {
						return access.api.probe(name, controller.signal);
					})
					.then(function (result) {
						if (result && result.ok === true) {
							var value = result.value;
							var text =
								value && value.ok === true
									? "探测成功：" + plural(value.toolNames ? value.toolNames.length : 0, "个工具") + " · " + plural(value.durationMs || 0, "ms")
									: "探测完成但未连通：" + ((value && value.message) || "无详情");
							store.setProbe(name, { ok: true, value: value, at: Date.now() });
							store.toast(value && value.ok === true ? "ok" : "error", text);
						} else {
							var message = failureText(result);
							store.setProbe(name, { ok: false, error: message, at: Date.now() });
							store.toast("error", "探测失败：" + message);
						}
					})
					.catch(function (error) {
						store.toast("error", "探测调用异常：" + describeError(error));
					})
					.then(function () {
						delete probes[name];
						store.setBusy(name, false);
					});
			}

			function restart(name) {
				var access = accessNow();
				if (!access.api) {
					store.toast("error", "远程方法不可用：" + (access.error || "未知原因"));
					return;
				}
				store.setBusy(name, true);
				Promise.resolve()
					.then(function () {
						return access.api.restart(name);
					})
					.then(function (result) {
						if (result && result.ok === false) {
							store.toast("error", "重连失败：" + failureText(result));
							return;
						}
						store.toast("ok", "已请求重连：" + name);
					})
					.catch(function (error) {
						store.toast("error", "重连调用异常：" + describeError(error));
					})
					.then(function () {
						store.setBusy(name, false);
					});
			}

			// 卸载时把还在飞的探测全部取消，别让临时连接留在后台。
			function cancelProbes() {
				var names = Object.keys(probes);
				for (var index = 0; index < names.length; index++) {
					var controller = probes[names[index]];
					delete probes[names[index]];
					try {
						if (controller) controller.abort();
					} catch (error) {
						/* 取消失败不影响卸载 */
					}
				}
			}

			return { probe: probe, restart: restart, cancelProbes: cancelProbes };
		}

		// useSyncExternalStore 用 Object.is 比较快照：同一状态必须返回同一引用，
		// 否则 React 会告警 getSnapshot should be cached 并不停重渲染。
		var UNAVAILABLE_CONFIG = Object.freeze({
			status: "unavailable",
			value: undefined,
			base: undefined,
			user: undefined,
			revision: undefined,
			writable: false
		});

		function useConfigSnapshot(form) {
			var getSnapshot = useCallback(
				function () {
					if (!form) return UNAVAILABLE_CONFIG;
					try {
						return form.getSnapshot();
					} catch (error) {
						if (typeof console !== "undefined" && console.warn) {
							console.warn("[mcp-console] 读取配置快照失败", error);
						}
						return UNAVAILABLE_CONFIG;
					}
				},
				[form]
			);
			var subscribe = useCallback(
				function (listener) {
					if (!form) return function () {};
					try {
						return form.subscribe(listener);
					} catch (error) {
						return function () {};
					}
				},
				[form]
			);
			return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		// ── 小组件 ──────────────────────────────────────────────────────────────

		function PrefsRow(props) {
			return h(
				"div",
				{ className: "mc-pref-row" },
				h(
					"div",
					{ className: "mc-pref-text" },
					h("div", { className: "mc-pref-name" }, props.name),
					props.desc ? h("div", { className: "mc-pref-desc" }, props.desc) : null
				),
				h("button", {
					type: "button",
					role: "switch",
					className: "mc-switch",
					"aria-checked": props.checked ? "true" : "false",
					"aria-label": props.name,
					title: props.checked ? "已开启，点击关闭" : "已关闭，点击开启",
					onClick: props.onToggle
				})
			);
		}

		function PrefsBlock(props) {
			var state = useSyncExternalStore(prefs.subscribe, prefs.get, prefs.get);
			function toggle(key) {
				return function () {
					var patch = {};
					patch[key] = !state[key];
					prefs.set(patch);
				};
			}
			return h(
				"div",
				{ className: "mc-prefs" + (props && props.slim ? " mc-prefs-slim" : "") },
				h("div", { className: "mc-prefs-title" }, "入口"),
				h(PrefsRow, {
					name: "侧边栏图标",
					desc: "左侧图标列表里的「MCP 服务器」",
					checked: state.sidebarEntry,
					onToggle: toggle("sidebarEntry")
				}),
				h(PrefsRow, {
					name: "会话头部胶囊",
					desc: "与「任务胶囊」同一排，点开看状态",
					checked: state.headerPill,
					onToggle: toggle("headerPill")
				}),
				h(PrefsRow, {
					name: "设置页一节",
					desc: "设置 →「MCP 服务器」",
					checked: state.settingsSection,
					onToggle: toggle("settingsSection")
				}),
				h("div", { className: "mc-prefs-hint" }, "关掉的入口立刻消失、打开立刻回来，不需要重载窗口；这项选择只存在本机，不写配置文件。")
			);
		}

		function StatusDot(props) {
			return h("span", { className: "mc-dot mc-dot-" + (props.tone || "idle") });
		}

		function IconButton(props) {
			return h(
				"button",
				{
					type: "button",
					className: "mc-icon-btn" + (props.tone ? " mc-icon-btn-" + props.tone : ""),
					title: props.title,
					"aria-label": props.title,
					disabled: props.disabled,
					onClick: props.onClick
				},
				props.children
			);
		}

		function Button(props) {
			return h(
				"button",
				{
					type: "button",
					className: "mc-btn mc-btn-" + (props.tone || "secondary"),
					title: props.title,
					disabled: props.disabled,
					onClick: props.onClick
				},
				props.children
			);
		}

		// 用 div 而不是 label：抽屉里的「传输方式」是分组按钮，包在 label 里点标题文字会改选项。
		function Field(props) {
			return h(
				"div",
				{ className: "mc-field" + (props.wide ? " mc-field-wide" : "") },
				h("span", { className: "mc-field-label" }, props.label, props.hint ? h("span", { className: "mc-field-hint" }, props.hint) : null),
				props.children,
				props.error ? h("span", { className: "mc-field-error", role: "alert" }, props.error) : null
			);
		}

		function Toast(props) {
			if (!props.record) return null;
			return h(
				"div",
				{
					className: "mc-toast mc-toast-" + props.record.tone,
					// 很多失败只出现在 toast 里，读屏要能听到。
					role: props.record.tone === "error" ? "alert" : "status",
					"aria-live": props.record.tone === "error" ? "assertive" : "polite"
				},
				props.record.tone === "error" ? icon("IconWarningOutlineMedium", 14) : icon("IconInfoOutlineMedium", 14),
				h("span", null, props.record.text)
			);
		}

		function Banner(props) {
			return h(
				"div",
				{ className: "mc-banner mc-banner-" + (props.tone || "warn") },
				icon("IconWarningOutlineMedium", 14),
				h("div", { className: "mc-banner-text" }, h("strong", null, props.title), props.detail ? h("span", { className: "mc-banner-detail" }, props.detail) : null)
			);
		}

		// ── 探测结果 ────────────────────────────────────────────────────────────

		function ToolList(props) {
			var state = useState(false);
			var open = state[0];
			var setOpen = state[1];
			var filterState = useState("");
			var filter = filterState[0];
			var setFilter = filterState[1];
			var tried = useRef(false);
			var record = props.record;
			var value = record && record.ok && record.value ? record.value : null;
			var names = value && value.ok === true && Array.isArray(value.toolNames) ? value.toolNames : null;
			var busy = Boolean(props.busy);
			var known = names ? names.length : typeof props.toolCount === "number" ? props.toolCount : null;

			// 展开时若还没有工具清单，自动探一次（探测建临时连接，不影响运行中的实例）。
			// tried 守卫保证每次展开最多自动探一次：探测若在传输层抛错、store 里没有记录，
			// 不守卫就会因 busy 真→假 反复触发。
			useEffect(
				function () {
					if (!open || tried.current) return;
					if (names || busy || record || !props.onProbe) return;
					tried.current = true;
					props.onProbe();
				},
				[open, names, busy, record]
			);

			var visible = names
				? names.filter(function (name) {
						return !filter || String(name).toLowerCase().indexOf(filter.toLowerCase()) >= 0;
					})
				: null;

			var body = null;
			if (open) {
				if (names) {
					body = h(
						"div",
						null,
						names.length > 12
							? h("input", {
									className: "mc-tool-filter",
									value: filter,
									placeholder: "过滤工具名",
									onChange: function (event) {
										setFilter(event.target.value);
									}
								})
							: null,
						visible.length > 0
							? h(
									"div",
									{ className: "mc-tags" },
									visible.map(function (name) {
										return h("span", { className: "mc-tag mc-tag-quiet", key: name }, name);
									})
								)
							: h("div", { className: "mc-muted" }, "没有匹配的工具名。")
					);
				} else if (busy || !record) {
					body = h(
						"div",
						{ className: "mc-muted mc-tool-loading" },
						"正在探测取工具清单…（会新建一条临时连接，不影响正在运行的实例）"
					);
				} else {
					body = h("div", { className: "mc-muted" }, "探测没有成功，取不到工具清单。可以再点上面的「探测」试一次。");
				}
			}

			return h(
				"div",
				{ className: "mc-section" },
				h(
					"button",
					{
						type: "button",
						className: "mc-tool-head",
						"aria-expanded": open ? "true" : "false",
						onClick: function () {
							tried.current = false;
							setOpen(!open);
						}
					},
					h("span", { className: "mc-tool-chevron" }, icon("IconChevronRightOutlineMedium", 12)),
					h("span", { className: "mc-section-title mc-section-title-inline" }, "工具"),
					known !== null ? h("span", { className: "mc-tag mc-tag-quiet" }, plural(known, "个")) : null,
					value && value.truncated ? h("span", { className: "mc-muted" }, "（已截断）") : null,
					h("span", { className: "mc-tool-hint" }, open ? "收起" : "展开")
				),
				body
			);
		}

		function ProbeBlock(props) {
			var record = props.record;
			if (!record) return h("div", { className: "mc-muted" }, "还没有探测过。探测会新建一条一次性连接，不影响正在运行的实例。");
			var value = record.value;
			if (record.ok && value && value.ok === true) {
				var info = value.serverInfo;
				return h(
					"div",
					{ className: "mc-probe mc-probe-ok" },
					h(
						"div",
						{ className: "mc-probe-head" },
						icon("IconCheckOutlineMedium", 14) || h(StatusDot, { tone: "ok" }),
						h("strong", null, "探测成功"),
						h("span", { className: "mc-muted" }, plural(value.durationMs || 0, "ms")),
						info && info.name ? h("span", { className: "mc-tag" }, info.name + (info.version ? " " + info.version : "")) : null
					),
					h(
						"div",
						{ className: "mc-probe-line" },
						plural(value.toolNames ? value.toolNames.length : 0, "个工具"),
						value.truncated ? "（列表已截断）" : "",
						value.closeConfirmed === false ? " · 连接未确认关闭" : ""
					),
					Array.isArray(value.toolNames) && value.toolNames.length > 0
						? h(
								"div",
								{ className: "mc-tags" },
								value.toolNames.slice(0, 24).map(function (name) {
									return h("span", { className: "mc-tag mc-tag-quiet", key: name }, name);
								})
							)
						: null,
					value.cleanupError ? h("div", { className: "mc-warn-text" }, "清理异常：" + value.cleanupError) : null
				);
			}
			if (record.ok && value && value.ok === false) {
				return h(
					"div",
					{ className: "mc-probe mc-probe-fail" },
					h(
						"div",
						{ className: "mc-probe-head" },
						icon("IconWarningOutlineMedium", 14),
						h("strong", null, "探测失败"),
						value.stage ? h("span", { className: "mc-tag" }, value.stage === "connect" ? "连接阶段" : "取工具列表阶段") : null,
						h("span", { className: "mc-muted" }, plural(value.durationMs || 0, "ms"))
					),
					h("div", { className: "mc-error-text" }, value.message || "没有返回错误信息")
				);
			}
			return h(
				"div",
				{ className: "mc-probe mc-probe-fail" },
				h("div", { className: "mc-probe-head" }, icon("IconWarningOutlineMedium", 14), h("strong", null, "探测未完成")),
				h("div", { className: "mc-error-text" }, record.error || "调用失败")
			);
		}

		// ── 配置摘要 ────────────────────────────────────────────────────────────

		function ConfigBlock(props) {
			var entry = props.entry;
			var [reveal, setReveal] = useState(false);
			if (!entry) {
				return h(
					"div",
					{ className: "mc-muted" },
					"这条服务器由其它插件注册，只在运行时存在，配置不可在这里编辑。可以探测与重连。"
				);
			}
			var env = entry.env && typeof entry.env === "object" ? entry.env : null;
			var headers = entry.headers && typeof entry.headers === "object" ? entry.headers : null;

			function maskMap(map) {
				return Object.keys(map).map(function (key) {
					var value = String(map[key] === undefined ? "" : map[key]);
					var shown = reveal ? value : value.replace(/./g, "•");
					return h("div", { className: "mc-kv", key: key }, h("span", { className: "mc-kv-key" }, key), h("span", { className: "mc-kv-value" }, shown));
				});
			}

			return h(
				"div",
				{ className: "mc-config" },
				h(
					"div",
					{ className: "mc-kv-row" },
					h("span", { className: "mc-kv-key" }, "传输"),
					h("span", { className: "mc-kv-value" }, entry.transport === "streamable-http" ? "streamable-http" : "stdio")
				),
				entry.transport === "streamable-http"
					? h("div", { className: "mc-kv-row" }, h("span", { className: "mc-kv-key" }, "URL"), h("span", { className: "mc-kv-value mc-mono" }, entry.url || "—"))
					: h(
							"div",
							{ className: "mc-kv-row" },
							h("span", { className: "mc-kv-key" }, "命令"),
							h("span", { className: "mc-kv-value mc-mono" }, entrySummary(entry))
						),
				entry.cwd ? h("div", { className: "mc-kv-row" }, h("span", { className: "mc-kv-key" }, "工作目录"), h("span", { className: "mc-kv-value mc-mono" }, entry.cwd)) : null,
				entry.enabled === false ? h("div", { className: "mc-kv-row" }, h("span", { className: "mc-kv-key" }, "启用"), h("span", { className: "mc-kv-value" }, "否（enabled: false）")) : null,
				entry.startupTimeoutMs ? h("div", { className: "mc-kv-row" }, h("span", { className: "mc-kv-key" }, "启动超时"), h("span", { className: "mc-kv-value" }, plural(entry.startupTimeoutMs, "ms"))) : null,
				entry.toolCallTimeoutMs ? h("div", { className: "mc-kv-row" }, h("span", { className: "mc-kv-key" }, "工具调用超时"), h("span", { className: "mc-kv-value" }, plural(entry.toolCallTimeoutMs, "ms"))) : null,
				entry.closeTimeoutMs ? h("div", { className: "mc-kv-row" }, h("span", { className: "mc-kv-key" }, "关闭超时"), h("span", { className: "mc-kv-value" }, plural(entry.closeTimeoutMs, "ms"))) : null,
				env
					? h(
							"details",
							{ className: "mc-details" },
							h("summary", null, "环境变量（" + Object.keys(env).length + "）"),
							h("div", { className: "mc-kv-list" }, maskMap(env))
						)
					: null,
				headers
					? h(
							"details",
							{ className: "mc-details" },
							h("summary", null, "请求头（" + Object.keys(headers).length + "）"),
							h("div", { className: "mc-kv-list" }, maskMap(headers))
						)
					: null,
				env || headers
					? h(
							"button",
							{ type: "button", className: "mc-link-btn", onClick: function () { setReveal(!reveal); } },
							reveal ? "隐藏敏感值" : "显示敏感值"
						)
					: null
			);
		}

		// ── 编辑抽屉 ────────────────────────────────────────────────────────────

		function emptyDraft() {
			return {
				name: "",
				transport: "stdio",
				command: "",
				args: "",
				cwd: "",
				url: "",
				env: "",
				headers: "",
				enabled: true,
				startupTimeoutMs: "",
				toolCallTimeoutMs: ""
			};
		}

		function draftFromEntry(name, entry) {
			var draft = emptyDraft();
			draft.name = name;
			if (!entry) return draft;
			draft.transport = entry.transport === "streamable-http" ? "streamable-http" : "stdio";
			draft.command = entry.command || "";
			draft.args = Array.isArray(entry.args) ? entry.args.join("\n") : "";
			draft.cwd = entry.cwd || "";
			draft.url = entry.url || "";
			draft.env = toLines(entry.env);
			draft.headers = toHeaderLines(entry.headers);
			draft.enabled = entry.enabled !== false;
			draft.startupTimeoutMs = entry.startupTimeoutMs ? String(entry.startupTimeoutMs) : "";
			draft.toolCallTimeoutMs = entry.toolCallTimeoutMs ? String(entry.toolCallTimeoutMs) : "";
			return draft;
		}

		function validateDraft(draft, takenNames) {
			var errors = {};
			var name = String(draft.name || "").trim();
			if (!NAME_PATTERN.test(name)) errors.name = "只能使用字母、数字、下划线与短横线，长度 1–32";
			else if (takenNames && takenNames.indexOf(name) !== -1) errors.name = "这个名字已经存在";
			if (draft.transport === "stdio") {
				if (!String(draft.command || "").trim()) errors.command = "stdio 传输必须填命令";
			} else if (!String(draft.url || "").trim()) {
				errors.url = "streamable-http 传输必须填 URL";
			}
			// 宿主只接受 ≥1 的整数毫秒，填 0 或超大值会被拒，这里先拦住。
			errors.startupTimeoutMs = timeoutError(draft.startupTimeoutMs);
			errors.toolCallTimeoutMs = timeoutError(draft.toolCallTimeoutMs);
			if (!errors.env) errors.env = keyValueError(draft.env, "=", "环境变量");
			if (!errors.headers) errors.headers = keyValueError(draft.headers, ":", "请求头");
			Object.keys(errors).forEach(function (key) {
				if (!errors[key]) delete errors[key];
			});
			return errors;
		}

		function timeoutError(raw) {
			var text = String(raw === undefined || raw === null ? "" : raw).trim();
			if (!text) return "";
			if (!/^\d+$/.test(text)) return "只接受正整数毫秒";
			var value = Number(text);
			if (!(value >= 1) || value > 3600000) return "取值要在 1–3600000 毫秒之间";
			return "";
		}

		// 解析时静默丢掉的坏行，这里明确报错，别让用户以为写进去了。
		function keyValueError(raw, separator, label) {
			var lines = parseLines(raw);
			for (var index = 0; index < lines.length; index++) {
				var line = lines[index];
				if (line.indexOf(separator) <= 0) return label + "要写成「KEY" + separator + "VALUE」，第 " + (index + 1) + " 行不合法";
			}
			return "";
		}

		// 以原条目为基底重建：reconnect / closeTimeoutMs 以及宿主以后新增的字段
		// 都不能被「改一个字段再保存」整条吃掉（否则用户在配置里关掉的自动重连会被静默打开）。
		function entryFromDraft(draft, original) {
			var entry = {};
			if (original && typeof original === "object") {
				for (var key in original) {
					if (Object.prototype.hasOwnProperty.call(original, key)) entry[key] = original[key];
				}
			}
			entry.transport = draft.transport === "streamable-http" ? "streamable-http" : "stdio";
			// 两种传输的字段互斥，先清空再按当前传输写回。
			delete entry.command;
			delete entry.args;
			delete entry.cwd;
			delete entry.env;
			delete entry.url;
			delete entry.headers;
			delete entry.startupTimeoutMs;
			delete entry.toolCallTimeoutMs;
			if (entry.transport === "stdio") {
				entry.command = String(draft.command || "").trim();
				var args = parseLines(draft.args);
				if (args.length > 0) entry.args = args;
				var cwd = String(draft.cwd || "").trim();
				if (cwd.length > 0) entry.cwd = cwd;
				var env = parseKeyValues(draft.env, "=");
				if (Object.keys(env).length > 0) entry.env = env;
			} else {
				entry.url = String(draft.url || "").trim();
				var headers = parseKeyValues(draft.headers, ":");
				if (Object.keys(headers).length > 0) entry.headers = headers;
			}
			// enabled 只在停用时写 false：开关拨回「启用」必须删掉这个字段，
			// 否则原配置里的 enabled:false 会一直留着，用户以为启用成功了其实没有。
			if (draft.enabled === false) entry.enabled = false;
			else delete entry.enabled;
			if (String(draft.startupTimeoutMs || "").trim()) entry.startupTimeoutMs = Number(String(draft.startupTimeoutMs).trim());
			if (String(draft.toolCallTimeoutMs || "").trim()) entry.toolCallTimeoutMs = Number(String(draft.toolCallTimeoutMs).trim());
			return entry;
		}

		function Drawer(props) {
			var draftState = useState(function () {
				return draftFromEntry(props.originalName, props.entry);
			});
			var draft = draftState[0];
			var setDraft = draftState[1];
			var errorsState = useState({});
			var errors = errorsState[0];
			var setErrors = errorsState[1];
			var savingState = useState(false);
			var saving = savingState[0];
			var setSaving = savingState[1];
			var panelRef = useRef(null);

			// Esc 关闭 + 打开时把焦点送进来，否则键盘用户只能 Tab 到尾。
			useEffect(function () {
				function onKeyDown(event) {
					if (!event || (event.key !== "Escape" && event.key !== "Esc")) return;
					event.stopPropagation();
					props.onClose();
				}
				document.addEventListener("keydown", onKeyDown, true);
				var node = panelRef.current;
				if (node && typeof node.querySelector === "function") {
					var first = node.querySelector("input,textarea,select,button");
					if (first && typeof first.focus === "function") {
						try {
							first.focus();
						} catch (error) {
							/* 焦点失败不影响使用 */
						}
					}
				}
				return function () {
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, []);

			function update(patch) {
				setDraft(Object.assign({}, draft, patch));
			}

			function submit() {
				var trimmedName = String(draft.name || "").trim();
				var nextDraft = Object.assign({}, draft, { name: trimmedName });
				var found = validateDraft(nextDraft, props.takenNames || []);
				setErrors(found);
				if (Object.keys(found).length > 0) return;
				setSaving(true);
				Promise.resolve(props.onSave(trimmedName, entryFromDraft(nextDraft, props.entry), props.originalName))
					.catch(function () {})
					.then(function () {
						setSaving(false);
					});
			}

			return h(
				"div",
				{ className: "mc-drawer-backdrop", onClick: props.onClose },
				h(
					"div",
					{
						className: "mc-drawer",
						ref: panelRef,
						role: "dialog",
						"aria-modal": "true",
						"aria-label": props.originalName ? "编辑 " + props.originalName : "新增 MCP 服务器",
						onClick: function (event) { event.stopPropagation(); }
					},
					h(
						"div",
						{ className: "mc-drawer-head" },
						h("div", { className: "mc-drawer-title" }, props.originalName ? "编辑 " + props.originalName : "新增 MCP 服务器"),
						h(IconButton, { title: "关闭", onClick: props.onClose }, icon("IconCloseOutlineMedium", 16))
					),
					h(
						"div",
						{ className: "mc-drawer-body" },
						h(Field, { label: "名称", hint: "也是工具命名空间前缀", error: errors.name },
							h("input", {
								className: "mc-input",
								value: draft.name,
								placeholder: "my-server",
								disabled: Boolean(props.originalName),
								onChange: function (event) { update({ name: event.target.value }); }
							})
						),
						h(Field, { label: "传输方式" },
							h(
								"div",
								{ className: "mc-segment" },
								["stdio", "streamable-http"].map(function (kind) {
									return h(
										"button",
										{
											type: "button",
											key: kind,
											className: "mc-segment-item" + (draft.transport === kind ? " is-active" : ""),
											onClick: function () { update({ transport: kind }); }
										},
										kind === "stdio" ? "stdio（本地进程）" : "streamable-http（远程）"
									);
								})
							)
						),
						draft.transport === "stdio"
							? [
									h(Field, { key: "command", label: "命令", error: errors.command },
										h("input", {
											className: "mc-input mc-mono",
											value: draft.command,
											placeholder: "/usr/local/bin/my-mcp-server",
											onChange: function (event) { update({ command: event.target.value }); }
										})
									),
									h(Field, { key: "args", label: "参数", hint: "一行一个" },
										h("textarea", {
											className: "mc-input mc-mono mc-textarea",
											rows: 3,
											value: draft.args,
											placeholder: "serve",
											onChange: function (event) { update({ args: event.target.value }); }
										})
									),
									h(Field, { key: "env", label: "环境变量", hint: "一行一个 KEY=VALUE，支持 ${credential:…}", error: errors.env },
										h("textarea", {
											className: "mc-input mc-mono mc-textarea",
											rows: 4,
											value: draft.env,
											placeholder: "PATH=/usr/bin:/bin",
											onChange: function (event) { update({ env: event.target.value }); }
										})
									),
									h(Field, { key: "cwd", label: "工作目录" },
										h("input", {
											className: "mc-input mc-mono",
											value: draft.cwd,
											placeholder: "可选，留空继承 DSH 进程目录",
											onChange: function (event) { update({ cwd: event.target.value }); }
										})
									)
								]
							: [
									h(Field, { key: "url", label: "URL", error: errors.url },
										h("input", {
											className: "mc-input mc-mono",
											value: draft.url,
											placeholder: "https://example.com/mcp",
											onChange: function (event) { update({ url: event.target.value }); }
										})
									),
									h(Field, { key: "headers", label: "请求头", hint: "一行一个 Key: Value", error: errors.headers },
										h("textarea", {
											className: "mc-input mc-mono mc-textarea",
											rows: 3,
											value: draft.headers,
											placeholder: "Authorization: Bearer ${credential:inspo}",
											onChange: function (event) { update({ headers: event.target.value }); }
										})
									)
								],
						h(
							"div",
							{ className: "mc-grid-2" },
							h(Field, { label: "启动超时（ms）", error: errors.startupTimeoutMs },
								h("input", {
									className: "mc-input mc-mono",
									value: draft.startupTimeoutMs,
									placeholder: "30000",
									onChange: function (event) { update({ startupTimeoutMs: event.target.value }); }
								})
							),
							h(Field, { label: "工具调用超时（ms）", error: errors.toolCallTimeoutMs },
								h("input", {
									className: "mc-input mc-mono",
									value: draft.toolCallTimeoutMs,
									placeholder: "可选",
									onChange: function (event) { update({ toolCallTimeoutMs: event.target.value }); }
								})
							)
						),
						h(
							"label",
							{ className: "mc-check" },
							h("input", {
								type: "checkbox",
								checked: draft.enabled !== false,
								onChange: function (event) { update({ enabled: event.target.checked }); }
							}),
							h("span", null, "启用这条配置")
						)
					),
					h(
						"div",
						{ className: "mc-drawer-foot" },
						h(Button, { onClick: props.onClose }, "取消"),
						props.canWrite
							? h(Button, { tone: "primary", onClick: submit, disabled: saving }, saving ? "保存中…" : "保存")
							: h(Button, { tone: "primary", disabled: true, title: "配置当前不可写" }, "保存")
					)
				)
			);
		}

		// ── 确认删除 ────────────────────────────────────────────────────────────

		function ConfirmDialog(props) {
			return h(
				"div",
				{ className: "mc-drawer-backdrop", onClick: props.onCancel },
				h(
					"div",
					{ className: "mc-confirm", onClick: function (event) { event.stopPropagation(); } },
					h("div", { className: "mc-confirm-title" }, "删除 " + props.name + "？"),
					h(
						"div",
						{ className: "mc-confirm-body" },
						"会从 mcp-manager 的 servers 配置里移除这条条目，正在运行的实例随即关闭。这一步直接写回配置文件。"
					),
					h(
						"div",
						{ className: "mc-confirm-foot" },
						h(Button, { onClick: props.onCancel }, "取消"),
						h(Button, { tone: "danger", onClick: props.onConfirm }, "删除")
					)
				)
			);
		}

		// ── 列表行 ──────────────────────────────────────────────────────────────

		function ServerRow(props) {
			var model = props.model;
			var meta = metaOf(model.view);
			var busy = props.busy;
			var summary = model.entry ? entrySummary(model.entry) : "由插件注册（只读）";
			return h(
				"div",
				{
					className: "mc-row" + (props.active ? " is-active" : ""),
					role: "button",
					tabIndex: 0,
					onClick: props.onSelect,
					onKeyDown: function (event) {
						// 行内还有探测/重连按钮，事件从它们冒上来时不能抢：否则按 Enter 会切选中行。
						if (event.target !== event.currentTarget) return;
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							props.onSelect();
						}
					}
				},
				h(
					"div",
					{ className: "mc-row-main" },
					h(
						"div",
						{ className: "mc-row-title" },
						h("span", { className: "mc-row-name" }, model.name),
						model.configured ? null : h("span", { className: "mc-tag mc-tag-quiet" }, "只读")
					),
					h("div", { className: "mc-row-sub mc-mono" }, summary)
				),
				h(
					"div",
					{ className: "mc-row-side" },
					h(
						"div",
						{ className: "mc-row-status" },
						h(StatusDot, { tone: busy ? "busy" : meta.tone }),
						h("span", { className: "mc-row-status-text" }, busy ? "处理中" : meta.label)
					),
					h(
						"div",
						{ className: "mc-row-actions" },
						h(
							IconButton,
							{ title: "探测", disabled: busy, onClick: function (event) { event.stopPropagation(); props.onProbe(); } },
							busy ? icon("IconLoadingOutlineMedium", 15) : icon("IconInspectOutlineMedium", 15)
						),
						h(
							IconButton,
							{ title: "重连", disabled: busy, onClick: function (event) { event.stopPropagation(); props.onRestart(); } },
							icon("IconRefreshOutlineMedium", 15)
						)
					)
				)
			);
		}

		// ── 详情 ────────────────────────────────────────────────────────────────

		function DetailPane(props) {
			var model = props.model;
			var now = props.now;
			var store = props.store;
			if (!model) {
				return h(
					"div",
					{ className: "mc-empty" },
					icon("IconLayersOutlineMedium", 28),
					h("div", { className: "mc-empty-title" }, "选一条服务器看详情"),
					h("div", { className: "mc-muted" }, "左侧列表可以探测、重连；点开条目可以编辑配置或删除。")
				);
			}
			var meta = metaOf(model.view);
			var busy = Boolean(props.busy);
			var probeRecord = props.probe[model.name];
			var connected = statusKeyOf(model.view) === "connected";

			return h(
				"div",
				{ className: "mc-detail" },
				h(
					"div",
					{ className: "mc-detail-head" },
					h(
						"div",
						{ className: "mc-detail-title" },
						h("span", { className: "mc-detail-name" }, model.name),
						model.configured ? null : h("span", { className: "mc-tag mc-tag-quiet" }, "插件注册 · 配置只读")
					),
					h(
						"div",
						{ className: "mc-detail-actions" },
						h(
							Button,
							{ onClick: props.onProbe, disabled: busy },
							icon("IconInspectOutlineMedium", 14),
							h("span", { className: "mc-btn-text" }, busy ? "处理中…" : "探测")
						),
						h(
							Button,
							{ onClick: props.onRestart, disabled: busy },
							icon("IconRefreshOutlineMedium", 14),
							h("span", { className: "mc-btn-text" }, "重连")
						),
						model.configured
							? h(
									Button,
									{ onClick: props.onToggle },
									icon(connected || model.entry.enabled === false ? "IconSlidersTwoOutlineMedium" : "IconGaugeOutlineMedium", 14),
									h("span", { className: "mc-btn-text" }, model.entry.enabled === false ? "启用" : "停用")
								)
							: null,
						model.configured ? h(Button, { onClick: props.onEdit }, icon("IconSettingsOutlineMedium", 14), h("span", { className: "mc-btn-text" }, "编辑")) : null,
						model.configured
							? h(Button, { tone: "danger", onClick: props.onDelete }, icon("IconTrashOutlineMedium", 14), h("span", { className: "mc-btn-text" }, "删除"))
							: null
					)
				),
				h(
					"div",
					{ className: "mc-section" },
					h("div", { className: "mc-section-title" }, "实例状态"),
					h(
						"div",
						{ className: "mc-status-block" },
						h(StatusDot, { tone: busy ? "busy" : meta.tone }),
						h("span", { className: "mc-status-label" }, busy ? "处理中" : meta.label),
						h("span", { className: "mc-muted" }, statusDetail(model.view, now))
					),
					model.view && model.view.status && model.view.status.lastError && statusKeyOf(model.view) !== "waiting-credentials"
						? h("div", { className: "mc-error-text" }, model.view.status.lastError)
						: null
				),
				h(ToolList, {
					record: probeRecord,
					busy: busy,
					toolCount: model.view && model.view.status && model.view.status.state === "connected" ? model.view.status.toolCount : null,
					onProbe: props.onProbe
				}),
				h("div", { className: "mc-section" }, h("div", { className: "mc-section-title" }, "最近探测"), h(ProbeBlock, { record: probeRecord })),
				h("div", { className: "mc-section" }, h("div", { className: "mc-section-title" }, "配置"), h(ConfigBlock, { entry: model.entry }))
			);
		}

		// ── 主面板 ──────────────────────────────────────────────────────────────

		function PanelView(props) {
			var store = props.store;
			var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			var access = state.access || { api: null, error: "正在连接 remote.mcpManager…" };
			var form = state.form;
			var config = useConfigSnapshot(form);

			var queryState = useState("");
			var query = queryState[0];
			var setQuery = queryState[1];
			var filterState = useState("all");
			var filter = filterState[0];
			var setFilter = filterState[1];
			var selectedState = useState(null);
			var selectedName = selectedState[0];
			var setSelectedName = selectedState[1];
			var drawerState = useState(null);
			var drawer = drawerState[0];
			var setDrawer = drawerState[1];
			var confirmState = useState(null);
			var confirming = confirmState[0];
			var setConfirming = confirmState[1];
			var nowState = useState(Date.now());
			var now = nowState[0];
			var setNow = nowState[1];
			var showPrefsState = useState(false);
			var showPrefs = showPrefsState[0];
			var setShowPrefs = showPrefsState[1];

			var needTick = useMemo(
				function () {
					var list = Array.isArray(state.views) ? state.views : [];
					for (var index = 0; index < list.length; index++) {
						var key = statusKeyOf(list[index]);
						if (key === "reconnecting" || key === "connecting") return true;
					}
					return false;
				},
				[state.views]
			);

			useEffect(
				function () {
					// 每秒 tick 只为「重连倒计时」服务：没有在连的条目就别让整棵树每秒重建。
					if (!needTick) return undefined;
					var timer = setInterval(function () {
						setNow(Date.now());
					}, 1000);
					return function () {
						clearInterval(timer);
					};
				},
				[needTick]
			);

			var models = useMemo(
				function () {
					return buildModels(config, state.views);
				},
				[config, state.views]
			);

			var counts = useMemo(
				function () {
					var result = { all: models.length, connected: 0, issue: 0, disabled: 0 };
					models.forEach(function (model) {
						var key = statusKeyOf(model.view);
						if (key === "connected") result.connected += 1;
						if (isIssue(model.view)) result.issue += 1;
						if (key === "disabled") result.disabled += 1;
					});
					return result;
				},
				[models]
			);

			var visible = useMemo(
				function () {
					var keyword = query.trim().toLowerCase();
					return models.filter(function (model) {
						if (keyword.length > 0) {
							var haystack = (model.name + " " + entrySummary(model.entry)).toLowerCase();
							if (haystack.indexOf(keyword) === -1) return false;
						}
						if (filter === "connected") return statusKeyOf(model.view) === "connected";
						if (filter === "disabled") return statusKeyOf(model.view) === "disabled";
						if (filter === "issue") return isIssue(model.view);
						return true;
					});
				},
				[models, query, filter]
			);

			var selected = useMemo(
				function () {
					if (!selectedName) return null;
					for (var index = 0; index < models.length; index += 1) {
						if (models[index].name === selectedName) return models[index];
					}
					return null;
				},
				[models, selectedName]
			);

			var canWrite = Boolean(form) && config.status === "ready" && config.writable === true && config.revision !== undefined;

			function probe(name) {
				if (!access.api) {
					store.toast("error", "远程方法不可用：" + (access.error || "未知原因"));
					return;
				}
				store.setBusy(name, true);
				Promise.resolve()
					.then(function () {
						return access.api.probe(name);
					})
					.then(function (result) {
						if (result && result.ok === true) {
							var value = result.value;
							var text =
								value && value.ok === true
									? "探测成功：" + plural(value.toolNames ? value.toolNames.length : 0, "个工具") + " · " + plural(value.durationMs || 0, "ms")
									: "探测完成但未连通：" + ((value && value.message) || "无详情");
							store.setProbe(name, { ok: true, value: value, at: Date.now() });
							store.toast(value && value.ok === true ? "ok" : "error", text);
						} else {
							var message = failureText(result);
							store.setProbe(name, { ok: false, error: message, at: Date.now() });
							store.toast("error", "探测失败：" + message);
						}
					})
					.catch(function (error) {
						store.toast("error", "探测调用异常：" + describeError(error));
					})
					.then(function () {
						store.setBusy(name, false);
					});
			}

			function restart(name) {
				if (!access.api) {
					store.toast("error", "远程方法不可用：" + (access.error || "未知原因"));
					return;
				}
				store.setBusy(name, true);
				Promise.resolve()
					.then(function () {
						return access.api.restart(name);
					})
					.then(function (result) {
						if (result && result.ok === true) store.toast("ok", "已请求重连 " + name);
						else store.toast("error", "重连失败：" + failureText(result));
					})
					.catch(function (error) {
						store.toast("error", "重连调用异常：" + describeError(error));
					})
					.then(function () {
						store.setBusy(name, false);
					});
			}

			function applyOps(ops, okText) {
				if (!form) {
					store.toast("error", "配置服务不可用（ctx.configForms 没有可用的 mcp-manager 表单）");
					return Promise.resolve(false);
				}
				if (!canWrite) {
					store.toast("error", "配置暂不可写：" + (config.status === "ready" ? "只读或缺少 revision" : config.status));
					return Promise.resolve(false);
				}
				return Promise.resolve()
					.then(function () {
						return form.mutate(ops, config.revision);
					})
					.then(function (accepted) {
						if (accepted === true) store.toast("ok", okText);
						else store.toast("error", "Host 拒绝了这次修改（配置已被外部改动或校验未通过）");
						return accepted === true;
					})
					.catch(function (error) {
						store.toast("error", "写入失败：" + describeError(error));
						return false;
					});
			}

			function saveEntry(name, entry, originalName) {
				var ops = [];
				if (originalName && originalName !== name) ops.push({ op: "unset", path: ["servers", originalName] });
				ops.push({ op: "set", path: ["servers", name], value: entry });
				return applyOps(ops, originalName ? "已保存 " + name : "已新增 " + name).then(function (accepted) {
					if (accepted) {
						setDrawer(null);
						setSelectedName(name);
					}
				});
			}

			function deleteEntry(name) {
				return applyOps([{ op: "unset", path: ["servers", name] }], "已删除 " + name).then(function (accepted) {
					if (accepted) {
						setConfirming(null);
						if (selectedName === name) setSelectedName(null);
						store.dropProbe(name);
					}
				});
			}

			function toggleEnabled(model) {
				if (!model.entry) return Promise.resolve(false);
				var next = Object.assign({}, model.entry, { enabled: model.entry.enabled === false });
				if (next.enabled === true) delete next.enabled;
				return applyOps([{ op: "set", path: ["servers", model.name], value: next }], next.enabled === false ? "已停用 " + model.name : "已启用 " + model.name);
			}

			var takenNames = useMemo(
				function () {
					var editingName = drawer && drawer.mode === "edit" ? drawer.name : null;
					return models
						.filter(function (model) {
							return model.entry !== null && model.name !== editingName;
						})
						.map(function (model) {
							return model.name;
						});
				},
				[models, drawer]
			);

			var showDetailOnNarrow = Boolean(selected);

			return h(
				"div",
				{ className: "mc-root" + (showDetailOnNarrow ? " mc-root-detail" : "") },
				access.error || state.watchError
					? h(Banner, {
							key: "runtime",
							tone: "warn",
							title: access.error ? "运行时接口不可用" : "状态流中断",
							detail: access.error || state.watchError
						})
					: null,
				!form || config.status === "unavailable"
					? h(Banner, {
							key: "config",
							tone: "warn",
							title: "配置通道不可用",
							detail: !form ? "configForms 没有返回 mcp-manager 的表单，面板只能查看运行时状态。" : "mcp-manager 配置不可读或尚未就绪。"
						})
					: null,
				h(
					"div",
					{ className: "mc-topbar" },
					h(
						"div",
						{ className: "mc-topbar-left" },
						h("div", { className: "mc-heading" }, "MCP 服务器"),
						h(
							"div",
							{ className: "mc-heading-sub" },
							plural(counts.all, "条配置"),
							h("span", { className: "mc-sep" }, "·"),
							counts.connected + " 已连接",
							counts.issue > 0 ? h("span", { className: "mc-sep" }, "·") : null,
							counts.issue > 0 ? h("span", { className: "mc-warn-text" }, counts.issue + " 需处理") : null
						)
					),
					h(
						"div",
						{ className: "mc-topbar-right" },
						h(
							"div",
							{ className: "mc-search" },
							icon("IconSearchOutlineMedium", 15),
							h("input", {
								className: "mc-search-input",
								value: query,
								placeholder: "搜索名称或命令",
								onChange: function (event) { setQuery(event.target.value); }
							})
						),
						h(
							"button",
							{
								type: "button",
								className: "mc-btn mc-btn-primary",
								disabled: !canWrite,
								title: canWrite ? "新增一条 MCP 服务器" : "配置当前不可写",
								onClick: function () { setDrawer({ mode: "create" }); }
							},
							icon("IconPlusOutlineMedium", 15),
							h("span", { className: "mc-btn-text" }, "新增")
						),
						h(
							IconButton,
							{
								title: "入口显示设置",
								onClick: function () { setShowPrefs(!showPrefs); }
							},
							icon("IconSlidersTwoOutlineMedium", 16)
						)
					)
				),
				showPrefs ? h("div", { className: "mc-prefs-host" }, h(PrefsBlock, { slim: true })) : null,
				h(
					"div",
					{ className: "mc-filterbar" },
					FILTERS.map(function (item) {
						var count = counts[item.id] === undefined ? 0 : counts[item.id];
						return h(
							"button",
							{
								type: "button",
								key: item.id,
								className: "mc-chip" + (filter === item.id ? " is-active" : ""),
								onClick: function () { setFilter(item.id); }
							},
							item.label,
							h("span", { className: "mc-chip-count" }, String(count))
						);
					})
				),
				h(
					"div",
					{ className: "mc-body" },
					h(
						"div",
						{ className: "mc-list" },
						state.views === null
							? h("div", { className: "mc-list-hint" }, icon("IconLoadingOutlineMedium", 16), h("span", null, "正在读取运行时状态…"))
							: visible.length === 0
								? h(
										"div",
										{ className: "mc-list-hint" },
										h("span", null, models.length === 0 ? "还没有 MCP 服务器。点右上角「新增」加一条。" : "没有匹配的条目。")
									)
								: visible.map(function (model) {
										return h(ServerRow, {
											key: model.name,
											model: model,
											active: model.name === selectedName,
											busy: Boolean(state.busy[model.name]),
											onSelect: function () { setSelectedName(model.name); },
											onProbe: function () { probe(model.name); },
											onRestart: function () { restart(model.name); }
										});
									})
					),
					h(
						"div",
						{ className: "mc-detail-host" },
						selected
							? h(
									"button",
									{ type: "button", className: "mc-back", onClick: function () { setSelectedName(null); } },
									icon("IconChevronLeftOutlineMedium", 14),
									"返回列表"
								)
							: null,
						h(DetailPane, {
							model: selected,
							now: now,
							store: store,
							probe: state.probe,
							busy: selected ? Boolean(state.busy[selected.name]) : false,
							onProbe: function () { if (selected) probe(selected.name); },
							onRestart: function () { if (selected) restart(selected.name); },
							onEdit: function () { if (selected) setDrawer({ mode: "edit", name: selected.name }); },
							onDelete: function () { if (selected) setConfirming(selected.name); },
							onToggle: function () { if (selected) toggleEnabled(selected); }
						})
					)
				),
				drawer
					? h(Drawer, {
							key: drawer.mode === "edit" ? "edit:" + drawer.name : "create",
							originalName: drawer.mode === "edit" ? drawer.name : null,
							entry: drawer.mode === "edit" ? (models.filter(function (model) { return model.name === drawer.name; })[0] || {}).entry : null,
							takenNames: takenNames,
							canWrite: canWrite,
							onClose: function () { setDrawer(null); },
							onSave: saveEntry
						})
					: null,
				confirming
					? h(ConfirmDialog, {
							name: confirming,
							onCancel: function () { setConfirming(null); },
							onConfirm: function () { deleteEntry(confirming); }
						})
					: null,
				h(Toast, { record: state.toast })
			);
		}

		// ── 样式 ────────────────────────────────────────────────────────────────

		var STYLE_ID = "dsh-mcp-console-style";
		var CSS = [
			".mc-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;font-family:-apple-system,'PingFang SC','HarmonyOS Sans SC','MiSans','Microsoft YaHei',system-ui,sans-serif;position:relative}",
			".mc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
			".mc-muted{color:var(--dsw-alias-label-secondary)}",
			".mc-warn-text{color:var(--dsw-alias-state-warn-primary)}",
			".mc-error-text{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-all}",
			".mc-sep{margin:0 6px;color:var(--dsw-alias-border-l3)}",
			".mc-banner{display:flex;gap:8px;align-items:flex-start;margin:12px 16px 0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
			".mc-banner-text{display:flex;flex-direction:column;gap:2px}",
			".mc-banner-detail{font-size:12px;word-break:break-all;color:var(--dsw-alias-label-tertiary)}",
			".mc-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px 12px;flex-wrap:wrap}",
			".mc-heading{font-size:17px;font-weight:600;letter-spacing:.01em}",
			".mc-heading-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
			".mc-topbar-right{display:flex;align-items:center;gap:8px}",
			".mc-search{display:flex;align-items:center;gap:6px;padding:0 10px;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary)}",
			".mc-search-input{border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);width:180px;font-size:13px}",
			".mc-search:focus-within{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 22%,transparent)}",
			".mc-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".mc-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;transition:background .16s ease,border-color .16s ease,opacity .16s ease}",
			".mc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".mc-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base);border-color:transparent}",
			".mc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill));opacity:.9}",
			".mc-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l2)}",
			".mc-btn-danger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}",
			".mc-btn:disabled{opacity:.45;cursor:not-allowed}",
			".mc-filterbar{display:flex;gap:6px;padding:0 20px 12px;flex-wrap:wrap}",
			".mc-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
			".mc-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".mc-chip.is-active{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border-color:transparent}",
			".mc-chip-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".mc-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,360px) minmax(0,1fr);border-top:1px solid var(--dsw-alias-border-l3)}",
			".mc-list{overflow:auto;padding:8px;border-right:1px solid var(--dsw-alias-border-l3);min-height:0}",
			".mc-list-hint{display:flex;align-items:center;gap:8px;padding:20px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".mc-row{display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:8px;cursor:pointer;outline:0}",
			".mc-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".mc-row.is-active{background:var(--dsw-alias-button-ghost-active-fill)}",
			".mc-row:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary-new-colorprimary-new-color)}",
			".mc-row-main{flex:1;min-width:0}",
			".mc-row-title{display:flex;align-items:center;gap:6px}",
			".mc-row-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mc-row-sub{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}",
			".mc-row-side{display:flex;align-items:center;gap:8px}",
			".mc-row-status{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}",
			".mc-row-actions{display:flex;gap:2px;opacity:0;transition:opacity .16s ease}",
			".mc-row:hover .mc-row-actions,.mc-row.is-active .mc-row-actions,.mc-row:focus-within .mc-row-actions{opacity:1}",
			// 触屏没有 hover：动作按钮必须常驻，否则根本没法发现。
			"@media (hover:none){.mc-row-actions,.mc-pop-actions{opacity:1}}",
			".mc-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}",
			".mc-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".mc-icon-btn:disabled{opacity:.4;cursor:not-allowed}",
			".mc-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}",
			".mc-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}",
			".mc-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".mc-pill-text{font-variant-numeric:tabular-nums}",
			".mc-dot-ok{background:var(--dsw-alias-state-success-primary)}",
			".mc-dot-busy{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);animation:mc-pulse 1.4s ease-in-out infinite}",
			".mc-dot-warn{background:var(--dsw-alias-state-warn-primary)}",
			".mc-dot-error{background:var(--dsw-alias-state-error-primary)}",
			".mc-dot-idle{background:var(--dsw-alias-state-idle-primary)}",
			"@keyframes mc-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
			".mc-detail-host{display:flex;flex-direction:column;min-height:0;overflow:hidden}",
			".mc-back{display:none;align-items:center;gap:4px;margin:10px 12px 0;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
			".mc-detail{overflow:auto;padding:18px 22px 28px;min-height:0}",
			".mc-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}",
			".mc-detail-title{display:flex;align-items:center;gap:8px;min-width:0}",
			".mc-detail-name{font-size:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mc-detail-actions{display:flex;gap:6px;flex-wrap:wrap}",
			".mc-section{margin-top:22px}",
			".mc-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:none;letter-spacing:.02em;margin-bottom:8px}",
			".mc-status-block{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".mc-status-label{font-weight:500}",
			".mc-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}",
			".mc-tag-quiet{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
			".mc-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}",
			".mc-tool-head{display:flex;align-items:center;gap:6px;width:100%;min-height:24px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
			".mc-section-title-inline{margin-bottom:0}",
			".mc-tool-chevron{display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);transition:transform .16s cubic-bezier(.2,.8,.2,1)}",
			".mc-tool-head[aria-expanded=\"true\"] .mc-tool-chevron{transform:rotate(90deg)}",
			".mc-tool-hint{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".mc-tool-head:hover .mc-tool-hint{color:var(--dsw-alias-label-secondary)}",
			".mc-tool-loading{margin-top:8px}",
			".mc-tool-filter{width:100%;height:28px;margin-top:8px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}",
			".mc-tool-filter:focus{border-color:var(--dsw-alias-brand-primary)}",
			".mc-probe{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}",
			".mc-probe-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".mc-probe-line{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px}",
			".mc-probe-fail{border-color:var(--dsw-alias-state-error-primary)}",
			".mc-config{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1)}",
			".mc-kv-row{display:flex;gap:10px;font-size:12px}",
			".mc-kv-row .mc-kv-key{flex:none;width:88px;color:var(--dsw-alias-label-tertiary)}",
			".mc-kv-value{color:var(--dsw-alias-label-primary);word-break:break-all}",
			".mc-kv-list{display:flex;flex-direction:column;gap:4px;margin-top:6px}",
			".mc-kv{display:flex;gap:10px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
			".mc-kv-key{flex:none;min-width:150px;color:var(--dsw-alias-label-tertiary)}",
			".mc-details{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".mc-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}",
			".mc-link-btn{border:0;background:transparent;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);font-size:12px;cursor:pointer;padding:4px 0;align-self:flex-start}",
			".mc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;color:var(--dsw-alias-label-tertiary);padding:40px 20px;text-align:center}",
			".mc-empty-title{color:var(--dsw-alias-label-primary);font-weight:500}",
			".mc-drawer-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;justify-content:flex-end;z-index:20}",
			".mc-drawer{width:min(480px,100%);height:100%;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l3);display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.18)}",
			".mc-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l3)}",
			".mc-drawer-title{font-size:15px;font-weight:600}",
			".mc-drawer-body{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}",
			".mc-drawer-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l3)}",
			".mc-field{display:flex;flex-direction:column;gap:5px}",
			".mc-field-label{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:baseline}",
			".mc-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".mc-field-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
			".mc-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:0}",
			".mc-input:focus{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}",
			".mc-input:disabled{opacity:.6}",
			".mc-textarea{height:auto;padding:8px 10px;resize:vertical;line-height:1.5}",
			".mc-segment{display:flex;gap:6px}",
			".mc-segment-item{flex:1;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
			".mc-segment-item.is-active{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border-color:transparent}",
			".mc-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
			".mc-check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".mc-confirm{width:min(360px,calc(100% - 32px));margin:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.22)}",
			".mc-confirm-title{font-size:15px;font-weight:600;margin-bottom:8px}",
			".mc-confirm-body{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.6}",
			".mc-confirm-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}",
			".mc-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100% - 32px));padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);z-index:30}",
			".mc-toast-error{color:var(--dsw-alias-state-error-primary)}",
			".mc-toast-ok{color:var(--dsw-alias-label-primary)}",
			"@media (max-width:720px){.mc-body{grid-template-columns:minmax(0,1fr)}.mc-list{border-right:0}.mc-root-detail .mc-list{display:none}.mc-root-detail .mc-detail-host{display:flex}.mc-root:not(.mc-root-detail) .mc-detail-host{display:none}.mc-back{display:inline-flex}.mc-search-input{width:120px}.mc-btn-text{display:none}}",
			"@media (prefers-reduced-motion:reduce){.mc-dot-busy{animation:none}.mc-btn,.mc-row-actions,.mc-pop-actions{transition:none}}",
			// ── 头部胶囊的浮层（比主面板轻一档：只看状态 + 快捷动作）─────────────
			".mc-pill-wrap{position:relative;display:inline-flex;align-items:center}",
			".mc-pill-pop{position:fixed;z-index:60;min-width:300px;max-width:360px;max-height:min(62vh,440px);overflow:auto;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.26)}",
			".mc-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px 8px;border-bottom:1px solid var(--dsw-alias-border-l3)}",
			".mc-pop-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".mc-pop-list{display:flex;flex-direction:column;gap:1px;padding:6px 0}",
			".mc-pop-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-primary)}",
			".mc-pop-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".mc-pop-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mc-pop-state{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}",
			".mc-pop-actions{display:flex;gap:2px;opacity:0;transition:opacity .16s ease}",
			".mc-pop-row:hover .mc-pop-actions,.mc-pop-row:focus-within .mc-pop-actions{opacity:1}",
			".mc-pop-empty{padding:12px 8px;font-size:12px}",
			".mc-pop-foot{display:flex;justify-content:flex-end;gap:8px;padding:8px 4px 2px;border-top:1px solid var(--dsw-alias-border-l3)}",
			// ── 入口开关 ────────────────────────────────────────────────────────
			".mc-prefs{display:flex;flex-direction:column;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l3)}",
			".mc-prefs-host{padding:0 20px 12px}",
			".mc-prefs-host .mc-prefs-slim{padding:0 0 4px;border-bottom:0}",
			".mc-prefs-slim{padding:0 0 14px;border-bottom:0;border-bottom:1px solid var(--dsw-alias-border-l3);margin-bottom:14px}",
			".mc-prefs-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:8px}",
			".mc-pref-row{display:flex;align-items:center;gap:12px;padding:6px 0}",
			".mc-pref-text{flex:1;min-width:0}",
			".mc-pref-name{font-size:13px;color:var(--dsw-alias-label-primary)}",
			".mc-pref-desc{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
			".mc-prefs-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6;margin-top:8px}",
			".mc-switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-state-idle-primary);cursor:pointer;transition:background .18s ease}",
			".mc-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s ease;box-shadow:0 1px 2px rgba(0,0,0,.2)}",
			".mc-switch[aria-checked=\"true\"]{background:var(--dsw-alias-state-success-primary)}",
			".mc-switch[aria-checked=\"true\"]::after{transform:translateX(14px)}",
			".mc-switch:focus-visible{outline:0;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary-new-colorprimary-new-color)}",
			// ── 设置页：单列卡片（和两栏控制台是两套观感）──────────────────────
			".mc-set{position:relative;padding:20px;max-width:720px;height:100%;overflow:auto;color:var(--dsw-alias-label-primary)}",
			".mc-set-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}",
			".mc-set-titlewrap{min-width:0}",
			".mc-set-title{font-size:15px;font-weight:600}",
			".mc-set-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:3px}",
			".mc-set-list{display:flex;flex-direction:column;gap:10px}",
			".mc-set-card{padding:12px 14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3));border-radius:10px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}",
			".mc-set-card-head{display:flex;align-items:center;gap:8px;min-width:0}",
			".mc-set-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mc-set-tag{flex:none;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}",
			".mc-set-state{margin-left:auto;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".mc-set-cmd{margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mc-set-actions{display:flex;align-items:center;gap:8px;margin-top:10px}",
			".mc-set-readonly{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".mc-set-empty{display:flex;align-items:center;gap:12px;padding:18px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
			// ── 插件页摘要行 ────────────────────────────────────────────────────
			".mc-bundle{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".mc-bundle-text{flex:1;min-width:0}",
			// 减动效兜底放最后：同优先级下后写的 transition 会覆盖前面的 media 块。
			"@media (prefers-reduced-motion:reduce){.mc-dot-busy{animation:none}.mc-btn,.mc-row-actions,.mc-pop-actions,.mc-switch,.mc-switch::after{transition:none}}"
		].join("\n");

		// ── 装配 ────────────────────────────────────────────────────────────────

		function resolveAccess(ctx) {
			var remote = null;
			try {
				remote = ctx.get("remote");
			} catch (error) {
				return { api: null, error: "取 remote 服务失败：" + describeError(error) };
			}
			if (!remote) return { api: null, error: "remote 服务不可用（注入未生效）" };
			var api = null;
			try {
				api = remote.mcpManager;
			} catch (error) {
				api = null;
			}
			if (!api) {
				try {
					api = ctx.get("remote.mcpManager");
				} catch (error) {
					api = null;
				}
			}
			if (!api) return { api: null, error: "remote.mcpManager 命名空间不存在：@deepseek-ai/dsh-mcp-manager 可能未启用" };
			if (typeof api.watch !== "function" || typeof api.probe !== "function" || typeof api.restart !== "function") {
				return { api: null, error: "remote.mcpManager 缺少 watch/probe/restart 方法" };
			}
			return { api: api, error: null };
		}

		function resolveForm(ctx, store) {
			var forms = null;
			try {
				forms = ctx.configForms;
			} catch (error) {
				store.toast("error", "取 configForms 服务失败：" + describeError(error));
			}
			if (!forms || typeof forms.get !== "function") return null;
			var candidates = [ENTRY_ID, "include:" + ENTRY_ID];
			try {
				var described = forms.describe && typeof forms.describe === "function" ? forms.describe().getSnapshot() : null;
				var namespaces = described && described.view && Array.isArray(described.view.namespaces) ? described.view.namespaces : [];
				namespaces.forEach(function (view) {
					if (typeof view.ns === "string" && /(^|[:_-])mcp-manager$/.test(view.ns) && candidates.indexOf(view.ns) === -1) candidates.unshift(view.ns);
				});
			} catch (error) {
				/* 拿不到目录就直接按已知 id 试 */
			}
			for (var index = 0; index < candidates.length; index += 1) {
				try {
					var form = forms.get(candidates[index]);
					if (form) return form;
				} catch (error) {
					/* 试下一个候选 */
				}
			}
			return null;
		}

		return {
			// layout 必须硬声明：cordis 的插件上下文只暴露自己 inject 过的服务，
			// 不声明的话 ctx.get("layout") 是 undefined（浮层里点「打开控制台」会静默没反应）。
			inject: ["slots", "remote", "configForms", "layout"],
			apply: function apply(ctx) {
				var store = createStore();
				var runtime = createRuntime(store);

				ctx.effect(
					function () {
						var style = document.createElement("style");
						style.id = STYLE_ID;
						style.textContent = CSS;
						document.head.appendChild(style);
						return function () {
							style.remove();
						};
					},
					"mcp-console: styles"
				);

				// 懒绑定：api-remotes 的 remote.<ns> 子服务与 settings 文档都是异步挂上来的，
				// 插件 apply 的瞬间可能还没就绪，所以带重试地解析，取到 access 后再起 watch，
				// 两者齐了才停；卸载时把定时器、订阅和流一并清掉。
				ctx.effect(
					function () {
						var stopped = false;
						var timer = null;
						var controller = null;
						var handle = null;
						var task = null;
						var tries = 0;

						var retryTimer = null;
						var retryDelay = 1000;

						// 流是可重建资源：断掉要回收句柄并退避重连，
						// 否则 Host 重启 / 升级 / 连接重置之后面板会永久停在最后那一帧。
						function recycle() {
							try {
								if (controller) controller.abort();
							} catch (error) {
								/* 取消流失败不影响后续 */
							}
							try {
								if (handle && typeof handle.dispose === "function") handle.dispose();
							} catch (error) {
								/* 关闭流失败不影响后续 */
							}
							if (task) task.catch(function () {});
							controller = null;
							handle = null;
							task = null;
						}

						function scheduleRetry() {
							if (stopped || retryTimer) return;
							var wait = retryDelay;
							retryDelay = Math.min(retryDelay * 2, 30000);
							retryTimer = setTimeout(function () {
								retryTimer = null;
								attempt();
							}, wait);
						}

						function stopWatch() {
							recycle();
						}

						function startWatch(api) {
							if (stopped || handle) return;
							controller = new AbortController();
							try {
								handle = api.watch(controller.signal);
							} catch (error) {
								store.setWatchError("watch 调用失败：" + describeError(error));
								scheduleRetry();
								return;
							}
							var streamController = controller;
							task = (async function () {
								try {
									for await (var list of handle) {
										if (stopped) return;
										if (list && list.ok === false) {
											store.setWatchError("状态流出错：" + failureText(list));
											break;
										}
										var views = list;
										if (views && !Array.isArray(views) && Array.isArray(views.value)) views = views.value;
										if (!Array.isArray(views)) {
											// 忽略坏帧，别把整屏清空成「还没有 MCP 服务器」。
											store.setWatchError("状态流返回了无法识别的数据，已忽略这一帧");
											continue;
										}
										retryDelay = 1000;
										store.setViews(views);
									}
									if (!stopped) {
										store.setWatchError("状态流已结束，正在重连…");
										scheduleRetry();
									}
								} catch (error) {
									if (!stopped && streamController && !streamController.signal.aborted) {
										store.setWatchError("状态流中断，正在重连：" + describeError(error));
										scheduleRetry();
									}
								} finally {
									recycle();
								}
							})();
						}

						function attempt() {
							if (stopped) return;
							var before = store.getSnapshot();
							var hadApi = !!(before.access && before.access.api);
							var access = hadApi ? before.access : resolveAccess(ctx);
							var hasApi = !!access.api;
							var form = before.form || resolveForm(ctx, store);
							var patch = Object.create(null);
							var prevError = before.access ? before.access.error || "" : null;
							// 只有「还没有 access」或「失败原因变了」才写回，避免每次重试都触发重渲染；
							// 失败原因变了必须写回，否则横幅会永远停在第一句话。
							if (!before.access || (!hasApi && prevError !== (access.error || ""))) patch.access = access;
							if (form && before.form !== form) patch.form = form;
							if (Object.keys(patch).length > 0) store.patch(patch);
							if (hasApi) startWatch(access.api);
							if (hasApi && form) return;
							// 不设放弃上限：configForms / remote.<ns> 可能几十秒后才挂上来。
							// 前 20 次快试（约 14 秒），之后放慢到 3 秒一次，直到卸载。
							tries += 1;
							timer = setTimeout(attempt, tries < 20 ? 700 : 3000);
						}

						attempt();
						return function () {
							stopped = true;
							if (timer) clearTimeout(timer);
							if (retryTimer) clearTimeout(retryTimer);
							stopWatch();
							runtime.cancelProbes();
						};
					},
					"mcp-console: remote binding + runtime watch"
				);

				function Panel() {
					return h(PanelView, { store: store });
				}

				function SidebarIcon(sideProps) {
					var size = sideProps && typeof sideProps.size === "number" ? sideProps.size : 18;
					var glyph = icon("IconPluginPinwheelOutlineMedium", size) || icon("IconLayersOutlineMedium", size);
					return glyph || h("span", { style: { fontSize: size + "px", lineHeight: 1 } }, "M");
				}

				// 会话头部右上角的常驻小胶囊：点开是个浮层，不把人从当前会话拽走。
				function HeaderPill() {
					var pillState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
					var openState = useState(false);
					var open = openState[0];
					var setOpen = openState[1];
					var rectState = useState(null);
					var rect = rectState[0];
					var setRect = rectState[1];
					var popRef = useRef(null);
					var wrapRef = useRef(null);
					// views 为 null 表示运行时状态还没到，别急着说「未配置」。
					var viewsLoaded = Array.isArray(pillState.views);
					// 跟控制台/设置页读同一份 buildModels：只在配置里有、运行时还没实例化的条目
					// 以前在胶囊里根本不出现，用户会以为它不存在。
					var pillConfig = useConfigSnapshot(pillState.form);
					var models = useMemo(
						function () {
							return buildModels(pillConfig, pillState.views);
						},
						[pillConfig, pillState.views]
					);
					var counts = { total: models.length, connected: 0, issue: 0, disabled: 0, connecting: 0, idle: 0 };
					models.forEach(function (model) {
						var key = statusKeyOf(model.view);
						if (key === "connected") counts.connected += 1;
						else if (key === "disabled") counts.disabled += 1;
						else if (isIssue(model.view)) counts.issue += 1;
						else if (key === "connecting" || key === "reconnecting") counts.connecting += 1;
						else counts.idle += 1;
					});
					// 只有真的在连的时候才让状态点脉冲，否则会话头会一直闪。
					var tone = counts.issue > 0 ? "error" : counts.connecting > 0 ? "busy" : counts.total > 0 && counts.connected === counts.total ? "ok" : "idle";
					var text = !viewsLoaded && !pillConfig.status ? "MCP …" : counts.total === 0 ? "MCP 未配置" : "MCP " + counts.connected + "/" + counts.total;
					var title = !viewsLoaded
						? "MCP 服务器：正在读取运行时状态…"
						: counts.total === 0
							? "MCP 服务器：还没有配置（点开查看）"
							: "MCP 服务器 " +
								counts.total +
								" 个：" +
								counts.connected +
								" 已连接" +
								(counts.issue ? "，" + counts.issue + " 需处理" : "") +
								(counts.disabled ? "，" + counts.disabled + " 已停用" : "") +
								(counts.connecting ? "，" + counts.connecting + " 连接中" : "") +
								(counts.idle ? "，" + counts.idle + " 未连接" : "") +
								"（点开查看）";

					// 点外面关掉：wrap 里的胶囊按钮不算「外面」，否则点它先关后开，永远关不掉。
					useEffect(
						function () {
							if (!open) return undefined;
							function onPointerDown(event) {
								var pop = popRef.current;
								if (pop && pop.contains && event && pop.contains(event.target)) return;
								var wrap = wrapRef.current;
								if (wrap && wrap.contains && event && wrap.contains(event.target)) return;
								setOpen(false);
							}
							function onKeyDown(event) {
								if (event && (event.key === "Escape" || event.key === "Esc")) setOpen(false);
							}
							function reposition() {
								var wrap = wrapRef.current;
								if (!wrap || typeof wrap.getBoundingClientRect !== "function") return;
								setRect(wrap.getBoundingClientRect());
							}
							document.addEventListener("pointerdown", onPointerDown, true);
							document.addEventListener("keydown", onKeyDown);
							window.addEventListener("scroll", reposition, true);
							window.addEventListener("resize", reposition);
							return function () {
								document.removeEventListener("pointerdown", onPointerDown, true);
								document.removeEventListener("keydown", onKeyDown);
								window.removeEventListener("scroll", reposition, true);
								window.removeEventListener("resize", reposition);
							};
						},
						[open]
					);

					var popover = null;
					if (open && rect) {
						popover = h(
							"div",
							{
								className: "mc-pill-pop",
								ref: popRef,
								style: { top: Math.round(rect.bottom + 8) + "px", right: Math.max(10, Math.round(window.innerWidth - rect.right)) + "px" }
							},
							h(
								"div",
								{ className: "mc-pop-head" },
								h("span", { className: "mc-pop-title" }, "MCP 服务器"),
								h("span", { className: "mc-muted" }, counts.connected + "/" + counts.total + " 已连接")
							),
							models.length > 0
								? h(
										"div",
										{ className: "mc-pop-list" },
										models.map(function (model) {
											var meta = metaOf(model.view);
											var key = statusKeyOf(model.view);
											var busy = Boolean(pillState.busy && pillState.busy[model.name]);
											var suffix = key === "connected" && model.view && model.view.status && typeof model.view.status.toolCount === "number" ? " · " + model.view.status.toolCount + " 工具" : "";
											return h(
												"div",
												{ className: "mc-pop-row", key: model.name },
												h(StatusDot, { tone: meta.tone }),
												h("span", { className: "mc-pop-name" }, model.name),
												h("span", { className: "mc-pop-state" }, model.view ? meta.label + suffix : "未实例化"),
												h(
													"span",
													{ className: "mc-pop-actions" },
													h(IconButton, { title: "探测（新建临时连接，不影响正在跑的实例）", disabled: busy, onClick: function () { runtime.probe(model.name); } }, icon("IconInspectOutlineMedium", 15)),
													h(IconButton, { title: "重连", disabled: busy || key === "disabled", onClick: function () { runtime.restart(model.name); } }, icon("IconRefreshOutlineMedium", 15))
												)
											);
										})
									)
								: h("div", { className: "mc-muted mc-pop-empty" }, viewsLoaded || pillConfig.status === "ready" ? "还没有配置 MCP 服务器。" : "正在读取运行时状态…"),
							h(
								"div",
								{ className: "mc-pop-foot" },
								h(
									Button,
									{
										onClick: function () {
											setOpen(false);
											openConsole();
										}
									},
									"打开控制台"
								),
								h(
									Button,
									{
										onClick: function () {
											setOpen(false);
										}
									},
									"关闭"
								)
							)
						);
					}

					return h(
						"span",
						{ className: "mc-pill-wrap", ref: wrapRef },
						h(
							"button",
							{
								type: "button",
								className: "mc-pill",
								title: title,
								"aria-label": title,
								"aria-expanded": open ? "true" : "false",
								"aria-haspopup": "dialog",
								onClick: function (event) {
									var target = event && event.currentTarget;
									if (target && typeof target.getBoundingClientRect === "function") {
										setRect(target.getBoundingClientRect());
									}
									setOpen(!open);
								}
							},
							h(StatusDot, { tone: tone }),
							h("span", { className: "mc-pill-text" }, text)
						),
						popover,
						// toast 放在浮层外面：浮层一关错误就跟着消失，等于没提示。
						h(Toast, { record: pillState.toast })
					);
				}

				// 切到控制台主面板。layout 走 inject 声明（ctx.layout）；
				// 拿不到或抛错都要说清楚，别让按钮看着没反应。
				function openConsole() {
					var candidates = [];
					try {
						if (ctx.layout) candidates.push(ctx.layout);
					} catch (error) {
						/* 取不到就试下一个 */
					}
					try {
						if (typeof ctx.get === "function") {
							var viaGet = ctx.get("layout");
							if (viaGet) candidates.push(viaGet);
						}
					} catch (error) {
						/* 同上 */
					}
					var lastError = null;
					for (var index = 0; index < candidates.length; index++) {
						var service = candidates[index];
						if (!service || typeof service.selectPanel !== "function") continue;
						try {
							service.selectPanel(PANEL_ID);
							return true;
						} catch (error) {
							lastError = describeError(error);
						}
					}
					store.toast("error", "切不到控制台：" + (lastError || "layout 服务不可用"));
					return false;
				}

				// 设置页专用视图：单列卡片。设置面板只有一栏宽，摊不开两栏控制台，
				// 所以这里只做「看一眼状态 + 探测/重连/启停 + 去控制台」，编辑留在控制台里。
				function SettingsView() {
					var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
					var access = state.access || { api: null, error: "正在连接 remote.mcpManager…" };
					var form = state.form;
					var config = useConfigSnapshot(form);
					var models = useMemo(
						function () {
							return buildModels(config, state.views);
						},
						[config, state.views]
					);
					var counts = useMemo(
						function () {
							var result = { total: models.length, connected: 0, issue: 0 };
							models.forEach(function (model) {
								if (statusKeyOf(model.view) === "connected") result.connected += 1;
								if (isIssue(model.view)) result.issue += 1;
							});
							return result;
						},
						[models]
					);

					function toggle(model) {
						if (!model.entry) return;
						var snapshot = form ? form.getSnapshot() : null;
						if (!snapshot || snapshot.status !== "ready" || !snapshot.writable || snapshot.revision === undefined) {
							store.toast("error", "配置通道不可写，改不了这一条");
							return;
						}
						var next = Object.assign({}, model.entry, { enabled: model.entry.enabled === false });
						if (next.enabled === true) delete next.enabled;
						Promise.resolve()
							.then(function () {
								return form.mutate([{ op: "set", path: ["servers", model.name], value: next }], snapshot.revision);
							})
							.then(function (accepted) {
								if (accepted === false) store.toast("error", "保存被拒绝：配置可能刚被别处改过");
								else store.toast("ok", next.enabled === false ? "已停用 " + model.name : "已启用 " + model.name);
							})
							.catch(function (error) {
								store.toast("error", "保存失败：" + describeError(error));
							});
					}

					function summaryOf(model) {
						var entry = model.entry;
						if (!entry) return "由插件提供，只读";
						if (entry.transport === "streamable-http") return "HTTP · " + (entry.url || "未填写");
						return "stdio · " + ([entry.command || "未填写"].concat(entry.args || []).join(" "));
					}

					return h(
						"div",
						{ className: "mc-set" },
						h(PrefsBlock, { slim: true }),
						h(
							"div",
							{ className: "mc-set-head" },
							h(
								"div",
								{ className: "mc-set-titlewrap" },
								h("div", { className: "mc-set-title" }, "MCP 服务器"),
								h(
									"div",
									{ className: "mc-set-sub" },
									counts.total + " 个 · " + counts.connected + " 已连接" + (counts.issue ? " · " + counts.issue + " 需处理" : "")
								)
							),
							h(Button, { onClick: openConsole }, "打开控制台")
						),
						access.error ? h(Banner, { tone: "warn", title: "运行时接口不可用", detail: access.error }) : null,
						models.length === 0
							? h(
									"div",
									{ className: "mc-set-empty" },
									access.api ? "还没有配置 MCP 服务器。" : access.error || "运行时接口不可用。",
									h(Button, { onClick: openConsole }, "去控制台新增")
								)
							: h(
									"div",
									{ className: "mc-set-list" },
									models.map(function (model) {
										var meta = metaOf(model.view);
										var key = statusKeyOf(model.view);
										var busy = Boolean(state.busy && state.busy[model.name]);
										var toolSuffix =
											key === "connected" && model.view && model.view.status && typeof model.view.status.toolCount === "number"
												? model.view.status.toolCount + " 个工具"
												: "";
										return h(
											"div",
											{ className: "mc-set-card", key: model.name },
											h(
												"div",
												{ className: "mc-set-card-head" },
												h(StatusDot, { tone: meta.tone }),
												h("span", { className: "mc-set-name" }, model.name),
												toolSuffix ? h("span", { className: "mc-set-tag" }, toolSuffix) : null,
												h("span", { className: "mc-set-state" }, meta.label)
											),
											h("div", { className: "mc-set-cmd", title: summaryOf(model) }, summaryOf(model)),
											h(
												"div",
												{ className: "mc-set-actions" },
												h(
													Button,
													{
														disabled: busy || !access.api,
														onClick: function () {
															runtime.probe(model.name);
														}
													},
													"探测"
												),
												h(
													Button,
													{
														disabled: busy || !access.api || key !== "connected",
														onClick: function () {
															runtime.restart(model.name);
														}
													},
													"重连"
												),
												model.entry
													? h(
															Button,
															{
																disabled: busy,
																onClick: function () {
																	toggle(model);
																}
															},
															model.entry.enabled === false ? "启用" : "停用"
														)
													: h("span", { className: "mc-set-readonly" }, "插件提供")
											)
										);
									})
								),
						h(Toast, { record: state.toast })
					);
				}

				// 插件页（设置 → 插件 → dsh-mcp-console）：summary 只放一行摘要 + 入口，
				// page 视图直接给设置页那份单列卡片，省得再写一套。
				function BundleConfig(props) {
					var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
					var form = state.form;
					var config = useConfigSnapshot(form);
					var models = useMemo(
						function () {
							return buildModels(config, state.views);
						},
						[config, state.views]
					);
					var connected = 0;
					models.forEach(function (model) {
						if (statusKeyOf(model.view) === "connected") connected += 1;
					});
					if (props && props.view === "page") return h(SettingsView, null);
					var tone = models.length > 0 && connected === models.length ? "ok" : connected > 0 ? "busy" : "idle";
					return h(
						"div",
						{ className: "mc-bundle" },
						h(StatusDot, { tone: tone }),
						h("span", { className: "mc-bundle-text" }, models.length === 0 ? "还没有配置 MCP 服务器" : models.length + " 个 MCP 服务器 · " + connected + " 已连接"),
						h(Button, { onClick: openConsole }, "打开控制台")
					);
				}

				// 四个落点全部由 prefs 的开关驱动：拨开关立刻挂上/卸掉，不用重载窗口。
				// main（控制台本体）始终在；侧边栏图标 / 头部胶囊 / 设置页一节各有开关。
				ctx.effect(
					function () {
						var mountedSlots = Object.create(null);

						function normalize(handle) {
							if (typeof handle === "function") return handle;
							if (handle && typeof handle.dispose === "function") {
								return function () {
									handle.dispose();
								};
							}
							return null;
						}

						function disposeSlot(slot) {
							var dispose = mountedSlots[slot];
							if (!dispose) return;
							delete mountedSlots[slot];
							try {
								dispose();
							} catch (error) {
								/* 单个入口卸载失败不影响其它 */
							}
						}

						function disposeAll() {
							var slots = Object.keys(mountedSlots);
							for (var index = 0; index < slots.length; index++) disposeSlot(slots[index]);
						}

						// 每个入口各持一份 disposer：拨开关只动发生变化的那一个。
						// 以前是一次 disposeAll 再全量重挂，连 main 都被拆掉，
						// 于是控制台的选中项、搜索词、填了一半的抽屉全丢，开关面板自己也会被关掉。
						function ensure(slot, wanted, register) {
							if (!wanted) {
								disposeSlot(slot);
								return;
							}
							if (mountedSlots[slot]) return;
							var handle = null;
							try {
								var dispose = normalize(
									ctx.slots.inject(slot, function () {
										handle = register();
										return handle;
									})
								);
								// inject 没回句柄时，退一步自己卸寄存器，避免拨开关后重复注册。
								var own = dispose || normalize(handle);
								if (own) mountedSlots[slot] = own;
							} catch (error) {
								if (typeof console !== "undefined" && console.warn) {
									console.warn("[mcp-console] 槽位 " + slot + " 注册失败（DSH 升级可能改了槽位名）", error);
								}
							}
						}

						function sync() {
							var current = prefs.get();
							ensure("main", true, function () {
								return ctx.slots.register({ name: "main", key: PANEL_ID }, Panel);
							});
							ensure("sidebar.panellist", !!current.sidebarEntry, function () {
								return ctx.slots.register(
									{ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: function () { return "MCP 服务器"; } },
									SidebarIcon
								);
							});
							ensure("conversation.session.header.utilities", !!current.headerPill, function () {
								return ctx.slots.register(
									{
										name: "conversation.session.header.utilities",
										id: "dsh-mcp-console-pill",
										order: 7,
										label: function () {
											return "MCP 服务器";
										}
									},
									HeaderPill
								);
							});
							ensure("settings.section", !!current.settingsSection, function () {
								return ctx.slots.register(
									{
										name: "settings.section",
										id: "mcp-servers",
										order: 31,
										label: function () {
											return "MCP 服务器";
										}
									},
									SettingsView
								);
							});
							ensure("plugins.bundle.config", true, function () {
								return ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-mcp-console" }, BundleConfig);
							});
						}

						sync();
						var unsubscribe = prefs.subscribe(sync);
						return function () {
							unsubscribe();
							disposeAll();
						};
					},
					"mcp-console: entries"
				);
			}
		};
	}
});
