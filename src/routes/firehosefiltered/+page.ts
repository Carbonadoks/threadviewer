import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	const query = url.searchParams.toString();
	const target = `/jetstreamfiltered${query ? `?${query}` : ''}${url.hash}`;
	throw redirect(307, target);
};
