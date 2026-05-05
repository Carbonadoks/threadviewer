import type { ThreadPost } from '$lib/types';

export type TownDialogueLine = {
	id: string;
	uri: string;
	text: string;
	createdAtLabel: string;
	permalink: string | null;
	linkedUrls: string[];
	embed?: ThreadPost['embed'];
};

export type TownNpcData = {
	id: string;
	did: string;
	handle: string;
	displayName: string;
	avatar: string | null;
	colorHex: string;
	lines: TownDialogueLine[];
};

export type TownPlayerIdentity = {
	displayName: string;
	handle: string;
	avatar: string | null;
	colorHex: string;
};

export type TownConversationState =
	| {
			mode: 'prompt';
			npc: TownNpcData;
			screenX: number;
			screenY: number;
			placement: 'above' | 'below';
			hint: string;
	  }
	| {
			mode: 'talk';
			npc: TownNpcData;
			line: TownDialogueLine;
			lineIndex: number;
			lineCount: number;
			screenX: number;
			screenY: number;
			placement: 'above' | 'below';
			hint: string;
	  };

export interface TownGameController {
	setPopulation(npcs: TownNpcData[]): Promise<void>;
	setPlayerIdentity(identity: TownPlayerIdentity | null): void;
	dispose(): void;
}
