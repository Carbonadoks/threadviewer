// ==UserScript==
// @name         Thread Viewer Buttons for Bluesky
// @namespace    https://thread-viewer.pages.dev
// @version      1.1
// @description  Adds Chat and Board buttons on bsky.app post pages to open in Thread Viewer
// @match        https://bsky.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VIEWER_BASE = 'https://thread-viewer.pages.dev';
  const CONTAINER_ID = 'tv-buttons-container';
  const POST_RE = /\/profile\/[^/]+\/post\//;

  function isPostPage() {
    return POST_RE.test(location.pathname);
  }

  function createButton(label, svgPath, route) {
    const btn = document.createElement('a');
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    btn.title = `Open in ${label}`;
    btn.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 8px;
      background: #1185fe;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-decoration: none;
      cursor: pointer;
      transition: background 0.15s;
      line-height: 1;
    `;
    btn.addEventListener('mouseenter', () => (btn.style.background = '#0070e0'));
    btn.addEventListener('mouseleave', () => (btn.style.background = '#1185fe'));

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.innerHTML = svgPath;

    btn.appendChild(icon);
    btn.appendChild(document.createTextNode(label));

    // Always use current URL at click time
    btn.addEventListener('mousedown', () => {
      btn.href = `${VIEWER_BASE}/${route}?url=${encodeURIComponent(location.href)}`;
    });
    btn.href = `${VIEWER_BASE}/${route}?url=${encodeURIComponent(location.href)}`;

    return btn;
  }

  function updateButtonHrefs() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    const links = container.querySelectorAll('a');
    links.forEach((a) => {
      const route = a.href.includes('/chat?') ? 'chat' : 'board';
      a.href = `${VIEWER_BASE}/${route}?url=${encodeURIComponent(location.href)}`;
    });
  }

  function injectButtons() {
    if (document.getElementById(CONTAINER_ID)) {
      updateButtonHrefs();
      return;
    }

    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;

    const chatSvg = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`;
    const boardSvg = `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`;

    container.appendChild(createButton('Chat', chatSvg, 'chat'));
    container.appendChild(createButton('Board', boardSvg, 'board'));

    document.body.appendChild(container);
  }

  function removeButtons() {
    const el = document.getElementById(CONTAINER_ID);
    if (el) el.remove();
  }

  function onUrlChange() {
    if (isPostPage()) {
      injectButtons();
    } else {
      removeButtons();
    }
  }

  // Hook pushState and replaceState to catch SPA navigation
  const origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    onUrlChange();
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    onUrlChange();
  };

  // Catch back/forward navigation
  window.addEventListener('popstate', onUrlChange);

  // Polling fallback for any edge cases the hooks miss
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onUrlChange();
    }
  }, 500);

  // Initial check once body is ready
  if (document.body) {
    onUrlChange();
  } else {
    document.addEventListener('DOMContentLoaded', onUrlChange);
  }
})();
