import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	return Response.json(
		{
			error: 'deprecated_endpoint',
			message:
				'Streaming post fetch is deprecated. Use /meta, /chunk, /new, and /older endpoints.',
			did: params.did
		},
		{ status: 410 }
	);
};
