import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			// Pages strips `.html` (308 to the bare path); keep those bare paths off the worker too.
			// No `/films/*` splat: wrangler rejects it as overlapping the files `<all>` lists.
			routes: {
				include: ['/*'],
				exclude: ['<all>', '/films/treeviewer', '/films/parallelboard', '/films/repoviewer']
			}
		})
	}
};

export default config;
