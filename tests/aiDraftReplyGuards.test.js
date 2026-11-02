// =============================================================================
// GQL-04 — the GraphQL aiDraftReply has REST's guards
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(async () => [[{ id: 5 }]]) })); // the ticket is the org's
jest.mock('../src/models/AiPolicy', () => ({
  findByOrgId: jest.fn(async () => ({ enabled: 1, enabled_channels: JSON.stringify({ portal: true }) })),
}));

const { parse, validate, buildSchema } = require('graphql');
const { queryLimitsRule } = require('../src/graphql/limits');
const aiReplyService = require('../src/services/aiReplyService');
const resolvers = require('../src/graphql/resolvers');

test.each(['constructor', 'toString', '__proto__', 'telegram'])('channel %s is refused by the channel switch', async (channel) => {
  const result = await aiReplyService.generate({ orgId: 1, ticketId: 5, channel, inboundText: 'hola' });
  expect(result).toMatchObject({ skipped: true, reason: 'channel_disabled' });
});

test('the mutation validates its arguments like the REST endpoint', async () => {
  const spy = jest.spyOn(aiReplyService, 'generate').mockResolvedValue({ skipped: true });
  const mutation = resolvers.Mutation.aiDraftReply;
  await expect(mutation({}, { ticketId: 5, channel: 'constructor' }, { orgId: 1 })).rejects.toMatchObject({ statusCode: 422 });
  await expect(mutation({}, { ticketId: 5, inboundText: 'x'.repeat(20001) }, { orgId: 1 })).rejects.toMatchObject({ statusCode: 422 });
  expect(spy).not.toHaveBeenCalled();
  await mutation({}, { ticketId: 5, inboundText: 'hola', channel: 'portal' }, { orgId: 1 });
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test('one operation may request aiDraftReply only once', () => {
  const schema = buildSchema('type Query { ok: Int } type Mutation { aiDraftReply(ticketId: ID!): String }');
  const twice = parse('mutation { a: aiDraftReply(ticketId: 1) b: aiDraftReply(ticketId: 2) }');
  const once = parse('mutation { aiDraftReply(ticketId: 1) }');
  expect(validate(schema, twice, [queryLimitsRule]).map(e => e.message).join()).toMatch(/aiDraftReply once/);
  expect(validate(schema, once, [queryLimitsRule])).toEqual([]);
});
