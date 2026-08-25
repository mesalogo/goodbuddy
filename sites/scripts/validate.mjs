import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const requiredFiles = [
  "index.html",
  "en.html",
  "styles.css",
  "app.js",
  "language.js",
  "release-index.js",
  "assets/goodbuddy-light.png",
  "assets/goodbuddy-dark.png",
  "assets/linux-plain.svg",
  "assets/devicon-LICENSE",
  "assets/fonts/inter-latin-variable.woff2",
  "assets/fonts/inter-OFL.txt",
  "scripts/app.test.mjs",
  "scripts/release-index.test.mjs",
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

const [html, englishHtml, css, appJs, languageJs, releaseIndexJs, fontLicense] =
  await Promise.all([
    readSiteFile("index.html"),
    readSiteFile("en.html"),
    readSiteFile("styles.css"),
    readSiteFile("app.js"),
    readSiteFile("language.js"),
    readSiteFile("release-index.js"),
    readSiteFile("assets/fonts/inter-OFL.txt"),
  ]);

for (const [relativePath, content] of [
  ["index.html", html],
  ["en.html", englishHtml],
  ["styles.css", css],
  ["app.js", appJs],
  ["language.js", languageJs],
  ["release-index.js", releaseIndexJs],
]) {
  report(!/[ \t]+$/m.test(content), `${relativePath} 包含行尾空白`);
  report(!content.includes("\t"), `${relativePath} 包含 Tab 缩进`);
}

report(/<html\s+lang="zh-CN">/.test(html), "页面语言必须是 zh-CN");
report(/<html\s+lang="en">/.test(englishHtml), "英文页面语言必须是 en");
report(/<meta\s+name="viewport"/.test(html), "缺少 viewport 元信息");
report(/<meta\s+name="viewport"/.test(englishHtml), "英文页面缺少 viewport 元信息");
report(
  /<link\s+rel="canonical"\s+href="https:\/\/mesalogo\.github\.io\/goodbuddy\/"\s*\/>/.test(
    html,
  ),
  "canonical 地址必须指向 GitHub Pages 正式站点",
);
report(
  /<link\s+rel="canonical"\s+href="https:\/\/mesalogo\.github\.io\/goodbuddy\/en\.html"\s*\/>/.test(
    englishHtml,
  ),
  "英文 canonical 地址必须指向 GitHub Pages 英文站点",
);
for (const [relativePath, content] of [
  ["index.html", html],
  ["en.html", englishHtml],
]) {
  report(
    /hreflang="zh-CN"\s+href="https:\/\/mesalogo\.github\.io\/goodbuddy\/"/.test(content),
    `${relativePath} 缺少中文 alternate 链接`,
  );
  report(
    /hreflang="en"\s+href="https:\/\/mesalogo\.github\.io\/goodbuddy\/en\.html"/.test(
      content,
    ),
    `${relativePath} 缺少英文 alternate 链接`,
  );
  report(
    /<script\s+src="\.\/language\.js"><\/script>/.test(content),
    `${relativePath} 缺少语言选择脚本`,
  );
}
report((html.match(/<h1[\s>]/g) ?? []).length === 1, "页面必须且只能包含一个 h1");
report(
  (englishHtml.match(/<h1[\s>]/g) ?? []).length === 1,
  "英文页面必须且只能包含一个 h1",
);
report(/class="skip-link"\s+href="#main-content"/.test(html), "缺少跳到主要内容链接");
report(
  /class="skip-link"\s+href="#main-content"/.test(englishHtml),
  "英文页面缺少跳到主要内容链接",
);
report(/<main\s+id="main-content">/.test(html), "缺少 main-content 主区域");
report(/<main\s+id="main-content">/.test(englishHtml), "英文页面缺少 main-content 主区域");
report(/aria-label="主导航"/.test(html), "主导航缺少可访问名称");
report(/aria-label="Main navigation"/.test(englishHtml), "英文主导航缺少可访问名称");
report(/data-theme-toggle/.test(html), "缺少主题切换控件");
report(/data-theme-toggle/.test(englishHtml), "英文页面缺少主题切换控件");
report(
  /href="\.\/en\.html\?lang=en"/.test(html),
  "中文页面缺少英文语言切换入口",
);
report(
  /href="\.\/index\.html\?lang=zh"/.test(englishHtml),
  "英文页面缺少中文语言切换入口",
);
report(
  /data-language-link/.test(html) && /data-language-link/.test(englishHtml),
  "中英文语言切换入口必须标记为保留片段的手动切换",
);
report(
  (html.match(/src="\.\/assets\/goodbuddy-light\.png"/g) ?? []).length >= 5,
  "品牌位置必须使用官方亮色图标",
);
report(
  (html.match(/src="\.\/assets\/goodbuddy-dark\.png"/g) ?? []).length >= 5,
  "品牌位置必须使用官方深色图标",
);
report(
  (englishHtml.match(/src="\.\/assets\/goodbuddy-light\.png"/g) ?? []).length >= 5,
  "英文品牌位置必须使用官方亮色图标",
);
report(
  (englishHtml.match(/src="\.\/assets\/goodbuddy-dark\.png"/g) ?? []).length >= 5,
  "英文品牌位置必须使用官方深色图标",
);
report(!/class="brand-mark"/.test(html), "官网不得使用自绘品牌标志");
report(!/class="brand-mark"/.test(englishHtml), "英文官网不得使用自绘品牌标志");
report(/data-tilt-stage/.test(html), "首屏产品界面缺少倾斜交互区域");
report(/data-tilt-stage/.test(englishHtml), "英文首屏产品界面缺少倾斜交互区域");
report(/data-tilt-card/.test(html), "首屏产品界面缺少倾斜卡片");
report(/data-tilt-card/.test(englishHtml), "英文首屏产品界面缺少倾斜卡片");
report(/prefers-reduced-motion:\s*reduce/.test(css), "缺少减少动态效果规则");
report(/\[data-theme="dark"\]/.test(css), "缺少深色主题令牌");
report(/--scene-tilt-x/.test(css), "缺少产品界面横向倾斜变量");
report(/--spotlight-x/.test(css), "缺少产品界面动态光效变量");
report(
  /\.floating-card[\s\S]*rotateX\(var\(--scene-tilt-x\)\)/.test(css),
  "浮动标签必须跟随产品界面倾斜",
);
report(/requestAnimationFrame/.test(appJs), "产品界面倾斜交互必须按帧更新");
report(
  /@font-face[\s\S]*font-family:\s*"Inter Variable"[\s\S]*inter-latin-variable\.woff2/.test(
    css,
  ),
  "官网必须使用本地 Inter Variable Latin 字体",
);
report(
  !/@import\s+url|fonts\.(?:googleapis|gstatic)\.com|https?:\/\/[^)"']+\.(?:woff2?|ttf)/iu.test(
    css,
  ),
  "官网字体不得通过远程请求加载",
);
report(
  /SIL OPEN FONT LICENSE Version 1\.1/.test(fontLicense),
  "Inter 字体必须附带 OFL 1.1 许可证",
);
const fontStats = await stat(
  path.join(siteRoot, "assets/fonts/inter-latin-variable.woff2"),
).catch(() => null);
report(
  fontStats?.isFile() && fontStats.size >= 20_000 && fontStats.size <= 100_000,
  "Inter Latin 字体文件大小应保持在 20 KB 到 100 KB",
);

const hexToLuminance = (hex) => {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrastRatio = (foreground, background) => {
  const foregroundLuminance = hexToLuminance(foreground);
  const backgroundLuminance = hexToLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
};

const lightThemeBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const getLightToken = (name) =>
  lightThemeBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
const mutedColor = getLightToken("text-muted");
const controlBorder = getLightToken("border-control");
const raisedSurface = getLightToken("surface-raised");
const subtleSurface = getLightToken("surface-subtle");
const canvasSurface = getLightToken("surface-canvas");
for (const [label, foreground, background, minimum] of [
  ["浅色弱文本/画布", mutedColor, canvasSurface, 4.5],
  ["浅色弱文本/卡片", mutedColor, raisedSurface, 4.5],
  ["浅色弱文本/次级表面", mutedColor, subtleSurface, 4.5],
  ["浅色控件边框/卡片", controlBorder, raisedSurface, 3],
  ["浅色控件边框/次级表面", controlBorder, subtleSurface, 3],
]) {
  report(
    foreground &&
      background &&
      contrastRatio(foreground, background) >= minimum,
    `${label} 对比度必须至少达到 ${minimum}:1`,
  );
}
for (const selector of ["language-link", "icon-button", "button--quiet"]) {
  report(
    new RegExp(
      `\\.${selector}\\s*\\{[^}]*border(?:-color)?:\\s*(?:1px solid )?var\\(--border-control\\)`,
    ).test(css),
    `${selector} 必须使用达到 3:1 的控件边框`,
  );
}
report(/@media\s*\(forced-colors:\s*active\)/.test(css), "缺少强制颜色模式适配");

for (const breakpoint of ["1199px", "959px", "719px"]) {
  report(css.includes(`max-width: ${breakpoint}`), `缺少 ${breakpoint} 响应式断点`);
}

const requiredCopy = [
  "免注册",
  "支持信创软硬件的一站式 AI 助手",
  "首个支持龙芯的开源桌面 AI 助理产品",
  "龙芯 LoongArch 独立编译预览版",
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

const requiredEnglishCopy = [
  "No account required.",
  "Your all-in-one",
  "AI assistant.",
  "Windows, macOS, and Linux",
  "Unified Agent Runtime",
  "Direct models",
  "OpenCode",
  "Continue",
  "DeepSeek Harness",
  "Download from GitHub",
];

for (const copy of requiredEnglishCopy) {
  report(englishHtml.includes(copy), `英文页面缺少准确文案：${copy}`);
}

for (const forbiddenCopy of ["信创", "国产", "统信 UOS", "银河麒麟", "海光", "兆芯", "鲲鹏", "飞腾"]) {
  report(!englishHtml.includes(forbiddenCopy), `英文页面不得包含中文信创文案：${forbiddenCopy}`);
}

for (const [relativePath, content] of [
  ["index.html", html],
  ["en.html", englishHtml],
]) {
  const contentWithoutSvg = content.replace(/<svg\b[\s\S]*?<\/svg>/g, "");
  report(
    !/\bv?\d+\.\d+\.\d+\b/.test(contentWithoutSvg),
    `${relativePath} 正文不得写入需要随发布更新的具体版本号`,
  );
}

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
report(
  !/data-release-status|download-release-status/.test(`${html}\n${englishHtml}\n${css}\n${appJs}`),
  "官网不得显示下载源状态提示",
);
const englishReleaseLinks = [
  ...englishHtml.matchAll(
    /<a\b(?=[^>]*href="https:\/\/github\.com\/mesalogo\/goodbuddy\/releases\/latest")[^>]*>/g,
  ),
].map((match) => match[0]);
report(englishReleaseLinks.length === 3, "英文页面必须包含三个 GitHub Release 下载入口");
for (const link of englishReleaseLinks) {
  report(/target="_blank"/.test(link), `英文下载入口必须在新窗口打开：${link}`);
  report(/rel="[^"]*noreferrer[^"]*"/.test(link), `英文下载入口缺少 noreferrer：${link}`);
}
report(
  !/data-download-card|data-download-meta|data-release-link/.test(englishHtml),
  "英文下载入口必须保持为直接 GitHub Release 链接",
);
report(
  /<script\s+src="\.\/release-index\.js"><\/script>\s*<script\s+src="\.\/app\.js"><\/script>/.test(
    html,
  ),
  "中文页面必须在交互脚本前加载发布索引校验器",
);
report(
  !/release-index\.js/.test(englishHtml),
  "英文页面不得加载动态发布索引校验器",
);
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
report(/redirect:\s*"error"/.test(appJs), "OSS 发布索引请求不得跟随重定向");
report(/referrerPolicy:\s*"no-referrer"/.test(appJs), "OSS 发布索引请求必须禁用来源信息");
report(/maximumIndexBytes/.test(appJs), "OSS 发布索引响应缺少大小上限");
report(/response\.body\.getReader\(\)/.test(appJs), "OSS 发布索引响应必须在读取时限制大小");
report(/AbortController/.test(appJs), "OSS 发布索引请求必须设置超时取消");
report(
  /validateReleaseIndex\(payload\)/.test(appJs),
  "动态下载链接必须先通过完整发布索引校验",
);
report(
  /const setFallbackDownloads[\s\S]*catch\s*\{[\s\S]*setFallbackDownloads\(\)/.test(
    appJs,
  ),
  "发布索引任一错误必须让全部下载入口回退 GitHub",
);
report(
  /replaceChildren\(document\.createTextNode\(visibleText\)\)[\s\S]*append\(newWindowNotice\)/.test(
    appJs,
  ),
  "动态更新下载链接时必须保留新窗口的屏幕阅读器提示",
);
report(/if\s*\(!isEnglish\)\s*\{\s*void loadRelease\(\)/.test(appJs), "英文页面不得请求 OSS 发布索引");
for (const listenerRule of [
  'typeof query.addEventListener === "function"',
  'typeof query.addListener === "function"',
  "listenMediaQuery(systemTheme",
  "listenMediaQuery(finePointer",
  "listenMediaQuery(reducedMotion",
  "listenMediaQuery(mobileMenu",
]) {
  report(appJs.includes(listenerRule), `媒体查询监听缺少兼容规则：${listenerRule}`);
}
for (const menuRule of [
  "isolatedMenuContent = new Map()",
  "element === menuBackdrop",
  "element.inert = true",
  "element.inert = wasInert",
  'navigation?.querySelector("a")?.focus()',
  "closeMenu({ restoreFocus: false })",
  'menuBackdrop?.addEventListener("click", () => closeMenu())',
]) {
  report(appJs.includes(menuRule), `移动导航隔离或焦点管理缺少规则：${menuRule}`);
}
report(
  /const semVerPattern[\s\S]*const sha256Pattern[\s\S]*const targetDefinitions/.test(
    releaseIndexJs,
  ),
  "发布索引校验器缺少 SemVer、SHA-256 或目标定义",
);
for (const rule of [
  "windows-x64",
  "windows-arm64",
  "macos-x64",
  "macos-arm64",
  "linux-x64",
  "linux-arm64",
  "SHA256SUMS",
  "encodeURIComponent(file.name)",
  "!url.username",
  "!url.password",
  "!url.port",
  "!url.search",
  "!url.hash",
  "canonicalFileName",
  "GoodBuddy-${version}-windows-${arch}-setup.exe",
  "GoodBuddy-${version}-windows-${arch}-portable.zip",
  "GoodBuddy-${version}-mac-${arch}.${format}",
  '"x86_64"',
  '"amd64"',
]) {
  report(releaseIndexJs.includes(rule), `发布索引校验器缺少规则：${rule}`);
}
report(
  /navigator\.languages\?\.\[0\]/.test(languageJs),
  "语言选择必须读取浏览器首选语言",
);
report(
  /goodbuddy-site-language/.test(languageJs),
  "语言选择必须记住用户的手动切换",
);
report(
  /window\.location\.replace/.test(languageJs),
  "语言选择缺少自动页面切换",
);
report(
  /targetUrl\.hash\s*=\s*window\.location\.hash/.test(languageJs),
  "手动切换语言必须保留当前页面片段",
);

for (const [relativePath, content] of [
  ["index.html", html],
  ["en.html", englishHtml],
]) {
  const menuButton = content.match(
    /<button\b(?=[^>]*data-menu-toggle)[^>]*>/,
  )?.[0];
  const controlsId = menuButton?.match(/aria-controls="([^"]+)"/)?.[1];
  report(
    Boolean(controlsId) && content.includes(`id="${controlsId}"`),
    `${relativePath} 移动导航按钮必须关联现有导航区域`,
  );
  report(
    menuButton?.includes('aria-expanded="false"'),
    `${relativePath} 移动导航必须声明初始折叠状态`,
  );
  report(
    /<div\s+class="menu-backdrop"\s+aria-hidden="true"\s+data-menu-backdrop><\/div>/.test(
      content,
    ),
    `${relativePath} 移动导航缺少页外点击关闭层`,
  );
}
report(
  /@media\s*\(max-width:\s*719px\)[\s\S]*\.menu-toggle\s*\{[\s\S]*display:\s*inline-grid/.test(
    css,
  ) &&
    /@media\s*\(max-width:\s*719px\)[\s\S]*\.site-header\.is-menu-open \.site-navigation\s*\{[\s\S]*display:\s*flex/.test(
      css,
    ) &&
    /@media\s*\(max-width:\s*719px\)[\s\S]*\.menu-backdrop\.is-active\s*\{[\s\S]*display:\s*block/.test(
      css,
    ),
  "移动断点必须显示菜单按钮、页外关闭层并支持展开导航",
);

const expectedDownloadOptions = {
  windows: {
    arches: ["x64", "arm64"],
    formats: ["nsis", "portable"],
  },
  macos: {
    arches: ["arm64", "x64"],
    formats: ["dmg", "zip"],
  },
  linux: {
    arches: ["x64", "arm64"],
    formats: ["AppImage", "deb", "rpm"],
  },
};
for (const [platform, expected] of Object.entries(expectedDownloadOptions)) {
  const card = html.match(
    new RegExp(
      `data-download-card="${platform}"([\\s\\S]*?)<\\/article>`,
    ),
  )?.[1];
  const archOptions = [
    ...(card ?? "").matchAll(/<option\s+value="([^"]+)"/g),
  ].map((match) => match[1]);
  report(
    expected.arches.every((arch, index) => archOptions[index] === arch) &&
      expected.formats.every(
        (format, index) => archOptions[index + expected.arches.length] === format,
      ) &&
      archOptions.length === expected.arches.length + expected.formats.length,
    `${platform} 下载控件的架构或格式选项无效`,
  );
  report(
    (card?.match(/<select\b[^>]*aria-label="[^"]+"/g) ?? []).length === 2,
    `${platform} 下载选择器必须有可访问名称`,
  );
}

let totalIds = 0;
let totalLocalAssets = 0;
for (const [relativePath, content] of [
  ["index.html", html],
  ["en.html", englishHtml],
]) {
  const ids = [...content.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  totalIds += ids.length;
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  report(
    duplicateIds.length === 0,
    `${relativePath} 存在重复 id：${[...new Set(duplicateIds)].join(", ")}`,
  );

  const attributes = [...content.matchAll(/\s(?:href|src)="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const fragmentLinks = attributes.filter(
    (value) => value.startsWith("#") && value.length > 1,
  );
  for (const fragment of fragmentLinks) {
    report(ids.includes(fragment.slice(1)), `${relativePath} 页内链接目标不存在：${fragment}`);
  }

  const localAssets = attributes.filter(
    (value) =>
      !value.startsWith("#") &&
      !value.startsWith("https://") &&
      !value.startsWith("http://") &&
      !value.startsWith("mailto:") &&
      !value.startsWith("data:"),
  );
  totalLocalAssets += localAssets.length;
  for (const asset of localAssets) {
    const cleanAsset = asset.split(/[?#]/, 1)[0].replace(/^\.\//, "");
    try {
      const assetStats = await stat(path.join(siteRoot, cleanAsset));
      report(assetStats.isFile(), `${relativePath} 本地资源不是文件：${asset}`);
    } catch {
      errors.push(`${relativePath} 本地资源不存在：${asset}`);
    }
  }

  const externalBlankLinks = [
    ...content.matchAll(/<a\b(?=[^>]*target="_blank")[^>]*>/g),
  ].map((match) => match[0]);
  for (const link of externalBlankLinks) {
    report(
      /rel="[^"]*noreferrer[^"]*"/.test(link),
      `${relativePath} 新窗口链接缺少 noreferrer：${link}`,
    );
  }
}

const cssAssets = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(
  (match) => match[1],
);
for (const asset of cssAssets) {
  if (/^(?:data:|https?:)/u.test(asset)) {
    continue;
  }
  const cleanAsset = asset.split(/[?#]/, 1)[0].replace(/^\.\//, "");
  try {
    const assetStats = await stat(path.join(siteRoot, cleanAsset));
    report(assetStats.isFile(), `CSS 本地资源不是文件：${asset}`);
  } catch {
    errors.push(`CSS 本地资源不存在：${asset}`);
  }
}

report(
  !/<a\b[^>]*href="[^"]+\.(?:exe|dmg|zip|AppImage|deb|rpm)(?:[?#][^"]*)?"/i.test(
    `${html}\n${englishHtml}`,
  ),
  "具体安装资产链接应由 OSS 发布索引动态提供",
);
report(
  !/(?:react|vue|angular|bootstrap|tailwind)(?:\.min)?\.(?:js|css)/i.test(
    `${html}\n${englishHtml}`,
  ),
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
    `官网静态检查通过：${requiredFiles.length} 个必需文件，${totalIds} 个唯一 id，${totalLocalAssets} 个本地资源引用。`,
  );
}
