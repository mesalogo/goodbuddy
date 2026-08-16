(() => {
  "use strict";

  const root = document.documentElement;
  const header = document.querySelector("[data-site-header]");
  const menuToggle = document.querySelector("[data-menu-toggle]");
  const navigation = document.querySelector("[data-navigation]");
  const themeToggle = document.querySelector("[data-theme-toggle]");
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const tiltStage = document.querySelector("[data-tilt-stage]");
  const tiltCard = tiltStage?.querySelector("[data-tilt-card]");
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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

  applyTheme(getSavedTheme() ?? (systemTheme.matches ? "dark" : "light"));
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

  if (tiltStage instanceof HTMLElement && tiltCard instanceof HTMLElement) {
    let tiltFrame = 0;

    const resetTilt = () => {
      window.cancelAnimationFrame(tiltFrame);
      tiltStage.classList.remove("is-tilting");
      tiltStage.style.setProperty("--spotlight-x", "50%");
      tiltStage.style.setProperty("--spotlight-y", "50%");
      tiltCard.style.setProperty("--spotlight-x", "50%");
      tiltCard.style.setProperty("--spotlight-y", "50%");
      tiltStage.style.setProperty("--scene-tilt-x", "0deg");
      tiltStage.style.setProperty("--scene-tilt-y", "0deg");
    };

    const updateTilt = (event) => {
      if (!finePointer.matches || reducedMotion.matches) {
        resetTilt();
        return;
      }

      const bounds = tiltStage.getBoundingClientRect();
      const x = Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1);
      const y = Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1);

      window.cancelAnimationFrame(tiltFrame);
      tiltFrame = window.requestAnimationFrame(() => {
        const spotlightX = `${(x * 100).toFixed(1)}%`;
        const spotlightY = `${(y * 100).toFixed(1)}%`;
        tiltStage.classList.add("is-tilting");
        tiltStage.style.setProperty("--spotlight-x", spotlightX);
        tiltStage.style.setProperty("--spotlight-y", spotlightY);
        tiltCard.style.setProperty("--spotlight-x", spotlightX);
        tiltCard.style.setProperty("--spotlight-y", spotlightY);
        tiltStage.style.setProperty("--scene-tilt-x", `${((0.5 - y) * 8).toFixed(2)}deg`);
        tiltStage.style.setProperty("--scene-tilt-y", `${((x - 0.5) * 11).toFixed(2)}deg`);
      });
    };

    tiltStage.addEventListener("pointermove", updateTilt, { passive: true });
    tiltStage.addEventListener("pointerleave", resetTilt);
    finePointer.addEventListener("change", resetTilt);
    reducedMotion.addEventListener("change", resetTilt);
  }

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
