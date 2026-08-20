(() => {
  "use strict";

  const root = document.documentElement;
  const currentLanguage = root.lang.toLowerCase().startsWith("zh") ? "zh" : "en";
  const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
  let savedLanguage = null;

  if (requestedLanguage === "zh" || requestedLanguage === "en") {
    savedLanguage = requestedLanguage;
    try {
      localStorage.setItem("goodbuddy-site-language", requestedLanguage);
    } catch {
      // The requested language still applies to this navigation.
    }
  } else {
    try {
      const storedLanguage = localStorage.getItem("goodbuddy-site-language");
      if (storedLanguage === "zh" || storedLanguage === "en") {
        savedLanguage = storedLanguage;
      }
    } catch {
      // Fall back to the browser language when storage is unavailable.
    }
  }

  const preferredLanguage =
    navigator.languages?.[0] ?? navigator.language ?? "en";
  const targetLanguage =
    savedLanguage ?? (preferredLanguage.toLowerCase().startsWith("zh") ? "zh" : "en");

  document.addEventListener("click", (event) => {
    const languageLink =
      event.target instanceof Element
        ? event.target.closest("[data-language-link]")
        : null;
    if (!(languageLink instanceof HTMLAnchorElement)) {
      return;
    }
    const targetUrl = new URL(languageLink.href, window.location.href);
    targetUrl.hash = window.location.hash;
    languageLink.href = targetUrl.href;
  });

  if (targetLanguage !== currentLanguage) {
    const targetPath = targetLanguage === "zh" ? "./" : "./en.html";
    window.location.replace(`${targetPath}${window.location.hash}`);
  }
})();
