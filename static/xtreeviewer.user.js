// ==UserScript==
// @name         xtreeviewer grabber
// @namespace    https://threadviewer.app
// @version      1.10.0
// @description  Capture the current X.com thread (using your own session) and open it in threadviewer.app/xtreeviewer
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.twitter.com/*
// @downloadURL  https://threadviewer.app/xtreeviewer.user.js
// @updateURL    https://threadviewer.app/xtreeviewer.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
	'use strict';

	var VIEWER_ORIGIN = 'https://threadviewer.app';
	var VIEWER_PATH = '/xtreeviewer';
	var MESSAGE_TYPE = 'xtreeviewer:thread';
	var ACK_TYPE = 'xtreeviewer:ack';
	// Stay under X's ~150 TweetDetail / 15 min budget in a single run so we stop
	// gracefully (resumable) instead of getting hard rate-limited.
	var MAX_REQUESTS = 130;
	var REQUEST_DELAY_MS = 400;
	// Public bearer token baked into the x.com web app; identical for every visitor.
	// Used only as a fallback if we never observed a live TweetDetail request.
	var WEB_BEARER =
		'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

	var STATUS_PATH_RE = /^\/(?:[^/]+)\/status(?:es)?\/(\d+)/;
	var capturing = false;
	var paused = false;
	var pausedAccumMs = 0; // total paused time in the current run
	var pauseStartedAt = 0;

	function currentStatusId() {
		var match = location.pathname.match(STATUS_PATH_RE) || location.pathname.match(/^\/i\/(?:web\/)?status\/(\d+)/);
		return match ? match[1] : null;
	}

	function getCookie(name) {
		var match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
		return match ? decodeURIComponent(match[1]) : '';
	}

	function sleep(ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	// ---------------------------------------------------------------------
	// Live-request capture: hook fetch/XHR (installed at document-start, page
	// context via @grant none) to record the exact TweetDetail request the X
	// app issues — its full URL (queryId + features + fieldToggles) and its
	// headers (auth, csrf, and x-client-transaction-id). Replaying these keeps
	// us in lockstep with the deployed bundle. Resource timing is only a
	// fallback for URL discovery.
	// ---------------------------------------------------------------------
	var liveTemplate = null;

	function isTweetDetailUrl(url) {
		return typeof url === 'string' && url.indexOf('/graphql/') !== -1 && url.indexOf('TweetDetail') !== -1;
	}

	function headersToObject(headers) {
		var out = {};
		if (!headers) return out;
		if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
			headers.forEach(function (value, key) {
				out[String(key).toLowerCase()] = value;
			});
			return out;
		}
		if (Array.isArray(headers)) {
			headers.forEach(function (pair) {
				if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = pair[1];
			});
			return out;
		}
		Object.keys(headers).forEach(function (key) {
			out[key.toLowerCase()] = headers[key];
		});
		return out;
	}

	function recordTemplateFromUrl(url, headers) {
		if (!isTweetDetailUrl(url)) return;
		try {
			var parsed = new URL(url, location.origin);
			var variables = JSON.parse(parsed.searchParams.get('variables') || 'null');
			if (!variables || !variables.focalTweetId) return;
			liveTemplate = {
				base: parsed.origin + parsed.pathname,
				variables: variables,
				features: parsed.searchParams.get('features'),
				fieldToggles: parsed.searchParams.get('fieldToggles'),
				headers: headersToObject(headers)
			};
		} catch (e) {
			/* ignore malformed */
		}
	}

	(function installHooks() {
		var origFetch = window.fetch;
		if (typeof origFetch === 'function') {
			window.fetch = function (input, init) {
				try {
					var url = typeof input === 'string' ? input : input && input.url;
					var headers = (init && init.headers) || (input && input.headers);
					recordTemplateFromUrl(url, headers);
				} catch (e) {
					/* never break the page */
				}
				return origFetch.apply(this, arguments);
			};
		}

		var XHR = window.XMLHttpRequest;
		if (XHR && XHR.prototype) {
			var origOpen = XHR.prototype.open;
			var origSet = XHR.prototype.setRequestHeader;
			var origSend = XHR.prototype.send;
			XHR.prototype.open = function (method, url) {
				this.__xtvUrl = url;
				this.__xtvHeaders = {};
				return origOpen.apply(this, arguments);
			};
			XHR.prototype.setRequestHeader = function (key, value) {
				if (this.__xtvHeaders) this.__xtvHeaders[String(key).toLowerCase()] = value;
				return origSet.apply(this, arguments);
			};
			XHR.prototype.send = function () {
				try {
					recordTemplateFromUrl(this.__xtvUrl, this.__xtvHeaders);
				} catch (e) {
					/* ignore */
				}
				return origSend.apply(this, arguments);
			};
		}
	})();

	// Fallback: scan the resource timing buffer for a TweetDetail URL (no headers).
	function templateFromResourceTiming() {
		var entries = performance.getEntriesByType('resource');
		for (var i = entries.length - 1; i >= 0; i--) {
			var name = entries[i].name || '';
			if (!isTweetDetailUrl(name)) continue;
			try {
				var url = new URL(name);
				var variables = JSON.parse(url.searchParams.get('variables') || 'null');
				if (!variables || !variables.focalTweetId) continue;
				return {
					base: url.origin + url.pathname,
					variables: variables,
					features: url.searchParams.get('features'),
					fieldToggles: url.searchParams.get('fieldToggles'),
					headers: null
				};
			} catch (e) {
				/* keep scanning */
			}
		}
		return null;
	}

	function buildDetailUrl(template, focalTweetId, cursor) {
		var variables = JSON.parse(JSON.stringify(template.variables));
		variables.focalTweetId = focalTweetId;
		if (cursor) {
			variables.cursor = cursor;
			variables.referrer = 'tweet';
		} else {
			delete variables.cursor;
		}
		var url = new URL(template.base);
		url.searchParams.set('variables', JSON.stringify(variables));
		if (template.features) url.searchParams.set('features', template.features);
		if (template.fieldToggles) url.searchParams.set('fieldToggles', template.fieldToggles);
		return url.toString();
	}

	function buildDetailHeaders(template) {
		// Prefer the exact headers the app sent (includes x-client-transaction-id,
		// x-client-uuid, language headers, etc.); fall back to a minimal set.
		var headers = {};
		var captured = template.headers || {};
		Object.keys(captured).forEach(function (key) {
			// Drop headers the browser must control itself.
			if (key === 'content-length' || key === 'host' || key === 'cookie') return;
			headers[key] = captured[key];
		});
		if (!headers.authorization) headers.authorization = WEB_BEARER;
		headers['x-csrf-token'] = getCookie('ct0');
		if (!headers['x-twitter-active-user']) headers['x-twitter-active-user'] = 'yes';
		if (!headers['x-twitter-auth-type']) headers['x-twitter-auth-type'] = 'OAuth2Session';
		if (!headers['content-type']) headers['content-type'] = 'application/json';
		return headers;
	}

	function fetchDetail(template, focalTweetId, cursor) {
		return fetch(buildDetailUrl(template, focalTweetId, cursor), {
			method: 'GET',
			credentials: 'include',
			headers: buildDetailHeaders(template)
		}).then(function (response) {
			if (!response.ok) {
				var error = new Error('TweetDetail HTTP ' + response.status);
				error.status = response.status;
				throw error;
			}
			return response.json();
		});
	}

	// ---------------------------------------------------------------------
	// Response parsing
	// ---------------------------------------------------------------------
	function unwrapTweetResult(result) {
		if (!result) return null;
		if (result.__typename === 'TweetWithVisibilityResults') return result.tweet || null;
		if (result.__typename && result.__typename !== 'Tweet') return null;
		return result;
	}

	function extractQuotedId(result, legacy) {
		var quoted = unwrapTweetResult(result.quoted_status_result && result.quoted_status_result.result);
		if (quoted && quoted.rest_id) return quoted.rest_id;
		return legacy.quoted_status_id_str || null;
	}

	function extractTweet(rawResult) {
		var result = unwrapTweetResult(rawResult);
		if (!result || !result.rest_id) return null;
		var legacy = result.legacy;
		if (!legacy) return null;

		var userResult = (result.core && result.core.user_results && result.core.user_results.result) || {};
		var userLegacy = userResult.legacy || {};
		var userCore = userResult.core || {};
		var handle = userCore.screen_name || userLegacy.screen_name || '';
		if (!handle) return null;

		var noteResult =
			result.note_tweet && result.note_tweet.note_tweet_results && result.note_tweet.note_tweet_results.result;
		var text = (noteResult && noteResult.text) || legacy.full_text || '';
		var urls =
			(noteResult && noteResult.entity_set && noteResult.entity_set.urls) ||
			(legacy.entities && legacy.entities.urls) ||
			[];
		urls.forEach(function (item) {
			if (item.url && item.expanded_url) text = text.split(item.url).join(item.expanded_url);
		});

		var mediaEntities =
			(legacy.extended_entities && legacy.extended_entities.media) ||
			(legacy.entities && legacy.entities.media) ||
			[];
		mediaEntities.forEach(function (item) {
			if (item.url) text = text.split(item.url).join('');
		});

		var media = [];
		mediaEntities.forEach(function (item) {
			var size = (item.original_info && {
				width: item.original_info.width,
				height: item.original_info.height
			}) || {};
			if (item.type === 'photo') {
				media.push({
					type: 'photo',
					url: item.media_url_https,
					thumb: item.media_url_https + '?name=small',
					alt: item.ext_alt_text || '',
					width: size.width,
					height: size.height
				});
				return;
			}
			var variants = ((item.video_info && item.video_info.variants) || [])
				.filter(function (variant) {
					return variant.content_type === 'video/mp4' && variant.url;
				})
				.sort(function (a, b) {
					return (b.bitrate || 0) - (a.bitrate || 0);
				});
			media.push({
				type: item.type,
				url: (variants[0] && variants[0].url) || item.media_url_https,
				thumb: item.media_url_https,
				alt: item.ext_alt_text || '',
				width: size.width,
				height: size.height
			});
		});

		var views = result.views && Number(result.views.count);

		return {
			id: result.rest_id,
			parentId: legacy.in_reply_to_status_id_str || null,
			userId: userResult.rest_id || '',
			handle: handle,
			name: userCore.name || userLegacy.name || '',
			avatar: (userResult.avatar && userResult.avatar.image_url) || userLegacy.profile_image_url_https || '',
			text: text.trim(),
			createdAt: legacy.created_at || '',
			likes: Number(legacy.favorite_count) || 0,
			retweets: Number(legacy.retweet_count) || 0,
			replies: Number(legacy.reply_count) || 0,
			quotes: Number(legacy.quote_count) || 0,
			views: isFinite(views) && views > 0 ? views : undefined,
			media: media,
			quotedId: extractQuotedId(result, legacy)
		};
	}

	function handleItemContent(itemContent, out) {
		if (!itemContent) return;
		var itemType = itemContent.itemType || itemContent.__typename;
		if (itemType === 'TimelineTweet') {
			var tweet = extractTweet(itemContent.tweet_results && itemContent.tweet_results.result);
			if (tweet) out.tweets.push(tweet);
		} else if (itemType === 'TimelineTimelineCursor') {
			if (itemContent.value && itemContent.cursorType !== 'Top') out.cursors.push(itemContent.value);
		}
	}

	function handleEntry(entry, out) {
		var content = entry && entry.content;
		if (!content) return;
		if (content.itemContent) {
			handleItemContent(content.itemContent, out);
		} else if (Array.isArray(content.items)) {
			content.items.forEach(function (wrapper) {
				handleItemContent(wrapper && wrapper.item && wrapper.item.itemContent, out);
			});
		}
	}

	function collectFromResponse(json, out) {
		var timeline =
			json &&
			json.data &&
			(json.data.threaded_conversation_with_injections_v2 || json.data.threaded_conversation_with_injections);
		var instructions = (timeline && timeline.instructions) || [];
		instructions.forEach(function (instruction) {
			(instruction.entries || []).forEach(function (entry) {
				handleEntry(entry, out);
			});
			if (instruction.entry) handleEntry(instruction.entry, out);
			(instruction.moduleItems || []).forEach(function (wrapper) {
				handleItemContent(wrapper && wrapper.item && wrapper.item.itemContent, out);
			});
		});
	}

	// Nudge X into issuing a TweetDetail request (scrolling triggers lazy reply
	// loads) and wait up to ~4s for the fetch/XHR hook to record a template.
	async function primeTweetDetail() {
		var startY = window.scrollY;
		for (var i = 0; i < 10; i++) {
			if (liveTemplate) break;
			window.scrollBy(0, i % 2 === 0 ? 800 : -600);
			await sleep(400);
		}
		window.scrollTo(0, startY);
	}

	// ---------------------------------------------------------------------
	// Capture: resumable breadth-first walk. Each not-yet-fetched tweet becomes
	// its own focal TweetDetail (like clicking "Show replies") — this runs even
	// when X reports reply_count = 0, because X under-reports and hides replies.
	// State persists across clicks so a rate-limited/partial run can be continued.
	// ---------------------------------------------------------------------
	var captureState = null; // set when a run ends with work remaining

	function makeCaptureState(focalTweetId) {
		var st = {
			focalTweetId: focalTweetId,
			tweetsById: {},
			childCount: {},
			seenCursors: {},
			visitedFocal: {},
			queuedFocal: {},
			queue: [{ focalTweetId: focalTweetId, cursor: null }],
			opUserId: null,
			rateLimited: false
		};
		st.queuedFocal[focalTweetId] = true;
		return st;
	}

	async function captureThread(focalTweetId, onProgress, resume) {
		var template = liveTemplate || templateFromResourceTiming();
		if (!template) {
			// Nudge X into issuing a fresh TweetDetail we can capture, then retry once.
			onProgress(0, 0);
			await primeTweetDetail();
			template = liveTemplate || templateFromResourceTiming();
		}
		if (!template) {
			throw new Error(
				'Could not observe a TweetDetail request. Scroll the thread (or click into the main tweet) so X loads the replies, then click again.'
			);
		}

		var st =
			resume && resume.focalTweetId === focalTweetId && resume.queue.length > 0
				? resume
				: makeCaptureState(focalTweetId);
		st.rateLimited = false;
		var hadTweets = Object.keys(st.tweetsById).length > 0;
		var requests = 0;

		function addTweet(tweet) {
			if (!st.tweetsById[tweet.id] && tweet.parentId) {
				st.childCount[tweet.parentId] = (st.childCount[tweet.parentId] || 0) + 1;
			}
			st.tweetsById[tweet.id] = tweet;
		}

		// Balance: only open a tweet's own "Show replies" page when it claims more
		// replies than we have already captured for it. This skips leaf tweets and
		// tweets whose replies we already have, keeping us well under the rate limit
		// while still surfacing hidden nested replies. OP's posts go first.
		function enqueueDeeperReplies() {
			Object.keys(st.tweetsById).forEach(function (id) {
				if (st.visitedFocal[id] || st.queuedFocal[id]) return;
				var tweet = st.tweetsById[id];
				if ((tweet.replies || 0) <= (st.childCount[id] || 0)) return;
				st.queuedFocal[id] = true;
				var job = { focalTweetId: id, cursor: null };
				if (st.opUserId && tweet.userId === st.opUserId) st.queue.unshift(job);
				else st.queue.push(job);
			});
		}

		while (st.queue.length > 0 && requests < MAX_REQUESTS) {
			while (paused) await sleep(300);
			var job = st.queue.shift();
			if (job.cursor) {
				if (st.seenCursors[job.cursor]) continue;
				st.seenCursors[job.cursor] = true;
			} else {
				if (st.visitedFocal[job.focalTweetId]) continue;
				st.visitedFocal[job.focalTweetId] = true;
			}

			requests += 1;
			var out = { tweets: [], cursors: [] };
			try {
				collectFromResponse(await fetchDetail(template, job.focalTweetId, job.cursor), out);
			} catch (error) {
				if (error && error.status === 429) {
					st.rateLimited = true;
					break;
				}
				if (requests === 1 && !hadTweets) throw error;
				continue;
			}

			out.tweets.forEach(addTweet);
			if (!st.opUserId && st.tweetsById[focalTweetId]) st.opUserId = st.tweetsById[focalTweetId].userId || null;
			out.cursors.forEach(function (cursor) {
				st.queue.push({ focalTweetId: job.focalTweetId, cursor: cursor });
			});
			enqueueDeeperReplies();

			onProgress(Object.keys(st.tweetsById).length, requests, st, focalTweetId);
			if (st.queue.length > 0 && requests < MAX_REQUESTS) await sleep(REQUEST_DELAY_MS);
		}

		var remaining = st.queue.length;
		var tweets = Object.keys(st.tweetsById).map(function (id) {
			return st.tweetsById[id];
		});
		if (tweets.length === 0) throw new Error('No tweets captured — is this thread visible to your account?');

		captureState = remaining > 0 ? st : null;

		return {
			payload: {
				type: MESSAGE_TYPE,
				version: 1,
				capturedAt: new Date().toISOString(),
				focusId: focalTweetId,
				partial: remaining > 0,
				tweets: tweets
			},
			remaining: remaining,
			rateLimited: Boolean(st.rateLimited)
		};
	}

	// ---------------------------------------------------------------------
	// Delivery: open the viewer and postMessage until it acks; fall back to
	// copying the JSON for manual paste.
	// ---------------------------------------------------------------------
	var viewerWindow = null;

	function deliverPayload(payload, onStatus) {
		// Reuse one named viewer tab across continued captures instead of piling up tabs.
		if (viewerWindow && !viewerWindow.closed) {
			try {
				viewerWindow.focus();
			} catch (e) {
				/* ignore */
			}
		} else {
			viewerWindow = window.open(VIEWER_ORIGIN + VIEWER_PATH, 'xtreeviewer');
		}
		var viewer = viewerWindow;
		var acked = false;

		function onMessage(event) {
			if (event.origin === VIEWER_ORIGIN && event.data && event.data.type === ACK_TYPE) {
				acked = true;
			}
		}
		window.addEventListener('message', onMessage);

		var started = Date.now();
		var timer = setInterval(function () {
			if (acked) {
				clearInterval(timer);
				window.removeEventListener('message', onMessage);
				onStatus('Sent to xtreeviewer ✓', false);
				return;
			}
			if (!viewer || viewer.closed || Date.now() - started > 20000) {
				clearInterval(timer);
				window.removeEventListener('message', onMessage);
				var json = JSON.stringify(payload);
				var copy = navigator.clipboard
					? navigator.clipboard.writeText(json)
					: Promise.reject(new Error('no clipboard'));
				copy.then(
					function () {
						onStatus('Copied JSON — paste it on ' + VIEWER_ORIGIN + VIEWER_PATH, false);
					},
					function () {
						console.log('[xtreeviewer] capture payload:', json);
						onStatus('Could not hand off; payload logged to console', true);
					}
				);
				return;
			}
			try {
				viewer.postMessage(payload, VIEWER_ORIGIN);
			} catch (e) {
				/* viewer still loading */
			}
		}, 400);
	}

	// ---------------------------------------------------------------------
	// Button UI
	// ---------------------------------------------------------------------
	var button = document.createElement('button');
	button.textContent = '🌳 xtreeviewer';
	button.setAttribute(
		'style',
		[
			'position:fixed',
			'bottom:18px',
			'right:18px',
			'z-index:99999',
			'padding:10px 14px',
			'border-radius:999px',
			'border:1px solid rgba(0,0,0,0.25)',
			'background:#fff',
			'color:#0f1419',
			'font:600 13px system-ui,sans-serif',
			'box-shadow:0 2px 10px rgba(0,0,0,0.25)',
			'cursor:pointer',
			'display:none'
		].join(';')
	);
	document.documentElement.appendChild(button);

	function setStatus(text, isError) {
		button.textContent = text;
		button.style.background = isError ? '#ffe2e0' : '#fff';
	}

	// ---------------------------------------------------------------------
	// Live tree panel: shows the captured posts as a nested tree while fetching.
	// ---------------------------------------------------------------------
	var panel = document.createElement('div');
	panel.setAttribute(
		'style',
		[
			'position:fixed',
			'bottom:64px',
			'right:18px',
			'z-index:99998',
			'width:360px',
			'max-height:60vh',
			'display:none',
			'flex-direction:column',
			'background:#fff',
			'color:#0f1419',
			'border:1px solid rgba(0,0,0,0.25)',
			'border-radius:12px',
			'box-shadow:0 4px 18px rgba(0,0,0,0.28)',
			'overflow:hidden',
			'font:12px system-ui,sans-serif'
		].join(';')
	);
	var panelHeader = document.createElement('div');
	panelHeader.setAttribute(
		'style',
		'padding:8px 10px;font-weight:700;border-bottom:1px solid rgba(0,0,0,0.12);display:flex;justify-content:space-between;align-items:center;gap:8px;'
	);
	var panelTitle = document.createElement('span');
	panelTitle.textContent = 'xtreeviewer';
	var panelTimer = document.createElement('span');
	panelTimer.setAttribute('style', 'margin-left:auto;font-weight:400;opacity:0.7;font-variant-numeric:tabular-nums;');
	var pauseBtn = document.createElement('span');
	pauseBtn.textContent = '⏸';
	pauseBtn.title = 'Pause fetching';
	pauseBtn.setAttribute('style', 'cursor:pointer;opacity:0.75;display:none;');
	pauseBtn.addEventListener('click', function () {
		if (!capturing) return;
		paused = !paused;
		if (paused) {
			pauseStartedAt = Date.now();
			pauseBtn.textContent = '▶';
			pauseBtn.title = 'Resume fetching';
			setStatus('⏸ Paused', false);
		} else {
			if (pauseStartedAt) pausedAccumMs += Date.now() - pauseStartedAt;
			pauseStartedAt = 0;
			pauseBtn.textContent = '⏸';
			pauseBtn.title = 'Pause fetching';
		}
	});
	var panelClose = document.createElement('span');
	panelClose.textContent = '✕';
	panelClose.setAttribute('style', 'cursor:pointer;opacity:0.6;');
	panelClose.addEventListener('click', function () {
		panel.style.display = 'none';
	});
	panelHeader.appendChild(panelTitle);
	panelHeader.appendChild(panelTimer);
	panelHeader.appendChild(pauseBtn);
	panelHeader.appendChild(panelClose);
	var panelNote = document.createElement('div');
	panelNote.setAttribute(
		'style',
		'padding:4px 10px;font-size:11px;border-bottom:1px solid rgba(0,0,0,0.08);display:none;'
	);
	var panelBody = document.createElement('div');
	panelBody.setAttribute('style', 'overflow:auto;padding:6px 8px;line-height:1.5;');
	panel.appendChild(panelHeader);
	panel.appendChild(panelNote);
	panel.appendChild(panelBody);
	document.documentElement.appendChild(panel);

	// ---------------------------------------------------------------------
	// Timers: elapsed capture time + rate-limit cooldown countdown.
	// ---------------------------------------------------------------------
	var captureStartTime = 0;
	var cooldownUntil = 0;

	function formatClock(ms) {
		var total = Math.max(0, Math.round(ms / 1000));
		var minutes = Math.floor(total / 60);
		var seconds = total % 60;
		return minutes > 0 ? minutes + ':' + (seconds < 10 ? '0' : '') + seconds : total + 's';
	}

	function activeElapsed() {
		var live = pauseStartedAt ? Date.now() - pauseStartedAt : 0;
		return Date.now() - captureStartTime - pausedAccumMs - live;
	}

	setInterval(function () {
		if (capturing && captureStartTime) {
			panelTimer.textContent = '⏱ ' + formatClock(activeElapsed()) + (paused ? ' ⏸' : '');
		}
		if (cooldownUntil) {
			var left = cooldownUntil - Date.now();
			panelNote.style.display = 'block';
			if (left > 0) {
				panelNote.innerHTML =
					'⏳ Rate-limited — you can Continue in <strong>' + formatClock(left) + '</strong>';
				panelNote.style.background = '#fff3cd';
			} else {
				cooldownUntil = 0;
				panelNote.innerHTML = '✅ Ready — click <strong>Continue</strong> to fetch more';
				panelNote.style.background = '#d4edda';
			}
		}
	}, 1000);

	function escapeHtml(text) {
		return String(text || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	function renderCaptureTree(state, focalId) {
		var tweetsById = state.tweetsById;
		var visitedFocal = state.visitedFocal || {};
		var queuedFocal = state.queuedFocal || {};
		var ids = Object.keys(tweetsById);

		// Pending = tweets queued for their own "Show replies" fetch but not yet done.
		var pendingFocal = 0;
		ids.forEach(function (id) {
			if (queuedFocal[id] && !visitedFocal[id]) pendingFocal += 1;
		});
		var queueLen = (state.queue && state.queue.length) || 0;
		panelTitle.textContent =
			'xtreeviewer · ' + ids.length + ' posts · ' + pendingFocal + ' queued';

		var nodes = {};
		ids.forEach(function (id) {
			nodes[id] = { tweet: tweetsById[id], children: [] };
		});
		var roots = [];
		ids.forEach(function (id) {
			var parentId = tweetsById[id].parentId;
			if (parentId && nodes[parentId]) nodes[parentId].children.push(nodes[id]);
			else roots.push(nodes[id]);
		});
		var byId = function (a, b) {
			return a.tweet.id.length - b.tweet.id.length || (a.tweet.id < b.tweet.id ? -1 : 1);
		};
		roots.sort(byId);

		var html = '';
		var render = function (node, depth) {
			node.children.sort(byId);
			var t = node.tweet;
			var snippet = (t.text || '').replace(/\s+/g, ' ').slice(0, 44);
			var isFocus = t.id === focalId;
			var pending = Boolean(queuedFocal[t.id]) && !visitedFocal[t.id];
			// ✓ = replies fetched (or a leaf with none), ⏳ = queued for fetching
			var marker = pending
				? '<span style="color:#e0a800;">⏳</span>'
				: '<span style="color:#00a67d;">✓</span>';
			html +=
				'<div style="padding-left:' +
				depth * 12 +
				'px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
				(isFocus ? 'font-weight:700;' : '') +
				(pending ? 'opacity:0.85;' : '') +
				'">' +
				marker +
				' <span style="color:#1d9bf0;">@' +
				escapeHtml(t.handle) +
				'</span> ' +
				'<span style="opacity:0.75;">' +
				escapeHtml(snippet) +
				'</span></div>';
			node.children.forEach(function (child) {
				render(child, depth + 1);
			});
		};
		roots.forEach(function (root) {
			render(root, 0);
		});
		if (queueLen > 0) {
			html +=
				'<div style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(0,0,0,0.15);opacity:0.7;">' +
				'Queue: ' +
				queueLen +
				' request(s) pending</div>';
		}
		panelBody.innerHTML = html || '<em style="opacity:0.6;">No posts yet…</em>';
	}

	var pendingLabel = null; // sticky button label for "continue" between runs

	button.addEventListener('click', async function () {
		if (capturing) return;
		var focalTweetId = currentStatusId();
		if (!focalTweetId) return;

		var resume = captureState && captureState.focalTweetId === focalTweetId ? captureState : null;
		capturing = true;
		paused = false;
		pausedAccumMs = 0;
		pauseStartedAt = 0;
		pauseBtn.textContent = '⏸';
		pauseBtn.title = 'Pause fetching';
		pauseBtn.style.display = 'inline';
		captureStartTime = Date.now();
		cooldownUntil = 0;
		panelNote.style.display = 'none';
		var verb = resume ? 'Continuing… ' : 'Capturing… ';
		setStatus(resume ? 'Continuing…' : 'Capturing…', false);
		panel.style.display = 'flex';
		if (!resume) panelBody.innerHTML = '<em style="opacity:0.6;">Starting…</em>';
		try {
			var result = await captureThread(
				focalTweetId,
				function (count, requestCount, state, focalId) {
					setStatus(verb + count + ' posts (' + requestCount + ' req)', false);
					if (state) renderCaptureTree(state, focalId);
				},
				resume
			);
			deliverPayload(result.payload, setStatus);
			panelTimer.textContent = '⏱ ' + formatClock(activeElapsed());
			if (result.remaining > 0) {
				pendingLabel = '⏭ Continue (' + result.remaining + ' left)';
				// After a hard rate-limit, X's TweetDetail budget resets on a ~15 min window.
				if (result.rateLimited) cooldownUntil = Date.now() + 15 * 60 * 1000;
			} else {
				pendingLabel = null;
				panelNote.style.display = 'none';
			}
		} catch (error) {
			console.error('[xtreeviewer]', error);
			setStatus(String((error && error.message) || error).slice(0, 80), true);
		} finally {
			capturing = false;
			paused = false;
			pauseBtn.style.display = 'none';
			setTimeout(function () {
				if (!capturing) setStatus(pendingLabel || '🌳 xtreeviewer', false);
			}, 8000);
		}
	});

	// x.com is a SPA; poll the location to toggle button visibility.
	setInterval(function () {
		button.style.display = currentStatusId() ? 'block' : 'none';
	}, 600);
})();
