export type RouteNavPage =
	| 'landing'
	| 'animations'
	| 'frontpage'
	| 'home'
	| 'threadviewer'
	| 'viewer2'
	| 'viewer2db'
	| 'twitterarchiveviewer'
	| 'semantic'
	| 'summary'
	| 'summary2'
	| 'blocked'
	| 'followinteraction'
	| 'followsearch'
	| 'mentions'
	| 'warg'
	| 'dialogue'
	| 'dialogue2'
	| 'chat'
	| 'board'
	| 'blog'
	| 'reader'
	| 'clock'
	| 'treeviewer'
	| 'xtreeviewer'
	| 'carousel'
	| 'town'
	| 'parallelboard'
	| 'mirrorboard'
	| 'whiteboard'
	| 'band'
	| 'loom'
	| 'bisk2bisk'
	| 'matrix'
	| 'matrix-feed'
	| 'abstractfeed'
	| 'atproideasio'
	| 'llm'
	| 'card'
	| 'autobattler'
	| 'superautobisks'
	| 'localstorage'
	| 'analyzer'
	| 'cluster'
	| 'toponomy'
	| 'wordcloud'
	| 'hashtag'
	| 'jetstreamfiltered'
	| 'handtracker'
	| 'handtrainer';

export type RouteNavContext = {
	current: RouteNavPage;
	threadUrl?: string | null;
	handle?: string | null;
	dialogueHandleA?: string | null;
	dialogueHandleB?: string | null;
	hideThreadTools?: boolean;
};

export type RouteNavRegistration = {
	register: (context: RouteNavContext) => () => void;
};

export const ROUTE_NAV_CONTEXT = Symbol('route-navigation');
