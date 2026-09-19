import { fetchQuotesForPost, getFullThread } from '../api/bluesky';
import { downloadQuoteThreads, type QuoteDownloadCommand, type QuoteDownloadEvent } from '../utils/treeQuoteLoader';

let result: Extract<QuoteDownloadEvent, { type: 'result' }> | undefined;
const post = (event: QuoteDownloadEvent) => self.postMessage(event);
self.onmessage = async ({ data }: MessageEvent<QuoteDownloadCommand>) => {
	if (data.type === 'publish') {
		if (result) post(result);
		return;
	}
	try {
		const posts = data.posts ?? (await fetchQuotesForPost(data.sourceUri, { limit: 100, fetchAll: true })).posts;
		let lastProgress = 0;
		const downloaded = await downloadQuoteThreads(posts, new Set([...data.skipUris, data.sourceUri]), getFullThread,
			(completed, total) => {
				if (completed !== total && Date.now() - lastProgress < 150) return;
				lastProgress = Date.now();
				post({ type: 'progress', completed, total });
			});
		result = { type: 'result', posts, ...downloaded };
		post({ type: 'ready', count: downloaded.threads.length, failed: downloaded.failed });
	} catch (error) {
		post({ type: 'error', error: error instanceof Error ? error.message : 'Could not download quotes.' });
	}
};
