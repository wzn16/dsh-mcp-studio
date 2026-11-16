/**
 * dsh-mcp-console — Host 侧入口。
 *
 * 本插件的能力全部落在客户端：界面通过 @deepseek-ai/dsh-mcp-manager 的远程方法
 * （watch / probe / restart）读运行时状态，通过 configForms 服务改写 mcp-manager 的
 * `servers` 配置。Host 侧不需要注册任何服务，因此这里只提供一个空的 apply。
 *
 * @module dsh-mcp-console
 */

export function apply() {}
