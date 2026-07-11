import { getFullThread } from '../api/bluesky';
import type { BoardThread } from '../types/boardPlatform';

type WorkerIncomingMessage =
	| { type: 'start'; runId: number; taskIds: string[]; delayMs: number; maxConcurrent?: number }
	| { type: 'enqueue'; runId: number; taskIds: string[]; placement?: 'front' | 'back' }
	| { type: 'complete'; runId: number; taskId: string }
	| { type: 'pause'; runId: number }
	| { type: 'resume'; runId: number }
	| { type: 'stop'; runId: number }
	| { type: 'hydrate-thread'; requestId: number; uri: string };

type WorkerOutgoingMessage =
	| { type: 'run-task'; runId: number; taskId: string }
	| { type: 'idle'; runId: number }
	| { type: 'paused'; runId: number }
	| { type: 'resumed'; runId: number }
	| { type: 'stopped'; runId: number }
	| { type: 'thread-hydrated'; requestId: number; thread: BoardThread }
	| { type: 'thread-error'; requestId: number; error: string };

let activeRunId = 0;
let running = false;
let paused = false;
let maxConcurrent = 1;
const activeTaskIds = new Set<string>();
let queue: string[] = [];
let delayMs = 700;
let timer: ReturnType<typeof setTimeout> | null = null;

function post(message: WorkerOutgoingMessage) {
	self.postMessage(message);
}

function clearTimer() {
	if (!timer) return;
	clearTimeout(timer);
	timer = null;
}

function dispatchNext() {
	clearTimer();
	if (!running || paused) return;
	if (queue.length === 0) {
		if (activeTaskIds.size === 0) {
			running = false;
			post({ type: 'idle', runId: activeRunId });
		}
		return;
	}
	if (activeTaskIds.size >= maxConcurrent) return;
	const nextTaskId = queue.shift();
	if (!nextTaskId) return;
	activeTaskIds.add(nextTaskId);
	post({ type: 'run-task', runId: activeRunId, taskId: nextTaskId });
	if (queue.length > 0 && activeTaskIds.size < maxConcurrent) {
		timer = setTimeout(dispatchNext, delayMs);
	}
}

function scheduleNext(wait: boolean) {
	clearTimer();
	if (!running || paused) return;
	if (!wait) {
		dispatchNext();
		return;
	}
	timer = setTimeout(dispatchNext, delayMs);
}

function uniqueTaskIds(taskIds: string[]) {
	const seen = new Set<string>();
	return taskIds.filter((taskId) => {
		if (seen.has(taskId)) return false;
		seen.add(taskId);
		return true;
	});
}

function enqueueTaskIds(taskIds: string[], placement: 'front' | 'back' = 'back') {
	const nextTaskIds = uniqueTaskIds(taskIds).filter(
		(taskId) => !activeTaskIds.has(taskId) && !queue.includes(taskId)
	);
	if (nextTaskIds.length === 0) return;
	if (placement === 'front') {
		queue = [...nextTaskIds, ...queue];
	} else {
		queue.push(...nextTaskIds);
	}
}

async function hydrateThread(requestId: number, uri: string) {
	try {
		const thread = await getFullThread(uri);
		post({ type: 'thread-hydrated', requestId, thread });
	} catch (error) {
		post({
			type: 'thread-error',
			requestId,
			error: error instanceof Error ? error.message : 'Could not hydrate thread.'
		});
	}
}

function handleMessage(message: WorkerIncomingMessage) {
	if (message.type === 'hydrate-thread') {
		void hydrateThread(message.requestId, message.uri);
		return;
	}

	if (message.type === 'start') {
		clearTimer();
		activeRunId = message.runId;
		running = true;
		paused = false;
		activeTaskIds.clear();
		queue = uniqueTaskIds(message.taskIds);
		delayMs = Math.max(0, Math.round(message.delayMs));
		maxConcurrent = Math.max(1, Math.round(message.maxConcurrent ?? 1));
		scheduleNext(false);
		return;
	}

	if (message.runId !== activeRunId) return;

	if (message.type === 'enqueue') {
		enqueueTaskIds(message.taskIds, message.placement);
		scheduleNext(false);
		return;
	}

	if (message.type === 'complete') {
		if (activeTaskIds.delete(message.taskId)) {
			scheduleNext(true);
		}
		return;
	}

	if (message.type === 'pause') {
		paused = true;
		clearTimer();
		post({ type: 'paused', runId: activeRunId });
		return;
	}

	if (message.type === 'resume') {
		paused = false;
		post({ type: 'resumed', runId: activeRunId });
		scheduleNext(false);
		return;
	}

	if (message.type === 'stop') {
		clearTimer();
		running = false;
		paused = false;
		activeTaskIds.clear();
		queue = [];
		post({ type: 'stopped', runId: activeRunId });
	}
}

self.onmessage = (event: MessageEvent<WorkerIncomingMessage>) => {
	handleMessage(event.data);
};
