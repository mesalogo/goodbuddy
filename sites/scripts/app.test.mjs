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
