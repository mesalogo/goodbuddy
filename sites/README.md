# GoodBuddy 静态官网

`sites` 是无需构建步骤或额外依赖的静态官网源码，可直接托管整个目录。

## 本地预览

在仓库根目录运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory sites
```

然后访问 <http://localhost:4173/>。也可以直接用浏览器打开 `sites/index.html`。

## 校验

```powershell
node sites/scripts/validate.mjs
node --check sites/app.js
node --check sites/site.config.js
```

校验脚本会检查必需文件、页内链接、本地资源、关键产品文案、主题与响应式规则，以及未发布状态下的下载链接保护。

## Release 配置

当前版本的 Release 地址集中在 `site.config.js`，版本号必须与根目录
`package.json` 保持一致：

```js
window.GOODBUDDY_SITE_CONFIG = Object.freeze({
  version: "0.8.1",
  releasePublished: true,
  releaseUrl: "https://github.com/mesalogo/goodbuddy/releases/tag/v0.8.1",
});
```

准备尚未发布的版本时，将 `releasePublished` 暂时设为 `false`；正式
Release 确认发布后改回 `true`，页面上的下载入口才会指向 Release
页面。官网不配置或猜测具体安装资产名称。

## 文件

- `index.html`：页面结构与简体中文内容
- `styles.css`：语义令牌、浅深主题、焦点与响应式布局
- `app.js`：主题、移动导航、当前章节和 Release 状态
- `site.config.js`：版本与未来 Release 地址
- `assets/favicon.svg`：站点图标
- `scripts/validate.mjs`：无依赖静态检查
