/// <reference types="@sveltejs/kit" />
/// <reference types="@cloudflare/workers-types" />

declare namespace App {
	interface Platform {
		env: {
			POST_CACHE: R2Bucket;
			AI: Ai;
			FETCH?: '0' | '1';
			GEMINI_API_KEY?: string;
		};
		context: ExecutionContext;
	}
}
