// Regenerates src/lib/data/imagenetLabels.ts from the label table that ships with
// @tensorflow-models/mobilenet, so the picker's strings always match what
// classify() returns. Run with: npm run imagenet:labels
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { IMAGENET_CLASSES } = require('@tensorflow-models/mobilenet/dist/imagenet_classes.js') as {
	IMAGENET_CLASSES: Record<number, string>;
};

const ids = Object.keys(IMAGENET_CLASSES)
	.map(Number)
	.sort((a, b) => a - b);

const body = ids.map((id) => `\t${JSON.stringify(IMAGENET_CLASSES[id])},`).join('\n');

const out = `// Generated from @tensorflow-models/mobilenet's imagenet_classes.js — the exact label
// strings MobileNet's classify() returns, indexed by class id. Regenerate with
// scripts/build-imagenet-labels.ts if the model package changes.

export const IMAGENET_LABELS: readonly string[] = [
${body}
];

export const IMAGENET_LABEL_COUNT = IMAGENET_LABELS.length;
`;

mkdirSync('src/lib/data', { recursive: true });
writeFileSync('src/lib/data/imagenetLabels.ts', out);
console.log(`wrote ${ids.length} labels to src/lib/data/imagenetLabels.ts`);
