export const DEFAULT_TAG_TEMPLATE = `Art: Shares or discusses a specific artwork, creative process, poetry, design, or visual experiment.
Interestingness: Offers a surprising, substantive observation or a thoughtful question worth discussing.
Insights: Explains a specific lesson, useful connection, or non-obvious idea with enough context to learn from it.
Builds: Shows a concrete tool, demo, prototype, or project and what it does.
Research: Shares a specific research finding, experiment, field note, or technical detail.`;

export type PostTag = { name: string; probability: number };
export type TagDefinition = { name: string; description: string };
export type TagResult = { id: string; eligible: number; tags: PostTag[] };

export function parseTagTemplate(template: string): TagDefinition[] {
	const lines = template.split('\n').map(line => line.trim()).filter(Boolean);
	if (!lines.length || lines.length > 10) throw new Error('Define between 1 and 10 tags, one per line.');
	const tags = lines.map(line => {
		const separator = line.indexOf(':');
		const name = line.slice(0, separator).trim();
		const description = line.slice(separator + 1).trim();
		if (separator < 1 || !description || name.length > 40 || description.length > 500)
			throw new Error('Use Tag: description on each line (name up to 40 characters, description up to 500).');
		return { name, description };
	});
	if (new Set(tags.map(tag => tag.name.toLowerCase())).size !== tags.length) throw new Error('Tag names must be unique.');
	return tags;
}

export function matchingTags(result: TagResult, threshold: number): PostTag[] {
	return result.tags.filter(tag => tag.probability >= threshold);
}
