import type { SelfReplyThread } from './index';

export type AtproideasioStatus = 'todo' | 'in_progress' | 'done';
export type AtproideasioPriority = 'low' | 'medium' | 'high';

export interface AtproideasioIssueDraft {
	title: string;
	userStory: string;
	description: string;
	acceptanceCriteria: string;
	notes: string;
	status: AtproideasioStatus;
	priority: AtproideasioPriority;
}

export interface AtproideasioThread extends SelfReplyThread {
	isTruncated?: boolean;
}

export interface AtproideasioAiSummary {
	provider: 'openrouter';
	model: string;
	promptVersion: string;
	title: string;
	summary: string;
	generatedAt: string;
	inputPostCount: number;
}

export interface AtproideasioIdeaClaim {
	claimedBy: string;
	claimedAt: string;
}

export interface AtproideasioCandidateState {
	saved: boolean;
	improved: boolean;
}

export interface AtproideasioCandidate {
	id: string;
	taggedPostUri: string;
	sourceUrl: string | null;
	thread: AtproideasioThread;
	includedUris: string[];
	issue: AtproideasioIssueDraft;
	fetchedAt: string;
	ai?: AtproideasioAiSummary;
	state?: AtproideasioCandidateState;
}

export interface AtproideasioSourcePost {
	uri: string;
	authorHandle: string;
	authorDisplayName?: string;
	text: string;
	createdAt: string;
}

export interface AtproideasioSavedIdea extends AtproideasioIssueDraft {
	id: string;
	rootUri: string;
	taggedPostUri: string;
	sourceUrl: string | null;
	keptPostUris: string[];
	sourcePosts: AtproideasioSourcePost[];
	postCount: number;
	authorHandle: string;
	authorDisplayName?: string;
	createdAt: string;
	updatedAt: string;
	claim?: AtproideasioIdeaClaim;
	ai?: AtproideasioAiSummary;
}

export interface AtproideasioIngestStats {
	startedAt: string;
	finishedAt: string;
	searchPages: number;
	taggedPosts: number;
	hitsTotal: number | null;
	candidatesBefore: number;
	candidatesAfter: number;
	newCandidates: number;
	reusedCandidates: number;
	threadFetches: number;
	threadFailures: number;
	stoppedReason: string;
}

export interface AtproideasioSnapshot {
	version: 1;
	tag: string;
	updatedAt: string;
	candidates: AtproideasioCandidate[];
	stats: AtproideasioIngestStats | null;
	warnings: string[];
}

export interface AtproideasioBoardResponse extends AtproideasioSnapshot {
	missing: boolean;
}

export interface AtproideasioSavedStories {
	version: 1;
	updatedAt: string;
	stories: AtproideasioSavedIdea[];
}
