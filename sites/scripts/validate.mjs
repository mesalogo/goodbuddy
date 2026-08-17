import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "assets/goodbuddy-light.png",
  "assets/goodbuddy-dark.png",
  "assets/linux-plain.svg",
  "assets/devicon-LICENSE",
  "README.md",
];

const report = (condition, message) => {
  if (!condition) {
    errors.push(message);
  }
};

const readSiteFile = async (relativePath) => {
  try {
    return await readFile(path.join(siteRoot, relativePath), "utf8");
  } catch {
    errors.push(`缺少文件：${relativePath}`);
    return "";
  }
};

await Promise.all(
  requiredFiles.map(async (relativePath) => {
    try {
      const fileStats = await stat(path.join(siteRoot, relativePath));
      report(fileStats.isFile(), `不是普通文件：${relativePath}`);
    } catch {
      errors.push(`缺少文件：${relativePath}`);
    }
  }),
);

const [html, css, appJs] = await Promise.all([
  readSiteFile("index.html"),
  readSiteFile("styles.css"),
  readSiteFile("app.js"),
]);

for (const [relativePath, content] of [
  ["index.html", html],
  ["styles.css", css],
  ["app.js", appJs],
]) {
  report(!/[ \t]+$/m.test(content), `${relativePath} 包含行尾空白`);
  report(!content.includes("\t"), `${relativePath} 包含 Tab 缩进`);
}

report(/<html\s+lang="zh-CN">/.test(html), "页面语言必须是 zh-CN");
report(/<meta\s+name="viewport"/.test(html), "缺少 viewport 元信息");
report(
  /<link\s+rel="canonical"\s+href="https:\/\/mesalogo\.github\.io\/goodbuddy\/"\s*\/>/.test(
    html,
  ),
  "canonical 地址必须指向 GitHub Pages 正式站点",
);
report((html.match(/<h1[\s>]/g) ?? []).length === 1, "页面必须且只能包含一个 h1");
report(/class="skip-link"\s+href="#main-content"/.test(html), "缺少跳到主要内容链接");
report(/<main\s+id="main-content">/.test(html), "缺少 main-content 主区域");
report(/aria-label="主导航"/.test(html), "主导航缺少可访问名称");
report(/data-theme-toggle/.test(html), "缺少主题切换控件");
report(
  (html.match(/src="\.\/assets\/goodbuddy-light\.png"/g) ?? []).length >= 5,
  "品牌位置必须使用官方亮色图标",
);
report(
  (html.match(/src="\.\/assets\/goodbuddy-dark\.png"/g) ?? []).length >= 5,
  "品牌位置必须使用官方深色图标",
);
report(!/class="brand-mark"/.test(html), "官网不得使用自绘品牌标志");
report(/data-tilt-stage/.test(html), "首屏产品界面缺少倾斜交互区域");
report(/data-tilt-card/.test(html), "首屏产品界面缺少倾斜卡片");
report(/prefers-reduced-motion:\s*reduce/.test(css), "缺少减少动态效果规则");
report(/\[data-theme="dark"\]/.test(css), "缺少深色主题令牌");
report(/--scene-tilt-x/.test(css), "缺少产品界面横向倾斜变量");
report(/--spotlight-x/.test(css), "缺少产品界面动态光效变量");
report(
  /\.floating-card[\s\S]*rotateX\(var\(--scene-tilt-x\)\)/.test(css),
  "浮动标签必须跟随产品界面倾斜",
);
report(/requestAnimationFrame/.test(appJs), "产品界面倾斜交互必须按帧更新");

for (const breakpoint of ["1199px", "959px", "719px"]) {
  report(css.includes(`max-width: ${breakpoint}`), `缺少 ${breakpoint} 响应式断点`);
}

const requiredCopy = [
  "桌面助手",
  "AI 编程工具台",
  "Windows、macOS、Linux",
  "统信 UOS",
  "银河麒麟",
  "海光 · 兆芯（x64）",
  "鲲鹏 · 飞腾（ARM64）",
  "独创的统一 Agent Runtime",
  "直连模型、OpenCode、Continue",
  "DeepSeek Harness",
  "魔法笔记",
  "智能心跳",
  "文件、截图、应用窗口、剪贴板和离线语音",
  "微信、企业微信和钉钉",
];

for (const copy of requiredCopy) {
  report(html.includes(copy), `缺少准确文案：${copy}`);
}

const htmlWithoutSvg = html.replace(/<svg\b[\s\S]*?<\/svg>/g, "");
report(
  !/\bv?\d+\.\d+\.\d+\b/.test(htmlWithoutSvg),
  "官网正文不得写入需要随发布更新的具体版本号",
);

const releaseLinks = [
  ...html.matchAll(/<a\b(?=[^>]*data-release-link)[^>]*>/g),
].map((match) => match[0]);
report(releaseLinks.length >= 3, "缺少三个桌面系统的官方下载入口");
for (const link of releaseLinks) {
  report(
    /href="https:\/\/github\.com\/mesalogo\/goodbuddy\/releases\/latest"/.test(link),
    `下载入口必须指向官方最新 Release：${link}`,
  );
  report(/target="_blank"/.test(link), `下载入口必须在新窗口打开：${link}`);
  report(/rel="[^"]*noreferrer[^"]*"/.test(link), `下载入口缺少 noreferrer：${link}`);
}
report(
  (html.match(/data-download-card="(?:windows|macos|linux)"/g) ?? []).length === 3,
  "下载区必须包含 Windows、macOS 和 Linux 选择器",
);
report(
  (html.match(/data-download-arch/g) ?? []).length === 3,
  "每个平台必须提供处理器架构选择器",
);
report(
  (html.match(/data-download-format/g) ?? []).length === 3,
  "每个平台必须提供安装包类型选择器",
);
report(/data-release-status/.test(html), "下载区缺少发布源状态");
report(
  appJs.includes(
    "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/latest.json",
  ),
  "官网必须从 GoodBuddy OSS 加载最新发布索引",
);
report(
  appJs.includes("https://github.com/mesalogo/goodbuddy/releases/latest"),
  "官网必须保留 GitHub Release 回退地址",
);
report(/credentials:\s*"omit"/.test(appJs), "OSS 发布索引请求不得携带凭据");
report(/isTrustedReleaseUrl/.test(appJs), "OSS 下载链接缺少来源校验");

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
report(duplicateIds.length === 0, `存在重复 id：${[...new Set(duplicateIds)].join(", ")}`);

const attributes = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
const fragmentLinks = attributes.filter((value) => value.startsWith("#") && value.length > 1);

for (const fragment of fragmentLinks) {
  report(ids.includes(fragment.slice(1)), `页内链接目标不存在：${fragment}`);
}

const localAssets = attributes.filter(
  (value) =>
    !value.startsWith("#") &&
    !value.startsWith("https://") &&
    !value.startsWith("http://") &&
    !value.startsWith("mailto:") &&
    !value.startsWith("data:"),
);

for (const asset of localAssets) {
  const cleanAsset = asset.split(/[?#]/, 1)[0].replace(/^\.\//, "");
  try {
    const assetStats = await stat(path.join(siteRoot, cleanAsset));
    report(assetStats.isFile(), `本地资源不是文件：${asset}`);
  } catch {
    errors.push(`本地资源不存在：${asset}`);
  }
}

const externalBlankLinks = [
  ...html.matchAll(/<a\b(?=[^>]*target="_blank")[^>]*>/g),
].map((match) => match[0]);

for (const link of externalBlankLinks) {
  report(/rel="[^"]*noreferrer[^"]*"/.test(link), `新窗口链接缺少 noreferrer：${link}`);
}

report(
  !/<a\b[^>]*href="[^"]+\.(?:exe|dmg|zip|AppImage|deb)(?:[?#][^"]*)?"/i.test(html),
  "具体安装资产链接应由 OSS 发布索引动态提供",
);
report(
  !/(?:react|vue|angular|bootstrap|tailwind)(?:\.min)?\.(?:js|css)/i.test(html),
  "静态官网不得引入额外框架资源",
);

if (errors.length > 0) {
  console.error(`官网静态检查失败（${errors.length} 项）：`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `官网静态检查通过：${requiredFiles.length} 个必需文件，${ids.length} 个唯一 id，${localAssets.length} 个本地资源引用。`,
  );
}
