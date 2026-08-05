import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "site.config.js",
  "assets/favicon.svg",
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

const [html, css, appJs, configJs] = await Promise.all([
  readSiteFile("index.html"),
  readSiteFile("styles.css"),
  readSiteFile("app.js"),
  readSiteFile("site.config.js"),
]);

for (const [relativePath, content] of [
  ["index.html", html],
  ["styles.css", css],
  ["app.js", appJs],
  ["site.config.js", configJs],
]) {
  report(!/[ \t]+$/m.test(content), `${relativePath} 包含行尾空白`);
  report(!content.includes("\t"), `${relativePath} 包含 Tab 缩进`);
}

report(/<html\s+lang="zh-CN">/.test(html), "页面语言必须是 zh-CN");
report(/<meta\s+name="viewport"/.test(html), "缺少 viewport 元信息");
report((html.match(/<h1[\s>]/g) ?? []).length === 1, "页面必须且只能包含一个 h1");
report(/class="skip-link"\s+href="#main-content"/.test(html), "缺少跳到主要内容链接");
report(/<main\s+id="main-content">/.test(html), "缺少 main-content 主区域");
report(/aria-label="主导航"/.test(html), "主导航缺少可访问名称");
report(/data-theme-toggle/.test(html), "缺少主题切换控件");
report(/prefers-reduced-motion:\s*reduce/.test(css), "缺少减少动态效果规则");
report(/\[data-theme="dark"\]/.test(css), "缺少深色主题令牌");

for (const breakpoint of ["1199px", "959px", "719px"]) {
  report(css.includes(`max-width: ${breakpoint}`), `缺少 ${breakpoint} 响应式断点`);
}

const requiredCopy = [
  "Subagent 与智能路由",
  "钉钉与企业微信以开发者预览提供",
  "个人微信处于实验性边界",
  "单次最多添加 8 个附件，支持同时传入 5 张图片",
  "auto、low、medium、high",
  "当前按单张结果呈现，不承诺批量多图生成",
  "发布后开放",
  "安全不是开关",
];

for (const copy of requiredCopy) {
  report(html.includes(copy), `缺少准确文案：${copy}`);
}

report(
  /version:\s*"0\.8\.0"/.test(configJs),
  "site.config.js 必须集中配置 0.8.0 版本",
);
report(
  /releasePublished:\s*false/.test(configJs),
  "Release 未发布前 releasePublished 必须为 false",
);
report(
  /releaseUrl:\s*"https:\/\/github\.com\/mesalogo\/goodbuddy\/releases\/tag\/v0\.8\.0"/.test(
    configJs,
  ),
  "未来 v0.8.0 Release URL 配置不正确",
);
report(
  appJs.includes("config?.releasePublished === true"),
  "下载链接必须受 releasePublished 配置保护",
);

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
  "Release 未发布前不得提供具体安装资产链接",
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
