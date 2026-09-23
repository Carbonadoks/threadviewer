import { getFullThread } from '../api/bluesky';
import type { BoardThread } from '../types/boardPlatform';

// Loads and parses whole conversations off the main thread for the parallel board.
// Request pacing lives on the board (its shared request queue), not here.

type WorkerIncomingMessage =
	| { type: 'hydrate-thread'; requestId: number; uri: string }
	| { type: 'cancel-hydrate'; requestId: number };

type WorkerOutgoingMessage =
	| { type: 'thread-hydrated'; requestId: number; thread: BoardThread }
	| { type: 'thread-error'; requestId: number; error: string; status?: number; aborted?: boolean };

function post(message: WorkerOutgoingMessage) {
	self.postMessage(message);
}

const hydrationControllers = new Map<number, AbortController>();

async function hydrateThread(requestId: number, uri: string) {
	const controller = new AbortController();
	hydrationControllers.set(requestId, controller);
	try {
		const thread = await getFullThread(uri, { signal: controller.signal });
		post({ type: 'thread-hydrated', requestId, thread });
	} catch (error) {
		const status = Number((error as { status?: unknown } | null)?.status);
		post({
			type: 'thread-error',
			requestId,
			error: error instanceof Error ? error.message : 'Could not hydrate thread.',
			status: Number.isFinite(status) && status > 0 ? status : undefined,
			aborted: controller.signal.aborted
		});
	} finally {
		hydrationControllers.delete(requestId);
	}
}

self.onmessage = (event: MessageEvent<WorkerIncomingMessage>) => {
	const message = event.data;
	if (message.type === 'hydrate-thread') {
		void hydrateThread(message.requestId, message.uri);
	} else if (message.type === 'cancel-hydrate') {
		hydrationControllers.get(message.requestId)?.abort();
	}
};
