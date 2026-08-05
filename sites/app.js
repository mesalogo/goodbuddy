(() => {
  "use strict";

  const root = document.documentElement;
  const header = document.querySelector("[data-site-header]");
  const menuToggle = document.querySelector("[data-menu-toggle]");
  const navigation = document.querySelector("[data-navigation]");
  const themeToggle = document.querySelector("[data-theme-toggle]");
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const config = window.GOODBUDDY_SITE_CONFIG;

  const getSavedTheme = () => {
    try {
      const savedTheme = localStorage.getItem("goodbuddy-site-theme");
      return savedTheme === "light" || savedTheme === "dark" ? savedTheme : null;
    } catch {
      return null;
    }
  };

  const applyTheme = (theme, persist = false) => {
    root.dataset.theme = theme;
    themeToggle?.setAttribute(
      "aria-label",
      theme === "dark" ? "切换为浅色主题" : "切换为深色主题",
    );
    themeColor?.setAttribute("content", theme === "dark" ? "#07101f" : "#f6f8fb");

    if (persist) {
      try {
        localStorage.setItem("goodbuddy-site-theme", theme);
      } catch {
        // The selected theme still applies for the current page.
      }
    }
  };

  const closeMenu = () => {
    header?.classList.remove("is-menu-open");
    menuToggle?.setAttribute("aria-expanded", "false");
    menuToggle?.setAttribute("aria-label", "打开导航");
  };

  const setHeaderState = () => {
    header?.classList.toggle("is-scrolled", window.scrollY > 12);
  };

  const configureReleaseLinks = () => {
    const releaseLinks = document.querySelectorAll("[data-release-link]");
    const isReady =
      config?.releasePublished === true &&
      typeof config.releaseUrl === "string" &&
      /^https:\/\/github\.com\/mesalogo\/goodbuddy\/releases\/tag\/v0\.8\.0$/.test(
        config.releaseUrl,
      );

    releaseLinks.forEach((link) => {
      if (!isReady) {
        link.removeAttribute("href");
        link.removeAttribute("target");
        link.removeAttribute("rel");
        link.setAttribute("aria-disabled", "true");
        link.classList.add("is-disabled");
        link.textContent = "发布后开放";
        return;
      }

      link.href = config.releaseUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.removeAttribute("aria-disabled");
      link.classList.remove("is-disabled");
      link.innerHTML = `前往 v${config.version} Release<span class="sr-only">（在新窗口打开）</span>`;
    });
  };

  applyTheme(getSavedTheme() ?? (systemTheme.matches ? "dark" : "light"));
  configureReleaseLinks();
  setHeaderState();

  themeToggle?.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
  });

  systemTheme.addEventListener("change", (event) => {
    if (!getSavedTheme()) {
      applyTheme(event.matches ? "dark" : "light");
    }
  });

  menuToggle?.addEventListener("click", () => {
    const willOpen = !header?.classList.contains("is-menu-open");
    header?.classList.toggle("is-menu-open", willOpen);
    menuToggle.setAttribute("aria-expanded", String(willOpen));
    menuToggle.setAttribute("aria-label", willOpen ? "关闭导航" : "打开导航");
  });

  navigation?.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header?.classList.contains("is-menu-open")) {
      closeMenu();
      menuToggle?.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      header?.classList.contains("is-menu-open") &&
      event.target instanceof Node &&
      !header.contains(event.target)
    ) {
      closeMenu();
    }
  });

  window.addEventListener("scroll", setHeaderState, { passive: true });

  const sections = [...document.querySelectorAll("main section[id]")];
  const navLinks = [...document.querySelectorAll('.site-navigation a[href^="#"]')];

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleSection = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

        if (!visibleSection) {
          return;
        }

        navLinks.forEach((link) => {
          const isCurrent = link.getAttribute("href") === `#${visibleSection.target.id}`;
          if (isCurrent) {
            link.setAttribute("aria-current", "true");
          } else {
            link.removeAttribute("aria-current");
          }
        });
      },
      { rootMargin: "-25% 0px -55%", threshold: [0.05, 0.2, 0.5] },
    );

    sections.forEach((section) => observer.observe(section));
  }

  const currentYear = document.querySelector("[data-current-year]");
  if (currentYear) {
    currentYear.textContent = String(new Date().getFullYear());
  }
})();
