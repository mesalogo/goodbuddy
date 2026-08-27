import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const source = await readFile(path.resolve("sites/app.js"), "utf8");

const createMediaQueries = (window, legacy) => {
  const queries = new Map();
  window.matchMedia = (media) => {
    if (!queries.has(media)) {
      const listeners = new Set();
      const query = {
        media,
        matches: media === "(max-width: 719px)",
        addEventListener: legacy
          ? undefined
          : (_type, listener) => listeners.add(listener),
        addListener: legacy
          ? (listener) => listeners.add(listener)
          : undefined,
        dispatch(matches) {
          query.matches = matches;
          for (const listener of listeners) {
            listener(query);
          }
        },
      };
      queries.set(media, query);
    }
    return queries.get(media);
  };
  return queries;
};

const renderApp = (legacy = false) => {
  const dom = new JSDOM(
    `<!doctype html>
      <html lang="en">
        <head><meta name="theme-color" content="#f6f8fb"></head>
        <body>
          <a id="skip" href="#main">Skip</a>
          <header data-site-header>
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded="false"
              data-menu-toggle
            >Menu</button>
            <nav data-navigation>
              <a id="first-nav-link" href="#download">Download</a>
              <a href="#features">Features</a>
            </nav>
            <button type="button" data-theme-toggle>Theme</button>
          </header>
          <div data-menu-backdrop></div>
          <main id="main">
            <section id="download"></section>
            <section id="features"></section>
          </main>
          <footer id="footer">Footer</footer>
          <span data-current-year></span>
        </body>
      </html>`,
    {
      runScripts: "outside-only",
      url: "https://example.test/en.html?lang=en",
    },
  );
  const { window } = dom;
  const inertState = new WeakMap();
  Object.defineProperty(window.HTMLElement.prototype, "inert", {
    configurable: true,
    get() {
      return inertState.get(this) ?? false;
    },
    set(value) {
      inertState.set(this, Boolean(value));
    },
  });
  const queries = createMediaQueries(window, legacy);
  window.eval(source);
  return { dom, queries, window };
};

const renderLoongArchPreview = (payload) => {
  const dom = new JSDOM(
    `<!doctype html>
      <html lang="zh-CN">
        <head><meta name="theme-color" content="#f6f8fb"></head>
        <body>
          <header data-site-header>
            <button type="button" data-menu-toggle>菜单</button>
            <nav data-navigation></nav>
            <button type="button" data-theme-toggle>主题</button>
          </header>
          <div data-menu-backdrop></div>
          <main>
            <article class="download-card">
              <div data-download-card="linux">
                <select data-download-arch>
                  <option value="x64">x64</option>
                  <option value="arm64">ARM64</option>
                  <option value="loong64">龙芯 LoongArch（实验预览）</option>
                </select>
                <select data-download-format>
                  <option value="AppImage">AppImage</option>
                  <option value="deb">DEB</option>
                  <option value="rpm">RPM</option>
                </select>
              </div>
              <a
                class="button button--download"
                href="https://github.com/mesalogo/goodbuddy/releases/latest"
                target="_blank"
                rel="noreferrer"
                data-release-link
              >下载 Linux 版<span class="sr-only">（在新窗口打开）</span></a>
              <p data-download-meta></p>
            </article>
          </main>
          <span data-current-year></span>
        </body>
      </html>`,
    {
      runScripts: "outside-only",
      url: "https://example.test/",
    },
  );
  const { window } = dom;
  createMediaQueries(window, false);
  window.TextDecoder = TextDecoder;
  window.GoodBuddyReleaseIndex = {
    maximumIndexBytes: 512 * 1024,
    maximumPreviewIndexBytes: 16 * 1024,
    validateReleaseIndex() {
      throw new Error("正式发布索引在此测试中不可用");
    },
    validateLoongArchPreviewIndex(value) {
      return value;
    },
  };
  window.fetch = async (url) => {
    if (!String(url).includes("/loongarch-preview/")) {
      throw new Error("正式发布索引在此测试中不可用");
    }
    if (!payload) {
      throw new Error("龙芯预览索引不可用");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let delivered = false;
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === "content-length" ? String(bytes.length) : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (delivered) {
                return { done: true, value: undefined };
              }
              delivered = true;
              return { done: false, value: bytes };
            },
          };
        },
      },
    };
  };
  window.eval(source);
  return { dom, window };
};

for (const legacy of [false, true]) {
  test(
    `mobile menu isolates content and restores focus with ${
      legacy ? "legacy" : "modern"
    } media listeners`,
    async () => {
      const { dom, queries, window } = renderApp(legacy);
      const header = window.document.querySelector("[data-site-header]");
      const toggle = window.document.querySelector("[data-menu-toggle]");
      const firstLink = window.document.querySelector("#first-nav-link");
      const main = window.document.querySelector("main");
      const footer = window.document.querySelector("footer");
      const skip = window.document.querySelector("#skip");
      const backdrop = window.document.querySelector("[data-menu-backdrop]");

      main.inert = true;
      toggle.click();
      assert.equal(header.classList.contains("is-menu-open"), true);
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      assert.equal(window.document.activeElement, firstLink);
      assert.equal(skip.inert, true);
      assert.equal(main.inert, true);
      assert.equal(footer.inert, true);
      assert.equal(backdrop.inert, false);
      assert.equal(backdrop.classList.contains("is-active"), true);

      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      assert.equal(header.classList.contains("is-menu-open"), false);
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(window.document.activeElement, toggle);
      assert.equal(skip.inert, false);
      assert.equal(main.inert, true);
      assert.equal(footer.inert, false);
      assert.equal(backdrop.classList.contains("is-active"), false);

      toggle.click();
      backdrop.click();
      assert.equal(header.classList.contains("is-menu-open"), false);
      assert.equal(window.document.activeElement, toggle);

      toggle.click();
      footer.click();
      assert.equal(header.classList.contains("is-menu-open"), false);
      assert.equal(window.document.activeElement, toggle);

      toggle.click();
      firstLink.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      assert.equal(header.classList.contains("is-menu-open"), false);
      assert.equal(window.document.activeElement, toggle);

      toggle.click();
      queries.get("(max-width: 719px)").dispatch(false);
      assert.equal(header.classList.contains("is-menu-open"), false);
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(footer.inert, false);

      dom.window.close();
    },
  );
}

test("enables only a validated LoongArch preview download", async () => {
  const artifactUrl =
    "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/v0.11.5/GoodBuddy-0.11.5-linux-loong64-preview.deb";
  const { dom, window } = renderLoongArchPreview({
    goodBuddyVersion: "0.11.5",
    artifact: {
      size: 186_853_872,
      sha256: "a".repeat(64),
      url: artifactUrl,
    },
  });
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  const arch = window.document.querySelector("[data-download-arch]");
  const format = window.document.querySelector(
    "[data-download-format]",
  );
  const link = window.document.querySelector("[data-release-link]");
  const meta = window.document.querySelector("[data-download-meta]");
  arch.value = "loong64";
  arch.dispatchEvent(new window.Event("change"));

  assert.equal(format.value, "deb");
  assert.equal(format.disabled, true);
  assert.equal(format.options[0].hidden, true);
  assert.equal(format.options[1].hidden, false);
  assert.equal(format.options[2].hidden, true);
  assert.equal(link.getAttribute("href"), artifactUrl);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noreferrer");
  assert.equal(link.hasAttribute("aria-disabled"), false);
  assert.equal(link.classList.contains("is-disabled"), false);
  assert.equal(
    meta.textContent,
    "GoodBuddy 0.11.5 · 178 MB · 实验预览 · SHA-256 aaaaaaaaaaaa…",
  );
  dom.window.close();
});

test("keeps Chinese downloads disabled while the OSS indexes are loading", async () => {
  const { dom, window } = renderLoongArchPreview({
    goodBuddyVersion: "0.11.5",
    artifact: {
      size: 186_853_872,
      sha256: "a".repeat(64),
      url: "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/v0.11.5/GoodBuddy-0.11.5-linux-loong64-preview.deb",
    },
  });
  const arch = window.document.querySelector("[data-download-arch]");
  const link = window.document.querySelector("[data-release-link]");
  const meta = window.document.querySelector("[data-download-meta]");

  assert.equal(link.hasAttribute("href"), false);
  assert.equal(link.getAttribute("aria-disabled"), "true");
  assert.equal(link.tabIndex, -1);
  assert.equal(link.classList.contains("is-disabled"), true);
  assert.equal(link.textContent, "正在获取 Linux 下载信息…（在新窗口打开）");
  assert.equal(meta.textContent, "正在从 OSS 获取最新版本。");

  arch.value = "loong64";
  arch.dispatchEvent(new window.Event("change"));
  assert.equal(link.hasAttribute("href"), false);
  assert.equal(link.getAttribute("aria-disabled"), "true");
  assert.equal(link.textContent, "正在获取龙芯预览版下载信息…（在新窗口打开）");
  assert.equal(meta.textContent, "正在从 OSS 获取最新版本。");
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  dom.window.close();
});

test("keeps the LoongArch preview disabled when its index is unavailable", async () => {
  const { dom, window } = renderLoongArchPreview(null);
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  const arch = window.document.querySelector("[data-download-arch]");
  const format = window.document.querySelector(
    "[data-download-format]",
  );
  const link = window.document.querySelector("[data-release-link]");
  const meta = window.document.querySelector("[data-download-meta]");
  arch.value = "loong64";
  arch.dispatchEvent(new window.Event("change"));

  assert.equal(format.value, "deb");
  assert.equal(format.disabled, true);
  assert.equal(link.hasAttribute("href"), false);
  assert.equal(link.getAttribute("aria-disabled"), "true");
  assert.equal(link.tabIndex, -1);
  assert.equal(link.classList.contains("is-disabled"), true);
  assert.equal(
    meta.textContent,
    "实验预览 · 仅 DEB · 索引尚未发布或校验失败。",
  );

  arch.value = "x64";
  arch.dispatchEvent(new window.Event("change"));
  assert.equal(format.disabled, false);
  assert.equal(format.options[0].hidden, false);
  assert.equal(link.getAttribute("href"), "https://github.com/mesalogo/goodbuddy/releases/latest");
  assert.equal(link.hasAttribute("aria-disabled"), false);
  dom.window.close();
});
