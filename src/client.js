// src/client.js — dsh-computer-use 浏览器半部(手写 ModuleLoader 格式)。
//
// 注册 computer_screenshot 的专属工具卡:把结果里的 image attachment 渲染成
// 真正的 <img>,而不是通用卡片的裸 JSON。图片字节经由 owner props 提供的
// loadImage(会话授权 loader)解析,本文件不 import 任何附件实现、不处理
// URL 授权——与产品 ui-tool 的图卡契约一致。
//
// 注意:id 必须与 package.json 的 name 完全一致(client-modules 的 graph
// entry id 与 __ModuleLoader__ 注册 id 强制相等)。
// read_image 不在这里认领:产品 ui-tool 已自带其图卡(tool.call.images 链路)。
window.__ModuleLoader__.load({
	id: "dsh-computer-use",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// ⚠ 本文件全程必须用小写 react.*:
		// ModuleLoader 的 require 表只提供 "react",浏览器里没有全局 React 对象。
		// 写成大写 React.* 会在渲染时抛 ReferenceError,整张工具卡(乃至整条工具消息)
		// 直接不显示——比不美化更糟。参照 dsh-tool-websearch / dsh-zhihu-tools 的
		// 客户端半边,它们同样是 let react = require("react") + 小写调用。
		let react = require("react");

		const inject = ["slots"];

		// ── 主题 token 语义别名(与 ui-tool / websearch 客户端卡一致) ──
		const T = {
			line: "var(--dsw-alias-line-default, #e8e8e8)",
			fillSecondary: "var(--dsw-alias-fill-secondary, #fff)",
			fillPrimary: "var(--dsw-alias-fill-primary, #fff)",
			fillTertiary: "var(--dsw-alias-fill-tertiary, #f2f2f2)",
			ink: "var(--dsw-alias-label-primary)",
			inkSecondary: "var(--dsw-alias-label-secondary)",
			inkTertiary: "var(--dsw-alias-label-tertiary)",
			mono: "var(--dsw-font-markdown-code-block-small, ui-monospace, monospace)",
			accent: "#056de8",
			error: "var(--dsw-alias-state-error-primary, #c5221f)",
		};

		// ── 样式(纯 inline,无 CSS Modules——浏览器半部零构建) ──
		const S = {
			shell: {
				display: "flex", flexDirection: "column", width: "100%", minWidth: 0,
				borderRadius: 12, border: `1px solid ${T.line}`, background: T.fillSecondary,
				overflow: "hidden", isolation: "isolate", contain: "content", boxSizing: "border-box",
			},
			head: {
				display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", minWidth: 0,
				background: T.fillPrimary, borderBottom: `1px solid ${T.line}`,
			},
			icon: {
				width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center",
				justifyContent: "center", flex: "none", color: "#fff", background: T.accent,
				fontSize: 12, fontWeight: 800, lineHeight: "22px",
			},
			title: {
				fontSize: 13, fontWeight: 700, color: T.ink, minWidth: 0,
				whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
			},
			body: { padding: 12, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 },
			img: {
				width: "100%", height: "auto", borderRadius: 8,
				border: `1px solid ${T.line}`, background: T.fillTertiary, display: "block",
			},
			hint: { fontSize: 12, lineHeight: "18px", color: T.inkSecondary },
			mono: {
				fontSize: 12, lineHeight: "18px", color: T.inkTertiary, fontFamily: T.mono,
				wordBreak: "break-all", whiteSpace: "pre-wrap", margin: 0,
			},
			error: { fontSize: 12, lineHeight: "18px", color: T.error, fontFamily: T.mono, wordBreak: "break-all" },
		};

		// 从 settled ToolCallBlock 的 content 数组提取全部 { type:'image', attachment }。
		// (等价于产品 imageCardModel 的提取步;动态/静态浏览器半部无模块解析能力,
		// 因此在这里以纯函数复刻,输入输出都来自会话事件的 wire 值。)
		function imageAttachments(block) {
			const content = block && block.content;
			if (!Array.isArray(content)) return [];
			return content
				.filter((b) => b && b.type === "image" && b.attachment)
				.map((b) => b.attachment);
		}

		function ScreenshotView(props) {
			const block = props.block;
			const atts = imageAttachments(block);
			const loadImage = props.loadImage;
			const [urls, setUrls] = react.useState([]);
			const [err, setErr] = react.useState("");
			const [loading, setLoading] = react.useState(true);
			react.useEffect(() => {
				let alive = true;
				if (atts.length === 0) { setLoading(false); return undefined; }
				if (typeof loadImage !== "function") {
					setErr("loadImage loader unavailable"); setLoading(false);
					return undefined;
				}
				setLoading(true); setErr("");
				Promise.all(atts.map((att) => loadImage(att)))
					.then((us) => { if (!alive) return; setUrls(us); setLoading(false); })
					.catch((e) => {
						if (!alive) return;
						setErr(String((e && e.message) || e)); setLoading(false);
					});
				return () => { alive = false; };
			}, [atts.length]);

			// 运行中的调用没有 content:只显示占位行,不猜结果。
			let bodyChildren;
			if (err) {
				bodyChildren = react.createElement("div", { style: S.error }, "图片读取失败: " + err);
			} else if (loading && atts.length > 0) {
				bodyChildren = react.createElement("div", { style: S.hint }, "正在加载图片…");
			} else if (atts.length === 0) {
				bodyChildren = react.createElement("pre", { style: S.mono }, "（本次调用未返回图片）");
			} else {
				bodyChildren = atts.map((att, i) => react.createElement("img", {
					key: String(i) + String(att.attachmentId || ""),
					src: urls[i], alt: att.name || "desktop screenshot", style: S.img,
				}));
			}
			return react.createElement(
				"div", { style: S.shell },
				react.createElement(
					"div", { style: S.head },
					react.createElement("span", { style: S.icon }, "图"),
					react.createElement("span", { style: S.title }, "computer_screenshot"),
				),
				react.createElement("div", { style: S.body }, bodyChildren),
			);
		}

		exports.apply = function apply(ctx) {
			// keyed toolview:只认领 computer_screenshot。
			// read_image 的图卡由产品 ui-tool 自带,不在此覆盖。
			const stopInject = ctx.slots.inject("tool.call.toolview", () =>
				ctx.slots.register(
					{ name: "tool.call.toolview", key: "computer_screenshot" },
					ScreenshotView,
				));
			// inject 的返回值已是随 caller fiber 生命周期清理的 disposer。
			return stopInject;
		};
		exports.inject = inject;
		return module.exports;
	},
});
