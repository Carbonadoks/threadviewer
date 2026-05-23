// ==UserScript==
// @name         Thread Viewer Buttons for Bluesky
// @namespace    https://threadviewer.app
// @version      1.2
// @description  Adds Thread Viewer buttons and a Like thread button on bsky.app post pages
// @match        https://bsky.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VIEWER_BASE = 'https://threadviewer.app';
  const CONTAINER_ID = 'tv-buttons-container';
  const STATUS_ID = 'tv-like-status';
  const POST_RE = /\/profile\/[^/]+\/post\//;
  const LIKE_DELAY_MS = 650;
  const SCROLL_DELAY_MS = 850;
  const MAX_LIKES_PER_RUN = 250;
  const MAX_SCROLL_PASSES = 220;

  let likeRun = null;

  function isPostPage() {
    return POST_RE.test(location.pathname);
  }

  function applyButtonStyle(btn, background = '#1185fe', hoverBackground = '#0070e0') {
    btn.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 8px;
      background: ${background};
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      text-decoration: none;
      cursor: pointer;
      transition: background 0.15s;
      line-height: 1;
      border: 0;
    `;
    btn.addEventListener('mouseenter', () => (btn.style.background = hoverBackground));
    btn.addEventListener('mouseleave', () => (btn.style.background = background));
  }

  function appendIconAndLabel(btn, label, svgPath) {
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
    const labelNode = document.createElement('span');
    labelNode.dataset.tvLabel = 'true';
    labelNode.textContent = label;
    btn.appendChild(labelNode);
  }

  function setButtonLabel(btn, label) {
    const labelNode = btn.querySelector('[data-tv-label="true"]');
    if (labelNode) labelNode.textContent = label;
  }

  function createViewerButton(label, svgPath, route) {
    const btn = document.createElement('a');
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    btn.dataset.tvRoute = route;
    btn.title = `Open in ${label}`;
    applyButtonStyle(btn);
    appendIconAndLabel(btn, label, svgPath);

    // Always use current URL at click time
    btn.addEventListener('mousedown', () => {
      btn.href = `${VIEWER_BASE}/${route}?url=${encodeURIComponent(location.href)}`;
    });
    btn.href = `${VIEWER_BASE}/${route}?url=${encodeURIComponent(location.href)}`;

    return btn;
  }

  function createActionButton(label, svgPath, title, onclick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    applyButtonStyle(btn, '#19a463', '#13824f');
    appendIconAndLabel(btn, label, svgPath);
    btn.addEventListener('click', onclick);
    return btn;
  }

  function updateButtonHrefs() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    const links = container.querySelectorAll('a[data-tv-route]');
    links.forEach((a) => {
      const route = a.dataset.tvRoute;
      a.href = `${VIEWER_BASE}/${route}?url=${encodeURIComponent(location.href)}`;
    });
  }

  function createStatus() {
    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.style.cssText = `
      display: none;
      max-width: 220px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.92);
      color: #fff;
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.35;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    `;
    return status;
  }

  function setStatus(message) {
    const status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.textContent = message;
    status.style.display = message ? 'block' : 'none';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
  }

  function isLikeButton(el) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (!label) return false;
    if (/^(unlike|remove like)\b/i.test(label)) return false;
    return /^like\b/i.test(label) || /\blike this post\b/i.test(label);
  }

  function normalizePostHref(href) {
    if (!href) return '';
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(/\/profile\/([^/]+)\/post\/([^/?#]+)/);
      return match ? `/profile/${match[1]}/post/${match[2]}` : '';
    } catch {
      return '';
    }
  }

  function postKeyForButton(btn) {
    const postRoot =
      btn.closest('[role="article"], article, [data-testid*="post"], [data-testid*="feedItem"]') ||
      btn.closest('div');
    const postLink = postRoot?.querySelector('a[href*="/profile/"][href*="/post/"]');
    return normalizePostHref(postLink?.getAttribute('href')) || '';
  }

  function findVisibleLikeButtons() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.closest(`#${CONTAINER_ID}`)) return false;
      if (!isVisible(el)) return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      return isLikeButton(el);
    });
  }

  async function clickVisibleLikeButtons(state) {
    let clickedThisPass = 0;
    for (const btn of findVisibleLikeButtons()) {
      if (state.cancelled || state.clicked >= MAX_LIKES_PER_RUN) break;

      const postKey = postKeyForButton(btn);
      if (postKey && state.seenPostKeys.has(postKey)) continue;
      if (!postKey && state.seenButtons.has(btn)) continue;

      state.seenButtons.add(btn);
      if (postKey) state.seenPostKeys.add(postKey);

      btn.click();
      state.clicked += 1;
      clickedThisPass += 1;
      setStatus(`Liking thread... ${state.clicked} post${state.clicked === 1 ? '' : 's'} liked.`);
      await sleep(LIKE_DELAY_MS);
    }
    return clickedThisPass;
  }

  function atPageBottom() {
    return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
  }

  async function likeThread(button) {
    if (likeRun) {
      likeRun.cancelled = true;
      setStatus('Stopping after the current click...');
      return;
    }

    const ok = window.confirm(
      `Like every unliked post this page can discover in the current thread?\n\n` +
        `The script scrolls the thread and clicks normal Bluesky Like buttons with a short delay. It stops at ${MAX_LIKES_PER_RUN} likes.`
    );
    if (!ok) return;

    const state = {
      cancelled: false,
      clicked: 0,
      seenButtons: new WeakSet(),
      seenPostKeys: new Set()
    };
    likeRun = state;
    setButtonLabel(button, 'Stop liking');
    setStatus('Starting at the top of the thread...');

    try {
      window.scrollTo({ top: 0, behavior: 'auto' });
      await sleep(SCROLL_DELAY_MS);

      let stuckPasses = 0;
      let lastScrollY = -1;

      for (let pass = 0; pass < MAX_SCROLL_PASSES; pass += 1) {
        if (state.cancelled || state.clicked >= MAX_LIKES_PER_RUN) break;

        const clickedThisPass = await clickVisibleLikeButtons(state);
        if (state.cancelled || state.clicked >= MAX_LIKES_PER_RUN) break;

        if (atPageBottom()) {
          if (clickedThisPass === 0) stuckPasses += 1;
          if (stuckPasses >= 2) break;
        } else {
          stuckPasses = 0;
        }

        const step = Math.max(360, Math.floor(window.innerHeight * 0.72));
        window.scrollBy({ top: step, behavior: 'auto' });
        await sleep(SCROLL_DELAY_MS);

        if (window.scrollY === lastScrollY && clickedThisPass === 0) {
          stuckPasses += 1;
          if (stuckPasses >= 3) break;
        }
        lastScrollY = window.scrollY;
      }

      if (state.cancelled) {
        setStatus(`Stopped. Liked ${state.clicked} post${state.clicked === 1 ? '' : 's'}.`);
      } else if (state.clicked >= MAX_LIKES_PER_RUN) {
        setStatus(`Stopped at the ${MAX_LIKES_PER_RUN}-like safety cap.`);
      } else if (state.clicked === 0) {
        setStatus('No visible unliked posts found. Make sure you are logged in and the thread is loaded.');
      } else {
        setStatus(`Done. Liked ${state.clicked} post${state.clicked === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      console.error('[Thread Viewer Buttons] Like thread failed', err);
      setStatus(`Like thread failed: ${err?.message || err}`);
    } finally {
      likeRun = null;
      setButtonLabel(button, 'Like thread');
    }
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
    const likeSvg = `<path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/><path d="M7 11l4-8a3 3 0 0 1 3 3v5h5a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H7z"/>`;

    container.appendChild(createViewerButton('Chat', chatSvg, 'chat'));
    container.appendChild(createViewerButton('Board', boardSvg, 'board'));
    container.appendChild(createActionButton('Like thread', likeSvg, 'Like all visible posts in this thread', (event) => {
      likeThread(event.currentTarget);
    }));
    container.appendChild(createStatus());

    document.body.appendChild(container);
  }

  function removeButtons() {
    if (likeRun) likeRun.cancelled = true;
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
