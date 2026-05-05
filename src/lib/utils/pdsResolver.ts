const PLC_DIRECTORY = 'https://plc.directory';

/**
 * Resolve a DID to its PDS endpoint URL.
 * Supports did:plc (via plc.directory) and did:web.
 */
export async function resolvePds(did: string): Promise<string | null> {
	try {
		let docUrl: string;
		if (did.startsWith('did:plc:')) {
			docUrl = `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
		} else if (did.startsWith('did:web:')) {
			const host = did.slice('did:web:'.length).replace(/%3A/gi, ':');
			docUrl = `https://${host}/.well-known/did.json`;
		} else {
			return null;
		}

		const res = await fetch(docUrl);
		if (!res.ok) return null;

		const doc = await res.json();
		const services = doc?.service;
		if (!Array.isArray(services)) return null;

		const pds = services.find(
			(s: any) =>
				s?.id === '#atproto_pds' && s?.type === 'AtprotoPersonalDataServer' && typeof s?.serviceEndpoint === 'string'
		);

		return pds?.serviceEndpoint ?? null;
	} catch {
		return null;
	}
}
