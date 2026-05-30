// ==UserScript==
// @name         Thread Viewer Buttons for Bluesky
// @namespace    https://threadviewer.app
// @version      1.4
// @description  Adds Thread Viewer buttons, thread liking, and video downloads on bsky.app post pages
// @match        https://bsky.app/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VIEWER_BASE = 'https://threadviewer.app';
  const PUBLIC_API_BASE = 'https://public.api.bsky.app/xrpc';
  const CONTAINER_ID = 'tv-buttons-container';
  const STATUS_ID = 'tv-like-status';
  const POST_RE = /\/profile\/[^/]+\/post\//;
  const LIKE_DELAY_MS = 650;
  const SCROLL_DELAY_MS = 850;
  const DOWNLOAD_STATUS_EVERY_N_SEGMENTS = 3;
  const DOWNLOAD_URL_REVOKE_MS = 10 * 60 * 1000;
  const MAX_LIKES_PER_RUN = 250;
  const MAX_SCROLL_PASSES = 220;

  let likeRun = null;
  let downloadRun = null;

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

  function createActionButton(label, svgPath, title, onclick, background = '#19a463', hoverBackground = '#13824f') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    applyButtonStyle(btn, background, hoverBackground);
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

  function setStatusContent(nodes) {
    const status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.textContent = '';
    nodes.forEach((node) => status.appendChild(node));
    status.style.display = nodes.length > 0 ? 'block' : 'none';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  function requestViaUserscript(url, responseType, headers = {}) {
    if (typeof GM_xmlhttpRequest !== 'function') return null;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        responseType,
        timeout: 120000,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status} while fetching ${shortUrl(url)}`));
            return;
          }
          resolve(response);
        },
        onerror: () => reject(new Error(`Network error while fetching ${shortUrl(url)}`)),
        ontimeout: () => reject(new Error(`Timed out while fetching ${shortUrl(url)}`))
      });
    });
  }

  async function requestText(url, headers = {}) {
    const userscriptRequest = requestViaUserscript(url, 'text', headers);
    if (userscriptRequest) {
      const response = await userscriptRequest;
      return response.responseText || String(response.response || '');
    }

    const response = await fetch(url, { headers, credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${shortUrl(url)}`);
    return response.text();
  }

  async function requestArrayBuffer(url, headers = {}) {
    const userscriptRequest = requestViaUserscript(url, 'arraybuffer', headers);
    if (userscriptRequest) {
      const response = await userscriptRequest;
      if (response.response instanceof ArrayBuffer) return response.response;
      if (response.responseText) return new TextEncoder().encode(response.responseText).buffer;
      throw new Error(`Empty response while fetching ${shortUrl(url)}`);
    }

    const response = await fetch(url, { headers, credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${shortUrl(url)}`);
    return response.arrayBuffer();
  }

  async function requestJson(url) {
    const text = await requestText(url);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Could not parse JSON from ${shortUrl(url)}`);
    }
  }

  function buildXrpcUrl(method, params = {}) {
    const url = new URL(`${PUBLIC_API_BASE}/${method}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });
    return url.href;
  }

  function currentPostParts() {
    const match = location.pathname.match(/^\/profile\/([^/]+)\/post\/([^/?#]+)/);
    if (!match) return null;
    return {
      handle: decodeURIComponent(match[1]),
      rkey: decodeURIComponent(match[2])
    };
  }

  async function resolveDid(handleOrDid) {
    if (handleOrDid.startsWith('did:')) return handleOrDid;
    const data = await requestJson(buildXrpcUrl('com.atproto.identity.resolveHandle', { handle: handleOrDid }));
    if (!data?.did) throw new Error(`Could not resolve @${handleOrDid}`);
    return data.did;
  }

  function addVideo(videos, seen, video, source) {
    if (!video || typeof video.playlist !== 'string' || !video.playlist) return;
    const key = video.playlist || video.cid || video.thumbnail;
    if (seen.has(key)) return;
    seen.add(key);
    videos.push({
      playlist: video.playlist,
      cid: typeof video.cid === 'string' ? video.cid : '',
      alt: typeof video.alt === 'string' ? video.alt : '',
      thumbnail: typeof video.thumbnail === 'string' ? video.thumbnail : '',
      authorHandle: source.authorHandle || '',
      context: source.context || 'post',
      uri: source.uri || ''
    });
  }

  function collectVideosFromRecord(record, source, videos, seen) {
    if (!record || typeof record !== 'object') return;
    const view = record.record && typeof record.record === 'object' ? record.record : record;
    const nextSource = {
      ...source,
      authorHandle: view.author?.handle || source.authorHandle,
      uri: view.uri || source.uri
    };
    if (view.embed) collectVideosFromEmbed(view.embed, nextSource, videos, seen);
    if (Array.isArray(view.embeds)) {
      view.embeds.forEach((embed) => collectVideosFromEmbed(embed, nextSource, videos, seen));
    }
  }

  function collectVideosFromEmbed(embed, source, videos, seen) {
    if (!embed || typeof embed !== 'object') return;

    if (embed.$type === 'app.bsky.embed.video#view' || embed.playlist) {
      addVideo(videos, seen, embed, source);
    }

    if (embed.media) collectVideosFromEmbed(embed.media, source, videos, seen);
    if (embed.record) {
      collectVideosFromRecord(embed.record, { ...source, context: 'quoted post' }, videos, seen);
    }
  }

  async function findPostVideos() {
    const parts = currentPostParts();
    if (!parts) throw new Error('This is not a Bluesky post URL.');

    const did = await resolveDid(parts.handle);
    const uri = `at://${did}/app.bsky.feed.post/${parts.rkey}`;
    const data = await requestJson(
      buildXrpcUrl('app.bsky.feed.getPostThread', {
        uri,
        depth: '0',
        parentHeight: '0'
      })
    );

    const post = data?.thread?.post;
    if (!post) throw new Error('Could not load the current post from the public Bluesky API.');

    const videos = [];
    const seen = new Set();
    collectVideosFromEmbed(
      post.embed,
      {
        authorHandle: post.author?.handle || parts.handle,
        context: 'post',
        uri: post.uri || uri
      },
      videos,
      seen
    );

    return {
      handle: post.author?.handle || parts.handle,
      rkey: parts.rkey,
      uri: post.uri || uri,
      videos
    };
  }

  function parseM3uLines(text) {
    return text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseAttributeList(raw) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match;
    while ((match = re.exec(raw))) {
      const value = match[2];
      attrs[match[1]] = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    }
    return attrs;
  }

  function parseResolutionScore(value) {
    const match = String(value || '').match(/^(\d+)x(\d+)$/);
    if (!match) return 0;
    return Number(match[1]) * Number(match[2]);
  }

  function parseMasterPlaylist(text, baseUrl) {
    const lines = parseM3uLines(text);
    const variants = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      let uriLine = '';
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].startsWith('#')) {
          uriLine = lines[j];
          break;
        }
      }
      if (!uriLine) continue;
      variants.push({
        url: new URL(uriLine, baseUrl).href,
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolutionScore: parseResolutionScore(attrs.RESOLUTION),
        attrs
      });
    }
    return variants;
  }

  function chooseBestVariant(variants) {
    return variants
      .slice()
      .sort((a, b) => b.bandwidth - a.bandwidth || b.resolutionScore - a.resolutionScore)[0];
  }

  function parseByteRange(value, fallbackOffset = 0) {
    if (!value) return null;
    const [lengthValue, offsetValue] = String(value).split('@');
    const length = Number(lengthValue);
    const offset = offsetValue === undefined ? fallbackOffset : Number(offsetValue);
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(offset) || offset < 0) return null;
    return { offset, length };
  }

  function parseMediaPlaylist(text, baseUrl) {
    const lines = parseM3uLines(text);
    const segments = [];
    let initPart = null;
    let pendingByteRange = null;
    let byteRangeOffset = 0;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) {
          initPart = {
            url: new URL(attrs.URI, baseUrl).href,
            range: parseByteRange(attrs.BYTERANGE, 0),
            role: 'init'
          };
        }
        continue;
      }

      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingByteRange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
        continue;
      }

      if (line.startsWith('#')) continue;

      const range = parseByteRange(pendingByteRange, byteRangeOffset);
      if (range) byteRangeOffset = range.offset + range.length;
      pendingByteRange = null;
      segments.push({
        url: new URL(line, baseUrl).href,
        range,
        role: 'segment'
      });
    }

    return { initPart, segments };
  }

  function extensionFromUrl(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (path.endsWith('.ts')) return 'ts';
      if (path.endsWith('.m4s') || path.endsWith('.mp4') || path.endsWith('.m4v')) return 'mp4';
    } catch {
      // Ignore and fall through to the default.
    }
    return '';
  }

  function mediaTypeForParts(parts) {
    if (parts.some((part) => part.role === 'init')) return { ext: 'mp4', mime: 'video/mp4' };
    const ext = extensionFromUrl(parts.find((part) => part.role === 'segment')?.url || '');
    if (ext === 'mp4') return { ext: 'mp4', mime: 'video/mp4' };
    if (ext === 'ts') return { ext: 'ts', mime: 'video/mp2t' };
    return { ext: 'ts', mime: 'video/mp2t' };
  }

  async function buildHlsDownloadPlan(playlistUrl) {
    const firstPlaylistText = await requestText(playlistUrl);
    const variants = parseMasterPlaylist(firstPlaylistText, playlistUrl);
    const selectedVariant = variants.length > 0 ? chooseBestVariant(variants) : null;
    const mediaPlaylistUrl = selectedVariant?.url || playlistUrl;
    const mediaPlaylistText = selectedVariant ? await requestText(mediaPlaylistUrl) : firstPlaylistText;
    const media = parseMediaPlaylist(mediaPlaylistText, mediaPlaylistUrl);
    const parts = [...(media.initPart ? [media.initPart] : []), ...media.segments];
    if (parts.length === 0) throw new Error('The video playlist did not list any downloadable segments.');
    return {
      ...mediaTypeForParts(parts),
      parts,
      variant: selectedVariant
    };
  }

  function headersForPart(part) {
    if (!part.range) return {};
    return {
      Range: `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}`
    };
  }

  function sanitizeFilenamePart(value, fallback) {
    const clean = String(value || '')
      .replace(/^@/, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return clean || fallback;
  }

  function triggerAnchorDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadViaTampermonkey(url, filename) {
    if (typeof GM_download !== 'function') return null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Tampermonkey did not report the download starting.'));
      }, 5000);

      try {
        GM_download({
          url,
          name: filename,
          saveAs: false,
          onload: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve();
          },
          onerror: (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(error?.error || error?.details || 'Tampermonkey download failed.'));
          }
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async function saveBlob(buffers, filename, mime) {
    const blob = new Blob(buffers, { type: mime });
    const url = URL.createObjectURL(blob);

    try {
      triggerAnchorDownload(url, filename);
      return { url };
    } catch (anchorError) {
      const tampermonkeyDownload = downloadViaTampermonkey(url, filename);
      if (!tampermonkeyDownload) throw anchorError;
      await tampermonkeyDownload;
      return { url };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_MS);
    }
  }

  function setDownloadResultsStatus(results, totalBytes, stopped) {
    const summary = document.createElement('div');
    summary.textContent = stopped
      ? `Stopped. Prepared ${results.length} video${results.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}).`
      : `Download triggered for ${results.length} video${results.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}).`;

    const hint = document.createElement('div');
    hint.textContent = 'If nothing appeared, click below:';
    hint.style.marginTop = '6px';
    hint.style.opacity = '0.85';

    const nodes = [summary];
    if (results.length > 0) nodes.push(hint);

    results.forEach((result) => {
      const link = document.createElement('a');
      link.href = result.downloadUrl;
      link.download = result.filename;
      link.textContent = result.filename;
      link.style.cssText = `
        display: block;
        margin-top: 4px;
        color: #bfdbfe;
        text-decoration: underline;
        overflow-wrap: anywhere;
      `;
      nodes.push(link);
    });

    setStatusContent(nodes);
  }

  async function downloadHlsVideo(video, filenameBase, state, positionLabel) {
    setStatus(`${positionLabel}: reading video playlist...`);
    const plan = await buildHlsDownloadPlan(video.playlist);
    const buffers = [];
    let downloadedBytes = 0;

    for (let i = 0; i < plan.parts.length; i += 1) {
      if (state.cancelled) return null;
      const part = plan.parts[i];
      const buffer = await requestArrayBuffer(part.url, headersForPart(part));
      buffers.push(buffer);
      downloadedBytes += buffer.byteLength;

      const segmentNumber = i + 1;
      if (
        segmentNumber === 1 ||
        segmentNumber === plan.parts.length ||
        segmentNumber % DOWNLOAD_STATUS_EVERY_N_SEGMENTS === 0
      ) {
        setStatus(
          `${positionLabel}: ${segmentNumber} / ${plan.parts.length} segment${plan.parts.length === 1 ? '' : 's'} (${formatBytes(downloadedBytes)})`
        );
      }
    }

    if (state.cancelled) return null;

    const filename = `${filenameBase}.${plan.ext}`;
    const download = await saveBlob(buffers, filename, plan.mime);
    return { filename, bytes: downloadedBytes, downloadUrl: download.url };
  }

  async function downloadPostVideos(button) {
    if (downloadRun) {
      downloadRun.cancelled = true;
      setStatus('Stopping video download after the current segment...');
      return;
    }

    const state = { cancelled: false };
    downloadRun = state;
    setButtonLabel(button, 'Stop movies');
    setStatus('Looking for videos on this post...');

    try {
      const post = await findPostVideos();
      if (post.videos.length === 0) {
        setStatus('No videos found on this post or its quoted post.');
        return;
      }

      const base = `bsky-${sanitizeFilenamePart(post.handle, 'user')}-${sanitizeFilenamePart(post.rkey, 'post')}`;
      const results = [];
      for (let i = 0; i < post.videos.length; i += 1) {
        if (state.cancelled) break;
        const video = post.videos[i];
        const suffix = post.videos.length > 1 ? `-${i + 1}` : '';
        const context = post.videos.length > 1 ? `video ${i + 1} of ${post.videos.length}` : 'video';
        const result = await downloadHlsVideo(video, `${base}${suffix}`, state, context);
        if (result) results.push(result);
      }

      if (state.cancelled) {
        const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
        setDownloadResultsStatus(results, totalBytes, true);
      } else {
        const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);
        setDownloadResultsStatus(results, totalBytes, false);
      }
    } catch (err) {
      console.error('[Thread Viewer Buttons] Video download failed', err);
      setStatus(`Video download failed: ${err?.message || err}`);
    } finally {
      downloadRun = null;
      setButtonLabel(button, 'Download movies');
    }
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
    const downloadSvg = `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`;
    const likeSvg = `<path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/><path d="M7 11l4-8a3 3 0 0 1 3 3v5h5a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H7z"/>`;

    container.appendChild(createViewerButton('Chat', chatSvg, 'chat'));
    container.appendChild(createViewerButton('Board', boardSvg, 'board'));
    container.appendChild(
      createActionButton(
        'Download movies',
        downloadSvg,
        'Download videos attached to this post',
        (event) => {
          downloadPostVideos(event.currentTarget);
        },
        '#6d5dfc',
        '#5847d9'
      )
    );
    container.appendChild(createActionButton('Like thread', likeSvg, 'Like all visible posts in this thread', (event) => {
      likeThread(event.currentTarget);
    }));
    container.appendChild(createStatus());

    document.body.appendChild(container);
  }

  function removeButtons() {
    if (likeRun) likeRun.cancelled = true;
    if (downloadRun) downloadRun.cancelled = true;
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
