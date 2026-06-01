// ==UserScript==
// @name         YouTube Low View Filter (Configurable)
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Filters low-view YouTube videos with hide/highlight test modes and on-page debug HUD.
// @author       Rupesh Ghimire | 
// @match        *://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    //------------------------------------------------------------------------------------------------------
    // Edit this part below
    //------------------------------------------------------------------------------------------------------

    const CONFIG = {
        // Minimum views required for a card to pass the filter.
        minViews: 1000,

        // Console logging and on-page HUD for testing.
        debug: false, // Set to false to disable all debug logging and the debug panel.
        showDebugPanel: false, // Shows a debug panel with stats and last action info.

        // 'hide' = remove cards, 'highlight' = keep video cards visible but mark them red to make sure script is working as intended.
        filterActionMode: 'hide',

        // Shorts controls. Might not work perfectly due to YouTube's dynamic shorts content
        hideShortsShelves: true,
        hideShortsCards: true,

        // If true, low-view live/upcoming cards are filtered too.
        hideLiveAndUpcoming: true,

        // If true, low-view recommendations on the watch page sidebar are filtered too.
        filterWatchPageRecommendations: true,

        // If true, filtering is disabled on subscription page (recommended to keep subscription feed unfiltered)
        disableOnSubscriptionPage: true,

        // Optional safety full-page rescan (ms). Set 0 to disable if page is unstable and jittery.
        safetyRescanMs: 15000
    };

    //------------------------------------------------------------------------------------------------------
    // Don't edit below unless you know what you're doing. 
    //------------------------------------------------------------------------------------------------------

    // Configuration validation
    (function validateConfig() {
        if (CONFIG.minViews < 0) {
            console.warn('[YT Low View Filter] minViews should be >= 0, defaulting to 1000');
            CONFIG.minViews = 1000;
        }
        
        if (CONFIG.safetyRescanMs < 0) {
            console.warn('[YT Low View Filter] safetyRescanMs should be >= 0, defaulting to 15000');
            CONFIG.safetyRescanMs = 15000;
        }
        
        if (!['hide', 'highlight'].includes(CONFIG.filterActionMode)) {
            console.warn('[YT Low View Filter] filterActionMode should be "hide" or "highlight", defaulting to "hide"');
            CONFIG.filterActionMode = 'hide';
        }
        
        if (CONFIG.debug && CONFIG.showDebugPanel) {
            console.log('[YT Low View Filter] Debug mode enabled with panel');
        }
    })();

    const INTERNAL = {
        scanDebounceMs: 120,
        panelUpdateDebounceMs: 120,
        mutationThrottleMs: 50
    };

    const DebugState = {
        scans: 0,
        processed: 0,
        hidden: 0,
        highlighted: 0,
        shown: 0,
        ignored: 0,
        unmatched: 0,
        lastAction: 'init',
        panel: null,
        panelTimer: null
    };

    const RENDERER_SELECTOR = [
        'yt-lockup-view-model',
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-compact-video-renderer',
        'ytd-compact-radio-renderer',
        'ytd-watch-card-compact-video-renderer',
        'ytd-playlist-panel-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-playlist-video-renderer'
    ].join(',');

    const CANDIDATE_TEXT_SELECTOR = [
        '#metadata-line',
        '#metadata-line span:nth-child(2)',
        '[aria-label*="view"]',
        '[aria-label*="views"]',
        '#video-title',
        '#video-title-link',
        '#details',
        'yt-formatted-string'
    ].join(',');

    const TITLE_LINK_SELECTOR = 'a#video-title-link, a#video-title, a.yt-lockup-metadata-view-model__title';

    const WATCH_RECOMMENDATION_CONTAINER_SELECTOR = 'ytd-watch-next-secondary-results-renderer, ytd-playlist-panel-renderer';

    // Pre-compile regex patterns for better performance
    const VIEW_WORDS = [
        'views?',
        'viewers?',
        'watching',
        'visualizaciones',
        'vistas',
        'vues',
        'aufrufe',
        'visualizzazioni',
        'weergaven',
        'visualizacoes',
        'просмотр(?:ов|а)?',
        '次观看',
        '次觀看',
        '回視聴'
    ].join('|');

    const SUFFIX_MULTIPLIERS = new Map([
        ['k', 1000],
        ['m', 1000000],
        ['b', 1000000000],
        ['thousand', 1000],
        ['million', 1000000],
        ['billion', 1000000000],
        ['tys', 1000],
        ['tis', 1000],
        ['tsd', 1000],
        ['mn', 1000000],
        ['mio', 1000000],
        ['тыс', 1000],
        ['тыс.', 1000],
        ['млн', 1000000],
        ['млн.', 1000000],
        ['млрд', 1000000000],
        ['млрд.', 1000000000]
    ]);

    const NO_VIEWS_REGEX = /\bno views\b/;
    const ARIA_SPLIT_REGEX = /\s*[•|]\s*/;
    const RAW_PART_REGEX = /^\d{1,3}(?:[.,\s]\d{3})+$|^\d+$/;
    const ENGLISH_VIEW_WATCH_REGEX = /\b(view|watch)\b/i;
    
    // Pre-compile regex patterns once
    const COMPACT_VIEW_REGEX = (function() {
        try {
            return new RegExp('(\\d+(?:[.,]\\d+)?)\\s*([a-zA-Z\u0400-\u04FF.]+)\\s*(?:' + VIEW_WORDS + ')', 'i');
        } catch (e) {
            console.error('[YT Low View Filter] Failed to compile COMPACT_VIEW_REGEX:', e);
            return /$/; // Match nothing
        }
    })();
    
    const RAW_VIEW_REGEX = (function() {
        try {
            return new RegExp('(\\d{1,3}(?:[.,\\s]\\d{3})+|\\d+)\\s*(?:' + VIEW_WORDS + ')', 'i');
        } catch (e) {
            console.error('[YT Low View Filter] Failed to compile RAW_VIEW_REGEX:', e);
            return /$/; // Match nothing
        }
    })();

    function log(...args) {
        if (!CONFIG.debug) {
            return;
        }

        console.log('[YT Low View Filter]', ...args);
    }

    function ensureDebugPanel() {
        if (!CONFIG.showDebugPanel) {
            return null;
        }

        // Check if panel already exists in DOM
        let existingPanel = document.getElementById('yt-low-view-filter-debug');
        if (existingPanel) {
            DebugState.panel = existingPanel;
            return existingPanel;
        }

        // Check if we have a panel reference that might be detached
        if (DebugState.panel && document.body.contains(DebugState.panel)) {
            return DebugState.panel;
        }

        const panel = document.createElement('div');
        panel.id = 'yt-low-view-filter-debug';
        panel.style.position = 'fixed';
        panel.style.right = '12px';
        panel.style.bottom = '12px';
        panel.style.zIndex = '999999';
        panel.style.background = 'rgba(15, 15, 15, 0.92)';
        panel.style.color = '#f1f1f1';
        panel.style.padding = '10px 12px';
        panel.style.border = '1px solid rgba(255, 255, 255, 0.18)';
        panel.style.borderRadius = '10px';
        panel.style.font = '12px/1.35 monospace';
        panel.style.minWidth = '260px';
        panel.style.maxWidth = '340px';
        panel.style.whiteSpace = 'pre-line';
        panel.style.pointerEvents = 'none';
        panel.style.boxShadow = '0 8px 28px rgba(0, 0, 0, 0.45)';

        document.body.appendChild(panel);
        DebugState.panel = panel;

        return panel;
    }

    function updateDebugPanel() {
        if (!CONFIG.debug || !CONFIG.showDebugPanel) {
            return;
        }

        if (DebugState.panelTimer !== null) {
            return;
        }

        DebugState.panelTimer = window.setTimeout(function () {
            DebugState.panelTimer = null;
            renderDebugPanel();
        }, INTERNAL.panelUpdateDebounceMs);
    }

    function renderDebugPanel() {
        const panel = ensureDebugPanel();
        if (!panel) {
            return;
        }

        panel.textContent = [
            'YT Low View Filter (TEST MODE)',
            'Min views: ' + CONFIG.minViews,
            'Mode: ' + CONFIG.filterActionMode,
            'Scans: ' + DebugState.scans,
            'Processed: ' + DebugState.processed,
            'Hidden: ' + DebugState.hidden,
            'Highlighted: ' + DebugState.highlighted,
            'Shown: ' + DebugState.shown,
            'Ignored: ' + DebugState.ignored,
            'No view match: ' + DebugState.unmatched,
            'Last: ' + DebugState.lastAction
        ].join('\n');
    }

    function clearHighlight(renderer) {
        if (renderer.dataset.ytLowViewHighlighted !== '1') {
            return;
        }

        renderer.style.removeProperty('outline');
        renderer.style.removeProperty('outline-offset');
        renderer.style.removeProperty('background');
        const badge = renderer.querySelector(':scope > .yt-low-view-badge');
        if (badge) {
            badge.remove();
        }

        renderer.dataset.ytLowViewHighlighted = '0';
    }

    function applyHighlight(renderer, reason) {
        if (renderer.dataset.ytLowViewHighlighted === '1') {
            return;
        }

        // Use requestAnimationFrame for smoother visual updates
        requestAnimationFrame(() => {
            renderer.style.setProperty('outline', '3px solid #ff4d4d', 'important');
            renderer.style.setProperty('outline-offset', '-2px', 'important');
            renderer.style.setProperty('background', 'rgba(255, 77, 77, 0.08)', 'important');

            const badge = document.createElement('div');
            badge.className = 'yt-low-view-badge';
            badge.textContent = 'Low views: ' + reason;
            badge.style.position = 'absolute';
            badge.style.top = '6px';
            badge.style.left = '6px';
            badge.style.zIndex = '9999';
            badge.style.background = '#ff4d4d';
            badge.style.color = '#ffffff';
            badge.style.font = '11px/1.2 monospace';
            badge.style.padding = '3px 6px';
            badge.style.borderRadius = '6px';
            badge.style.pointerEvents = 'none';

            // Make sure the badge can anchor inside the card.
            if (getComputedStyle(renderer).position === 'static') {
                renderer.style.setProperty('position', 'relative', 'important');
            }

            renderer.appendChild(badge);
            renderer.dataset.ytLowViewHighlighted = '1';
            DebugState.highlighted += 1;
            DebugState.lastAction = 'highlight ' + reason;
            updateDebugPanel();
        });
    }

    function clearHidden(renderer) {
        if (renderer.dataset.ytLowViewHidden !== '1') {
            return;
        }

        renderer.style.removeProperty('display');
        renderer.dataset.ytLowViewHidden = '0';
    }

    function normalizeText(text) {
        return String(text || '')
            .replace(/[\u00A0\u202F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function parseCompactNumber(rawNumber) {
        const value = parseFloat(String(rawNumber).replace(',', '.'));
        return Number.isFinite(value) ? value : null;
    }

    function parseGroupedInteger(rawNumber) {
        const digitsOnly = String(rawNumber).replace(/[^\d]/g, '');
        if (!digitsOnly) {
            return null;
        }

        const value = parseInt(digitsOnly, 10);
        return Number.isFinite(value) ? value : null;
    }

    function extractViewsFromText(text) {
        const normalized = normalizeText(text);
        if (!normalized) {
            return null;
        }

        if (NO_VIEWS_REGEX.test(normalized)) {
            return 0;
        }

        const compactMatch = normalized.match(COMPACT_VIEW_REGEX);
        if (compactMatch) {
            const base = parseCompactNumber(compactMatch[1]);
            const suffix = compactMatch[2].toLowerCase();
            const multiplier = SUFFIX_MULTIPLIERS.get(suffix);

            if (base !== null && multiplier) {
                return Math.round(base * multiplier);
            }
        }

        const rawMatch = normalized.match(RAW_VIEW_REGEX);
        if (rawMatch) {
            return parseGroupedInteger(rawMatch[1]);
        }

        const ariaParts = normalized.split(ARIA_SPLIT_REGEX);
        for (const part of ariaParts) {
            const rawPartMatch = part.match(RAW_PART_REGEX);
            if (rawPartMatch && ENGLISH_VIEW_WATCH_REGEX.test(normalized)) {
                return parseGroupedInteger(rawPartMatch[0]);
            }
        }

        return null;
    }

    function collectCandidateTexts(renderer) {
        const texts = new Set();

        const nodes = renderer.querySelectorAll(CANDIDATE_TEXT_SELECTOR);
        for (const node of nodes) {
            const ariaLabel = node.getAttribute && node.getAttribute('aria-label');
            const text = ariaLabel || node.textContent || '';
            const normalized = text.trim();
            if (normalized) {
                texts.add(normalized);
            }
        }

        const titleLink = renderer.querySelector(TITLE_LINK_SELECTOR);
        if (titleLink) {
            const aria = titleLink.getAttribute('aria-label');
            if (aria) {
                texts.add(aria);
            }

            const title = titleLink.getAttribute('title');
            if (title) {
                texts.add(title);
            }
        }

        const fullText = renderer.textContent || '';
        if (fullText.trim()) {
            texts.add(fullText);
        }

        return Array.from(texts);
    }

    function getDetectedViews(renderer) {
        const texts = collectCandidateTexts(renderer);
        let bestMatch = null;

        for (const text of texts) {
            const views = extractViewsFromText(text);
            if (views !== null && (bestMatch === null || views > bestMatch)) {
                bestMatch = views;
            }
        }

        return bestMatch;
    }

    function isShortsRenderer(renderer) {
        if (renderer.closest('ytd-reel-shelf-renderer')) {
            return true;
        }

        return renderer.querySelector('a[href*="/shorts/"]') !== null;
    }

    function isLiveOrUpcoming(renderer) {
        const text = normalizeText(renderer.textContent || '');
        return /\blive\b|\blive now\b|\bupcoming\b|\bpremiere\b|\bwatching\b/.test(text);
    }

    function isWatchRecommendationRenderer(renderer) {
        return renderer.closest(WATCH_RECOMMENDATION_CONTAINER_SELECTOR) !== null;
    }

    // Cached subscription page check
    let subscriptionPageCache = {
        value: null,
        timestamp: 0,
        cacheDuration: 1000 // Cache for 1 second
    };

    function isSubscriptionPage() {
        // Skip if disabled in config
        if (!CONFIG.disableOnSubscriptionPage) {
            return false;
        }

        // Check cache
        const now = Date.now();
        if (subscriptionPageCache.value !== null && 
            (now - subscriptionPageCache.timestamp) < subscriptionPageCache.cacheDuration) {
            return subscriptionPageCache.value;
        }

        // Check if current URL is the subscriptions page
        const url = window.location.href.toLowerCase();
        const isSubsPage = url.includes('/feed/subscriptions') || 
                          url.includes('/subscriptions') ||
                          document.querySelector('ytd-browse[page-subtype="subscriptions"]') !== null;

        // Update cache
        subscriptionPageCache.value = isSubsPage;
        subscriptionPageCache.timestamp = now;

        return isSubsPage;
    }

    function hideRenderer(renderer, reason) {
        if (renderer.dataset.ytLowViewHidden === '1') {
            return;
        }

        clearHighlight(renderer);
        
        // Use requestAnimationFrame for smoother visual updates
        requestAnimationFrame(() => {
            renderer.style.setProperty('display', 'none', 'important');
            renderer.dataset.ytLowViewHidden = '1';
            DebugState.hidden += 1;
            DebugState.lastAction = 'hide ' + reason;
            updateDebugPanel();
            log('Hidden:', reason, renderer);
        });
    }

    function showRenderer(renderer) {
        const wasHidden = renderer.dataset.ytLowViewHidden === '1';
        const wasHighlighted = renderer.dataset.ytLowViewHighlighted === '1';

        clearHidden(renderer);
        clearHighlight(renderer);

        if (!wasHidden && !wasHighlighted) {
            return;
        }

        DebugState.shown += 1;
        DebugState.lastAction = 'show';
        updateDebugPanel();
    }

    function restoreHiddenVideos() {
        // Find all videos hidden by this script and show them
        const hiddenRenderers = document.querySelectorAll('[data-yt-low-view-hidden="1"]');
        const highlightedRenderers = document.querySelectorAll('[data-yt-low-view-highlighted="1"]');
        
        let restoredCount = 0;
        
        for (const renderer of hiddenRenderers) {
            clearHidden(renderer);
            restoredCount++;
        }
        
        for (const renderer of highlightedRenderers) {
            clearHighlight(renderer);
            restoredCount++;
        }
        
        if (CONFIG.debug && restoredCount > 0) {
            log('Restored', restoredCount, 'videos on subscription page');
        }
    }

    function shouldIgnoreRenderer(renderer) {
        if (!renderer || !renderer.isConnected) {
            return true;
        }

        if (!CONFIG.hideShortsShelves && renderer.closest('ytd-reel-shelf-renderer')) {
            return true;
        }

        if (!CONFIG.hideShortsCards && isShortsRenderer(renderer)) {
            return true;
        }

        if (!CONFIG.hideLiveAndUpcoming && isLiveOrUpcoming(renderer)) {
            return true;
        }

        if (!CONFIG.filterWatchPageRecommendations && isWatchRecommendationRenderer(renderer)) {
            return true;
        }

        return false;
    }

    function processRenderer(renderer) {
        try {
            if (shouldIgnoreRenderer(renderer)) {
                DebugState.ignored += 1;
                return;
            }

            DebugState.processed += 1;

            const views = getDetectedViews(renderer);
            if (views === null) {
                DebugState.unmatched += 1;
                return;
            }

            if (views < CONFIG.minViews) {
                const reason = 'views=' + views;
                if (CONFIG.filterActionMode === 'highlight') {
                    clearHidden(renderer);
                    applyHighlight(renderer, reason);
                }
                else {
                    hideRenderer(renderer, reason);
                }
                return;
            }

            showRenderer(renderer);
        } catch (error) {
            if (CONFIG.debug) {
                console.error('[YT Low View Filter] Error processing renderer:', error, renderer);
            }
            DebugState.ignored += 1;
        }
    }

    function scan(root) {
        // Skip scanning on subscription page if configured
        if (CONFIG.disableOnSubscriptionPage && isSubscriptionPage()) {
            if (CONFIG.debug) {
                log('Skipping scan on subscription page');
            }
            // Restore any previously hidden videos on subscription page
            restoreHiddenVideos();
            return;
        }

        DebugState.scans += 1;
        const scope = root && root.querySelectorAll ? root : document;
        const renderers = scope.querySelectorAll(RENDERER_SELECTOR);

        for (const renderer of renderers) {
            processRenderer(renderer);
        }

        updateDebugPanel();
    }

    function processRendererSet(renderers) {
        // Skip processing on subscription page if configured
        if (CONFIG.disableOnSubscriptionPage && isSubscriptionPage()) {
            if (CONFIG.debug) {
                log('Skipping renderer set processing on subscription page');
            }
            return;
        }

        DebugState.scans += 1;

        for (const renderer of renderers) {
            if (renderer && renderer.isConnected) {
                processRenderer(renderer);
            }
        }

        updateDebugPanel();
    }

    let scanTimer = null;
    let scanFullRequested = false;
    const pendingRenderers = new Set();

    function enqueueRenderer(renderer) {
        if (renderer && renderer.isConnected) {
            pendingRenderers.add(renderer);
        }
    }

    function enqueueFromNode(node) {
        if (!(node instanceof Element)) {
            return;
        }

        if (node.matches(RENDERER_SELECTOR)) {
            enqueueRenderer(node);
        }

        const nestedRenderers = node.querySelectorAll(RENDERER_SELECTOR);
        for (const renderer of nestedRenderers) {
            enqueueRenderer(renderer);
        }

        // Metadata updates often happen under existing cards.
        const parentRenderer = node.closest(RENDERER_SELECTOR);
        if (parentRenderer) {
            enqueueRenderer(parentRenderer);
        }
    }

    function queueScan(options) {
        const request = options || {};
        if (request.full) {
            scanFullRequested = true;
        }

        if (request.renderer) {
            enqueueRenderer(request.renderer);
        }

        window.clearTimeout(scanTimer);
        scanTimer = window.setTimeout(function () {
            if (scanFullRequested) {
                scanFullRequested = false;
                pendingRenderers.clear();
                scan(document);
                return;
            }

            if (pendingRenderers.size > 0) {
                const currentBatch = Array.from(pendingRenderers);
                pendingRenderers.clear();
                processRendererSet(currentBatch);
            }
        }, INTERNAL.scanDebounceMs);
    }

    let mutationThrottleTimer = null;
    let pendingMutations = [];
    
    function processMutations() {
        mutationThrottleTimer = null;
        
        for (const mutation of pendingMutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    enqueueFromNode(node);
                }
            }

            if (mutation.type === 'characterData') {
                const targetNode = mutation.target && mutation.target.parentElement;
                if (targetNode) {
                    enqueueFromNode(targetNode);
                }
            }
        }
        
        pendingMutations = [];
        
        if (pendingRenderers.size > 0) {
            queueScan({});
        }
    }

    const observer = new MutationObserver(function (mutations) {
        pendingMutations.push(...mutations);
        
        if (mutationThrottleTimer === null) {
            mutationThrottleTimer = window.setTimeout(processMutations, INTERNAL.mutationThrottleMs);
        }
    });

    function startObserver() {
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function start() {
        renderDebugPanel();
        scan(document);
        startObserver();

        if (CONFIG.safetyRescanMs > 0) {
            window.setInterval(function () {
                queueScan({ full: true });
            }, CONFIG.safetyRescanMs);
        }
    }

    window.addEventListener('load', function () {
        queueScan({ full: true });
    }, { passive: true });

    window.addEventListener('yt-navigate-finish', function () {
        // Invalidate subscription page cache on navigation
        subscriptionPageCache.value = null;
        subscriptionPageCache.timestamp = 0;
        queueScan({ full: true });
    }, { passive: true });

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            queueScan({ full: true });
        }
    }, { passive: true });

    start();
})();
