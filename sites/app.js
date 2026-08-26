(() => {
  "use strict";

  const root = document.documentElement;
  const header = document.querySelector("[data-site-header]");
  const menuToggle = document.querySelector("[data-menu-toggle]");
  const navigation = document.querySelector("[data-navigation]");
  const menuBackdrop = document.querySelector("[data-menu-backdrop]");
  const themeToggle = document.querySelector("[data-theme-toggle]");
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const tiltStage = document.querySelector("[data-tilt-stage]");
  const tiltCard = tiltStage?.querySelector("[data-tilt-card]");
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mobileMenu = window.matchMedia("(max-width: 719px)");
  const isEnglish = root.lang.toLowerCase().startsWith("en");
  const releaseManifestUrl =
    "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/latest.json";
  const loongArchPreviewManifestUrl =
    "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/latest.json";
  const releaseFallbackUrl =
    "https://github.com/mesalogo/goodbuddy/releases/latest";
  const releaseRequestTimeoutMs = 10_000;
  const releaseIndexApi = window.GoodBuddyReleaseIndex;
  const downloadCards = [
    ...document.querySelectorAll("[data-download-card]"),
  ];
  let verifiedRelease;
  let verifiedLoongArchPreview;
  const interfaceCopy = isEnglish
    ? {
        themeDark: "Switch to dark theme",
        themeLight: "Switch to light theme",
        menuOpen: "Open navigation",
        menuClose: "Close navigation",
      }
    : {
        themeDark: "切换为深色主题",
        themeLight: "切换为浅色主题",
        menuOpen: "打开导航",
        menuClose: "关闭导航",
      };
  const platformNames = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
  };
  const formatNames = {
    nsis: "安装版",
    portable: "便携版",
    dmg: "DMG",
    zip: "ZIP",
    AppImage: "AppImage",
    deb: "DEB",
    rpm: "RPM",
  };

  const formatFileSize = (bytes) => {
    const megabytes = bytes / (1024 * 1024);
    return `${megabytes >= 100 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
  };

  const listenMediaQuery = (query, listener) => {
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", listener);
    } else if (typeof query.addListener === "function") {
      query.addListener(listener);
    }
  };

  const readBoundedJson = async (response, maximumBytes) => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("发布索引大小上限无效");
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (
        !Number.isSafeInteger(parsedLength) ||
        parsedLength < 0 ||
        parsedLength > maximumBytes
      ) {
        throw new Error("发布索引响应大小无效");
      }
    }
    if (!response.body) {
      throw new Error("发布索引响应没有正文");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("发布索引响应过大");
      }
      chunks.push(result.value);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  const setLinkText = (link, visibleText) => {
    const newWindowNotice = link.querySelector(".sr-only");
    link.replaceChildren(document.createTextNode(visibleText));
    if (newWindowNotice) {
      link.append(newWindowNotice);
    }
  };

  const setReleaseLink = (link, url, visibleText) => {
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.removeAttribute("aria-disabled");
    link.removeAttribute("tabindex");
    link.classList.remove("is-disabled");
    setLinkText(link, visibleText);
  };

  const getDownloadCardControls = (card) => {
    const platform = card.dataset.downloadCard;
    const archSelect = card.querySelector("[data-download-arch]");
    const formatSelect = card.querySelector("[data-download-format]");
    const container = card.closest(".download-card");
    const link = container?.querySelector("[data-release-link]");
    const meta = container?.querySelector("[data-download-meta]");
    if (
      !platform ||
      !(archSelect instanceof HTMLSelectElement) ||
      !(formatSelect instanceof HTMLSelectElement) ||
      !(link instanceof HTMLAnchorElement) ||
      !(meta instanceof HTMLElement)
    ) {
      throw new Error("下载卡片结构无效");
    }
    return { platform, archSelect, formatSelect, link, meta };
  };

  const setDownloadUnavailable = (link, meta) => {
    link.removeAttribute("href");
    link.removeAttribute("target");
    link.removeAttribute("rel");
    link.setAttribute("aria-disabled", "true");
    link.tabIndex = -1;
    link.classList.add("is-disabled");
    setLinkText(link, "龙芯预览包暂不可用");
    meta.textContent =
      "实验预览 · 仅 DEB · 索引尚未发布或校验失败；" +
      "尚未完成真机验证。";
  };

  const setLoongArchFormat = (formatSelect, selected) => {
    for (const option of formatSelect.options) {
      const unavailable = selected && option.value !== "deb";
      option.hidden = unavailable;
      option.disabled = unavailable;
    }
    if (selected) {
      formatSelect.value = "deb";
    }
    formatSelect.disabled = selected;
  };

  const updateDownloadCard = (card) => {
    const {
      platform,
      archSelect,
      formatSelect,
      link,
      meta,
    } = getDownloadCardControls(card);
    const loongArchSelected =
      platform === "linux" && archSelect.value === "loong64";
    setLoongArchFormat(formatSelect, loongArchSelected);

    if (loongArchSelected) {
      if (!verifiedLoongArchPreview) {
        setDownloadUnavailable(link, meta);
        return;
      }
      setReleaseLink(
        link,
        verifiedLoongArchPreview.artifact.url,
        "下载 Linux 龙芯 LoongArch DEB 预览版 →",
      );
      meta.textContent =
        `GoodBuddy ${verifiedLoongArchPreview.goodBuddyVersion} · ` +
        `${formatFileSize(verifiedLoongArchPreview.artifact.size)} · ` +
        `实验预览 · 未完成龙芯真机验证 · SHA-256 ` +
        `${verifiedLoongArchPreview.artifact.sha256.slice(0, 12)}…`;
      return;
    }

    if (!verifiedRelease) {
      setReleaseLink(
        link,
        releaseFallbackUrl,
        `前往 GitHub 下载 ${platformNames[platform] ?? platform} →`,
      );
      meta.textContent = "请在 GitHub Release 中选择对应的安装文件。";
      return;
    }

    const target =
      verifiedRelease.targets[`${platform}-${archSelect.value}`];
    const file = target?.files?.[formatSelect.value];
    if (!file) {
      throw new Error("下载选项不在已校验的发布索引中");
    }
    const platformName = platformNames[platform] ?? platform;
    const archName =
      platform === "macos" && archSelect.value === "arm64"
        ? "Apple 芯片"
        : archSelect.value === "arm64"
          ? "ARM64"
          : "x64";
    const formatName = formatNames[formatSelect.value] ?? formatSelect.value;
    setReleaseLink(
      link,
      file.url,
      `下载 ${platformName} ${archName} ${formatName} →`,
    );
    meta.textContent =
      `GoodBuddy ${verifiedRelease.version} · ` +
      `${formatFileSize(file.size)} · ` +
      `${archSelect.options[archSelect.selectedIndex]?.text ?? archSelect.value}`;
  };

  const updateAllDownloadCards = () => {
    for (const card of downloadCards) {
      updateDownloadCard(card);
    }
  };

  const setFallbackDownloads = () => {
    verifiedRelease = undefined;
    updateAllDownloadCards();
  };

  const setLoongArchPreviewUnavailable = () => {
    verifiedLoongArchPreview = undefined;
    const linuxCard = downloadCards.find(
      (card) => card.dataset.downloadCard === "linux",
    );
    if (linuxCard) {
      updateDownloadCard(linuxCard);
    }
  };

  const configureLoongArchPreview = (payload) => {
    if (!releaseIndexApi?.validateLoongArchPreviewIndex) {
      throw new Error("龙芯预览索引校验器不可用");
    }
    verifiedLoongArchPreview =
      releaseIndexApi.validateLoongArchPreviewIndex(payload);
    const linuxCard = downloadCards.find(
      (card) => card.dataset.downloadCard === "linux",
    );
    if (linuxCard) {
      updateDownloadCard(linuxCard);
    }
  };

  const configureDownloads = (payload) => {
    if (!releaseIndexApi?.validateReleaseIndex) {
      throw new Error("发布索引校验器不可用");
    }
    verifiedRelease = releaseIndexApi.validateReleaseIndex(payload);
    updateAllDownloadCards();
  };

  const initializeDownloadCards = () => {
    for (const card of downloadCards) {
      for (const select of card.querySelectorAll("select")) {
        select.addEventListener("change", () => {
          try {
            updateDownloadCard(card);
          } catch {
            setFallbackDownloads();
          }
        });
      }
      updateDownloadCard(card);
    }
  };

  const fetchBoundedIndex = async (
    url,
    maximumBytes,
    errorLabel,
  ) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      releaseRequestTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${errorLabel}请求失败：${response.status}`);
      }
      return await readBoundedJson(response, maximumBytes);
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const loadRelease = async () => {
    try {
      configureDownloads(
        await fetchBoundedIndex(
          releaseManifestUrl,
          releaseIndexApi?.maximumIndexBytes,
          "发布索引",
        ),
      );
    } catch {
      setFallbackDownloads();
    }
  };

  const loadLoongArchPreview = async () => {
    try {
      configureLoongArchPreview(
        await fetchBoundedIndex(
          loongArchPreviewManifestUrl,
          releaseIndexApi?.maximumPreviewIndexBytes,
          "龙芯预览索引",
        ),
      );
    } catch {
      setLoongArchPreviewUnavailable();
    }
  };

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
      theme === "dark" ? interfaceCopy.themeLight : interfaceCopy.themeDark,
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

  let isolatedMenuContent = null;

  const isolateMenuContent = () => {
    if (isolatedMenuContent) {
      return;
    }
    isolatedMenuContent = new Map();
    for (const element of document.body.children) {
      if (
        element === header ||
        element === menuBackdrop ||
        element instanceof HTMLScriptElement
      ) {
        continue;
      }
      isolatedMenuContent.set(element, element.inert);
      element.inert = true;
    }
  };

  const restoreMenuContent = () => {
    if (!isolatedMenuContent) {
      return;
    }
    for (const [element, wasInert] of isolatedMenuContent) {
      element.inert = wasInert;
    }
    isolatedMenuContent = null;
  };

  const closeMenu = ({ restoreFocus = true } = {}) => {
    const wasOpen = header?.classList.contains("is-menu-open") ?? false;
    header?.classList.remove("is-menu-open");
    menuToggle?.setAttribute("aria-expanded", "false");
    menuToggle?.setAttribute("aria-label", interfaceCopy.menuOpen);
    menuBackdrop?.classList.remove("is-active");
    restoreMenuContent();
    if (wasOpen && restoreFocus) {
      menuToggle?.focus();
    }
  };

  const openMenu = () => {
    if (!mobileMenu.matches) {
      closeMenu({ restoreFocus: false });
      return;
    }
    header?.classList.add("is-menu-open");
    menuToggle?.setAttribute("aria-expanded", "true");
    menuToggle?.setAttribute("aria-label", interfaceCopy.menuClose);
    menuBackdrop?.classList.add("is-active");
    isolateMenuContent();
    navigation?.querySelector("a")?.focus();
  };

  const setHeaderState = () => {
    header?.classList.toggle("is-scrolled", window.scrollY > 12);
  };

  applyTheme(getSavedTheme() ?? (systemTheme.matches ? "dark" : "light"));
  setHeaderState();
  initializeDownloadCards();
  if (!isEnglish) {
    void loadRelease();
    void loadLoongArchPreview();
  }

  themeToggle?.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
  });

  menuToggle?.addEventListener("click", () => {
    if (header?.classList.contains("is-menu-open")) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  navigation?.addEventListener("click", (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      closeMenu({ restoreFocus: false });
      window.setTimeout(() => {
        if (!header?.classList.contains("is-menu-open")) {
          menuToggle?.focus();
        }
      }, 0);
    }
  });
  menuBackdrop?.addEventListener("click", () => closeMenu());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header?.classList.contains("is-menu-open")) {
      closeMenu();
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

  listenMediaQuery(systemTheme, (event) => {
    if (!getSavedTheme()) {
      applyTheme(event.matches ? "dark" : "light");
    }
  });
  listenMediaQuery(mobileMenu, (event) => {
    if (!event.matches) {
      closeMenu({ restoreFocus: false });
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
    listenMediaQuery(finePointer, resetTilt);
    listenMediaQuery(reducedMotion, resetTilt);
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
