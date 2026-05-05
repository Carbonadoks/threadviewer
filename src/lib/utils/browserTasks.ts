type IdleCapableWindow = Window & {
	requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
	cancelIdleCallback?: (handle: number) => void;
};

type IntersectionCapableWindow = Window & {
	IntersectionObserver?: typeof IntersectionObserver;
};

export function scheduleDeferredBrowserTask(
	callback: () => void,
	options: { timeout?: number } = {}
): () => void {
	if (typeof window === 'undefined') {
		return () => {};
	}

	const idleWindow = window as IdleCapableWindow;
	if (typeof idleWindow.requestIdleCallback === 'function') {
		const handle = idleWindow.requestIdleCallback(callback, {
			timeout: options.timeout ?? 200
		});
		return () => idleWindow.cancelIdleCallback?.(handle);
	}

	const handle = window.setTimeout(callback, 0);
	return () => window.clearTimeout(handle);
}

export function observeElementOnceVisible(
	element: Element | null,
	callback: () => void,
	options: { rootMargin?: string } = {}
): () => void {
	if (typeof window === 'undefined' || !element) {
		return () => {};
	}

	const observerWindow = window as IntersectionCapableWindow;
	if (typeof observerWindow.IntersectionObserver !== 'function') {
		callback();
		return () => {};
	}

	let hasTriggered = false;
	const observer = new observerWindow.IntersectionObserver(
		(entries) => {
			if (hasTriggered) return;
			if (!entries.some((entry) => entry.isIntersecting)) return;
			hasTriggered = true;
			callback();
			observer.disconnect();
		},
		{
			rootMargin: options.rootMargin ?? '240px 0px'
		}
	);

	observer.observe(element);
	return () => observer.disconnect();
}
