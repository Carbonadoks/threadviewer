import { redirect } from '@sveltejs/kit';

export const ssr = false;

export const load = ({ url }: { url: URL }) => {
	const query = url.searchParams.toString();
	const target = `/twitterarchiveviewer${query ? `?${query}` : ''}${url.hash}`;
	throw redirect(307, target);
};
