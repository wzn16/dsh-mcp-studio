# dsh-mcp-console

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的 MCP 服务器控制台：
**实时看连接状态**、**探测**、**重连**、**就地改配置**——不用手改 `cordis.patch.yml`，也不用重启应用。

官方 `mcp-manager` 插件持有数据，暴露出 `watch` / `probe` / `restart` 三个远程方法和一个配置表单，
但**一个界面都没给**。这个插件就是那层界面。它只走官方通道读写，所以你配置里的注释和其余内容都原样保留。

## 为什么做这个

以前要回答「我这个 MCP 服务器到底连上没有」，得去翻 YAML、翻日志。社区里几个尝试展示 MCP 服务器的插件
是自己解析 `cordis.patch.yml` 的，于是它们看到的和宿主实际加载的经常对不上。

这里的连接状态来自宿主自己的运行时状态流，每一次写入都走官方配置表单（带 revision 围栏的原子 mutate）：
不解析 YAML，也不维护配置副本。

## 安装

最省事的方式是让 DSH 里的 agent 装：

> 把 `/path/to/dsh-mcp-console` 这个插件装到我的 profile 里

agent 会调 `plugin_manager`（`action: install_bundle`、`target` 指向该目录）。这是受支持的路径：
它会把这个包链进 profile、写进 `dsh.profile.bundles`，并在生效时返回 `application: applied`。

自己用 pnpm 装也行，但**光有 pnpm 不会注册 bundle**：

```bash
dsh plugin --profile <你的 profile> add link:/abs/path/to/dsh-mcp-console
# 再把 "dsh-mcp-console" 加进 $DSH_HOME/profiles/<你的 profile>/package.json
# 的 "dsh".profile.bundles 里
```

装完后重载一次应用窗口（⌘R / Ctrl+R），客户端 bundle 才会被加载。

## 你会得到什么

四个界面，各有各的活，刻意不是同一个组件换三处壳。

| 界面 | 位置 | 作用 |
| --- | --- | --- |
| **控制台** | 主面板，从侧边栏图标进 | 两栏工作台：服务器列表、详情区、可展开的工具清单、新增/编辑抽屉、删除确认 |
| **浮层** | 会话头部的小胶囊 | 只看不动：计数 + 逐条状态 + 行内探测/重连 + 「打开控制台」 |
| **设置页** | 设置 → MCP 服务器 | 单列卡片：一条一张卡，带探测/重连/启停，以及入口开关 |
| **插件页一行** | 设置 → 插件 → 本插件 | 一行摘要 + 「打开控制台」，仅此而已 |

三个入口都能在 **入口** 区关掉（设置页顶部、控制台里都有）。开关保存在浏览器 `localStorage`
的 `dsh-mcp-console:prefs`，不写配置文件。控制台主面板与插件页那行始终注册着，保证随时能进得来。

## 能做什么

- **探测**：新建一条临时连接、列出工具名、再关掉。不干扰正在跑的实例，停用或失败的服务器也能探。
- **重连**：重连实例并重置重连预算。
- **启用/停用**：整条 entry 重写，停用写 `enabled: false`，启用则删掉该字段。
- **新增/编辑**：写之前先校验——名称规则、两种传输的互斥字段、1–3600000 的整数超时、
  `KEY=VALUE` 与 `Key: Value` 的行形状。
- 其它插件注册进来的服务器（`configured: false`）这里只读：能探测、能重连，不能改。界面上标「由插件注册（只读）」。

## 探测的代价（说实话）

**宿主没有任何接口能读出「运行中实例」的工具名**，工具清单只能靠探测——那是真的临时连接：
`stdio` 要起进程，`streamable-http` 要握手。所以每个探测按钮的提示都写明了这一点，
工具清单也是按需展开，不是每次渲染都去探。

## 和官方设置页的关系

三层，一个归属：

- **数据归属**：`mcp-manager` 插件。`config.servers` 是它的配置，永远只有这一份真身。
- **视图**：本插件把同一份数据渲染成四个位置，自己不留副本。
- **写入**：走 `ctx.configForms.get('mcp-manager')`，冲突由宿主判定，你 YAML 里的注释不会丢。

卸载本插件不会丢任何东西：服务器、状态、官方设置表单都还在。

## 已知限制

- 界面目前**只有中文**（还没接 locale 包）。
- 工具只显示**名字**，不显示 schema 和描述——宿主只给名字。
- **没有 JSON 导入导出**。配置就在 profile 的 patch 文件里，直接去那里读。
- bundle 注册进来的只读服务器改不了（宿主限制，不是界面偷懒）。
- 会话头部那个是小浮层，不是完整面板：那里故意不提供编辑。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 侧边栏图标或胶囊不见了 | 在那个 **入口** 区被关掉了——从「设置 → MCP 服务器」再进，或清掉 localStorage 里的 `dsh-mcp-console:prefs` |
| 提示远程方法不可用 | 这个 profile 里 `mcp-manager` 没启用，或它的远程方法还没挂上来（面板会重试并把原因写在横幅里） |
| 全部显示「状态未知」 | 运行时状态流还没推出第一帧，看横幅里的 watch 报错 |
| 保存被拒 | 宿主拒绝了这次 mutate（通常是并发写）。表单会重新读取文档，再试一次 |
| 装了却没出现 | 重载一次窗口——客户端 bundle 在窗口启动时加载 |

## 权限与数据

- 读：宿主的 MCP 运行时状态流、`mcp-manager` 的配置段。
- 写：只写这一段配置，走官方配置表单（`servers.<name>` 路径）。
- 本地存储：一个 `localStorage` 键（入口开关）。没有遥测，自己不发网络请求。

## 兼容性

- DSH `>=0.2.2-rc.2 <0.3.0-0`（开发与验证都在 `0.2.2-rc.3`）。
- 只有客户端部分；宿主模块（`index.js`）是空实现。
- 注册的槽位：`main`（key `mcp-console`）、`sidebar.panellist`（id `mcp-console`）、
  `conversation.session.header.utilities`（id `dsh-mcp-console-pill`）、
  `settings.section`（id `mcp-servers`）、`plugins.bundle.config`（key `dsh-mcp-console`）。
  DSH 升级后若改名，控制台仍能打开，并会说明是哪个槽位没挂上。

## 开发

单文件客户端 bundle，零构建、零依赖：

- `client.js` — 全部实现（手写 `window.__ModuleLoader__` 工厂、`React.createElement`、CSS 用字符串数组）。
- `index.js` — 宿主模块，故意留空。
- `cordis.patch.yml` — bundle 插入补丁。

开发时用的校验：

```bash
# 语法（DSH 自带 Electron，用它的 Node）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --check client.js
```

另有一个不依赖 DOM 的冒烟测试（`vm` + 假 React + 假 ctx），覆盖 43 项行为：槽位注册、状态流帧、
probe/mutate 调用形状、四个界面、入口开关。

## 路线图

- locale 包（英文界面），文档再做 `--lang` 分流。
- 等宿主给出稳定读写形状后，补 `servers` 的 JSON 导入导出。
- 若 `mcp-manager` 暴露日志，再做逐服务器日志流。

## 许可

MIT，见 [LICENSE](LICENSE)。

English docs: [README.md](README.md)。
