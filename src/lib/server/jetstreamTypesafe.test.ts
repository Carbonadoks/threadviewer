import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTagRequest, parseTagResponse } from './jetstreamTypesafe';
import { parseTagTemplate, matchingTags } from '../utils/jetstreamTags';

const tags = parseTagTemplate('Art: Creative work\nInsights: A useful lesson');
const posts = [{ id: 'p1', text: 'An illustrated lesson', altText: ['A painting'] }, { id: 'p2', text: 'hello', altText: [] }];

test('independent questions reference the correct post and include tag meaning', () => {
	const request = buildTagRequest(posts, tags);
	assert.equal(Object.keys(request.questions).length, 6);
	assert.match(request.questions.p1_t0.instructions, /posts\[1\]/);
	assert.match(request.questions.p0_t1.instructions, /Insights/);
	assert.equal(request.questions.p0_t0.criteria?.true, 'Creative work');
	assert.deepEqual(request.state.posts[0].altText, ['A painting']);
});

test('multiple tags can match; unrelated posts remain isolated', () => {
	const values = [0.95, 0.9, 0.8, 0.95, 0.2, 0.1];
	const answers = Object.fromEntries(Object.keys(buildTagRequest(posts, tags).questions).map((key, i) => [key, { type: 'noul', noul: values[i] }]));
	const results = parseTagResponse({ answers }, posts, tags);
	assert.deepEqual(matchingTags(results[0], 0.75).map(tag => tag.name), ['Art', 'Insights']);
	assert.deepEqual(matchingTags(results[1], 0.75), []);
	assert.deepEqual(matchingTags(results[0], 0.85).map(tag => tag.name), ['Art']);
});

test('missing, wrongly typed, and out-of-range answers fail closed', () => {
	for (const value of [undefined, -1, 1.1, NaN, '0.9']) {
		assert.throws(() => parseTagResponse({ answers: { p0_eligible: { type: 'noul', noul: value } } }, posts, tags));
	}
	assert.throws(() => parseTagResponse(null, posts, tags));
});

test('tag definitions reject ambiguity and unbounded inputs', () => {
	for (const template of ['', 'Art', 'Art:', 'Art: a\nart: b', Array(11).fill('Art: a').join('\n')]) assert.throws(() => parseTagTemplate(template));
	assert.deepEqual(parseTagTemplate('Art: Painting: watercolor'), [{ name: 'Art', description: 'Painting: watercolor' }]);
});
