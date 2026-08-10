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
```

校验脚本会检查必需文件、页内链接、本地资源、关键产品文案、主题与响应式规则，以及下载入口是否始终指向官方最新 Release。

## 下载入口

官网正文不展示具体版本号，所有下载入口直接指向 GitHub 最新正式
Release：

```text
https://github.com/mesalogo/goodbuddy/releases/latest
```

新版本发布后 GitHub 会自动更新该地址的目标，官网无需同步修改版本号
或安装资产名称。用户在 Release 页面按系统与架构选择文件并核对
SHA-256 清单。

## 文件

- `index.html`：页面结构与简体中文内容
- `styles.css`：语义令牌、浅深主题、焦点与响应式布局
- `app.js`：主题、移动导航和当前章节
- `assets/favicon.svg`：站点图标
- `scripts/validate.mjs`：无依赖静态检查
