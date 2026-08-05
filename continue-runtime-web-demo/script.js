/*!
 * GoodBuddy Control Center — script.js
 * Vanilla JS only. No external dependencies.
 * CONTINUE_WEB_DEMO_OK
 */
/* global document, window */
(function () {
  "use strict";

  /* ---------------------------------------------------------
   * Utilities
   * ------------------------------------------------------- */

  /**
   * Escapes HTML-sensitive characters in a string so that it is
   * safe to insert as text content inside markup.
   * @param {string} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function qs(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  /* ---------------------------------------------------------
   * Theme toggle (persisted via localStorage)
   * ------------------------------------------------------- */

  var THEME_STORAGE_KEY = "goodbuddy-theme";

  function initTheme() {
    var themeToggleBtn = qs("#themeToggleBtn");
    var iconEl = qs(".theme-toggle-icon", themeToggleBtn);
    var labelEl = qs(".theme-toggle-label", themeToggleBtn);

    function applyTheme(theme) {
      var label;
      if (theme === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
        themeToggleBtn.setAttribute("aria-pressed", "true");
        if (iconEl) iconEl.textContent = "☀️";
        label = "浅色模式";
      } else {
        document.documentElement.removeAttribute("data-theme");
        themeToggleBtn.setAttribute("aria-pressed", "false");
        if (iconEl) iconEl.textContent = "🌙";
        label = "深色模式";
      }
      if (labelEl) labelEl.textContent = label;
      // .theme-toggle-label is visually hidden on narrow viewports and the
      // icon is aria-hidden, so without an explicit aria-label the button
      // has no accessible name on mobile. Keep it in sync with the visible
      // desktop label on every theme change.
      themeToggleBtn.setAttribute("aria-label", label);
    }

    var stored = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* localStorage unavailable, use the default theme */
    }

    var prefersDark =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var initialTheme = stored || (prefersDark ? "dark" : "light");
    applyTheme(initialTheme);

    themeToggleBtn.addEventListener("click", function () {
      var isDark = document.documentElement.getAttribute("data-theme") === "dark";
      var nextTheme = isDark ? "light" : "dark";
      applyTheme(nextTheme);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {
        /* localStorage unavailable — ignore silently */
      }
    });
  }

  /* ---------------------------------------------------------
   * Mobile navigation toggle
   * ------------------------------------------------------- */

  function initNavToggle() {
    var navToggleBtn = qs("#navToggleBtn");
    var primaryNav = qs("#primaryNav");
    if (!navToggleBtn || !primaryNav) return;

    navToggleBtn.addEventListener("click", function () {
      var isOpen = primaryNav.classList.toggle("is-open");
      navToggleBtn.setAttribute("aria-expanded", String(isOpen));
    });

    qsa("a", primaryNav).forEach(function (link) {
      link.addEventListener("click", function () {
        primaryNav.classList.remove("is-open");
        navToggleBtn.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ---------------------------------------------------------
   * Task board: filtering + adding tasks
   * ------------------------------------------------------- */

  var STATUS_LABELS = {
    running: "运行中",
    completed: "已完成"
  };

  var STATUS_BADGE_CLASS = {
    running: "status-running",
    completed: "status-completed"
  };

  function initTaskBoard() {
    var taskList = qs("#taskList");
    var filterButtons = qsa(".filter-btn");
    var emptyState = qs("#taskEmptyState");

    function currentFilter() {
      var activeBtn = qs(".filter-btn.is-active");
      return activeBtn ? activeBtn.getAttribute("data-filter") : "all";
    }

    function applyFilter() {
      var filter = currentFilter();
      var cards = qsa(".task-card", taskList);
      var visibleCount = 0;

      cards.forEach(function (card) {
        var status = card.getAttribute("data-status");
        var matches = filter === "all" || status === filter;
        card.hidden = !matches;
        if (matches) visibleCount += 1;
      });

      if (emptyState) {
        emptyState.hidden = visibleCount !== 0;
      }
    }

    filterButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        filterButtons.forEach(function (b) {
          b.classList.remove("is-active");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-pressed", "true");
        applyFilter();
      });
    });

    /**
     * Builds a task card list item using safe DOM APIs so that
     * user-provided text can never be interpreted as markup.
     */
    function createTaskCard(title, assignee, status) {
      var li = document.createElement("li");
      li.className = "task-card";
      li.setAttribute("data-status", status);

      var top = document.createElement("div");
      top.className = "task-card-top";

      var heading = document.createElement("h3");
      heading.className = "task-title";
      // textContent assigns the raw string as plain text — the browser
      // never parses it as markup, so no HTML-escaping is needed (or
      // wanted) here. Escaping first would make textContent render the
      // escaped entities literally (e.g. "&lt;img...") instead of the
      // user's exact text.
      heading.textContent = title;

      var badge = document.createElement("span");
      badge.className = "status-badge " + STATUS_BADGE_CLASS[status];
      badge.textContent = STATUS_LABELS[status];

      top.appendChild(heading);
      top.appendChild(badge);

      var meta = document.createElement("p");
      meta.className = "task-meta";
      meta.textContent = "负责人：" + assignee;

      var metaTime = document.createElement("p");
      metaTime.className = "task-meta";
      var now = new Date();
      var timeLabel =
        status === "completed"
          ? "完成时间：刚刚"
          : "截止时间：" +
            String(now.getHours()).padStart(2, "0") +
            ":" +
            String(now.getMinutes()).padStart(2, "0");
      metaTime.textContent = timeLabel;

      li.appendChild(top);
      li.appendChild(meta);
      li.appendChild(metaTime);

      return li;
    }

    applyFilter();

    return {
      addTask: function (title, assignee, status) {
        // Pass the trimmed, un-escaped user text straight through.
        // createTaskCard assigns it via textContent (never innerHTML),
        // so it is rendered as inert plain text and can never execute as
        // markup/script regardless of its contents.
        var card = createTaskCard(title.trim(), assignee, status);
        taskList.insertBefore(card, taskList.firstChild);
        applyFilter();
        return card;
      }
    };
  }

  /* ---------------------------------------------------------
   * Activity log search
   * ------------------------------------------------------- */

  function initActivitySearch() {
    var searchInput = qs("#activitySearch");
    var activityList = qs("#activityList");
    var emptyState = qs("#activityEmptyState");
    if (!searchInput || !activityList) return;

    function runSearch() {
      var query = searchInput.value.trim().toLowerCase();
      var items = qsa(".activity-item", activityList);
      var visibleCount = 0;

      items.forEach(function (item) {
        var text = item.textContent.toLowerCase();
        var matches = query === "" || text.indexOf(query) !== -1;
        item.hidden = !matches;
        if (matches) visibleCount += 1;
      });

      if (emptyState) {
        emptyState.hidden = visibleCount !== 0;
      }
    }

    searchInput.addEventListener("input", runSearch);
  }

  /* ---------------------------------------------------------
   * Add-task modal (accessible dialog)
   * ------------------------------------------------------- */

  function initTaskModal(taskBoard) {
    var overlay = qs("#taskModalOverlay");
    var modal = qs("#taskModal");
    var openBtn = qs("#addTaskBtn");
    var closeBtn = qs("#modalCloseBtn");
    var cancelBtn = qs("#modalCancelBtn");
    var form = qs("#taskForm");
    var titleInput = qs("#taskTitleInput");
    var assigneeSelect = qs("#taskAssigneeSelect");
    var statusSelect = qs("#taskStatusSelect");
    var errorMsg = qs("#taskFormError");

    if (!overlay || !modal || !openBtn || !form) return;

    var lastFocusedElement = null;

    function getFocusableElements() {
      return qsa(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        modal
      ).filter(function (el) {
        return el.offsetParent !== null;
      });
    }

    function openModal() {
      lastFocusedElement = document.activeElement;
      overlay.hidden = false;
      modal.hidden = false;
      errorMsg.hidden = true;
      form.reset();
      document.body.style.overflow = "hidden";
      titleInput.focus();
      document.addEventListener("keydown", handleKeydown);
    }

    function closeModal() {
      overlay.hidden = true;
      modal.hidden = true;
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeydown);
      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
    }

    function handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }

      if (event.key === "Tab") {
        var focusable = getFocusableElements();
        if (focusable.length === 0) return;

        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    openBtn.addEventListener("click", openModal);
    closeBtn.addEventListener("click", closeModal);
    cancelBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", closeModal);

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var title = titleInput.value.trim();
      if (title === "") {
        errorMsg.hidden = false;
        titleInput.focus();
        return;
      }

      errorMsg.hidden = true;
      taskBoard.addTask(title, assigneeSelect.value, statusSelect.value);
      closeModal();
    });
  }

  /* ---------------------------------------------------------
   * Bootstrap
   * ------------------------------------------------------- */

  function init() {
    initTheme();
    initNavToggle();
    var taskBoard = initTaskBoard();
    initActivitySearch();
    initTaskModal(taskBoard);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose escapeHtml for testability / verification purposes only.
  window.__goodbuddyEscapeHtml = escapeHtml;
})();

// CONTINUE_WEB_DEMO_OK
