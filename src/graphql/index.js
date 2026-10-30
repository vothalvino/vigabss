// =============================================================================
// VigaBSS 5.0 — GraphQL Server Factory (P3.3)
// =============================================================================
// Creates a graphql-yoga server and exports it as an Express middleware.
//
// The middleware MUST be preceded by `authenticate` + `orgScope` so that
// ctx.user and ctx.orgId are available to every resolver.
//
// graphql-yoga v5 ships as a @whatwg-node/server adapter.  When used directly
// as Express middleware (`router.use('/graphql', authenticate, orgScope, yoga)`)
// Express calls `yoga(req, res, next)`, which triggers the adapter's
// `requestListener` path — the only path that both processes the query AND
// writes the Fetch `Response` back to the Node `ServerResponse`.
//
// Usage (app.js):
//   const graphqlMiddleware = require('./graphql');
//   v1.use('/graphql', authenticate, orgScope, graphqlMiddleware);
// =============================================================================

const { createYoga, createSchema } = require('graphql-yoga');
const typeDefs = require('./typeDefs');
const resolvers = require('./resolvers');
const { pubsub } = require('../services/pubsub');
const { getNullableType, isListType, isNonNullType } = require('graphql');
const { assertGraphqlPermission, graphqlHasPermission, gqlForbidden } = require('./authz');

// ---------------------------------------------------------------------------
// RBAC enforcement for GraphQL (parity with the REST requirePermission layer).
// The endpoint is mounted with only `authenticate` + `orgScope`, so without
// this every authenticated user — and any scope-limited API token — could read
// clients, invoices, payments, tickets and AI config, or run aiDraftReply.
// Each root field maps to the same permission slug its REST equivalent uses;
// the guard mirrors enforceTokenScopes + the global-access bypass +
// getPermissions (see authz.js). Wrapping happens here (not in resolvers.js) so
// the raw resolvers stay directly unit-testable.
// ---------------------------------------------------------------------------
const FIELD_PERMISSIONS = {
  Query: {
    client: ['clients.view'], clients: ['clients.view'],
    contract: ['contracts.view'],
    payment: ['payments.view'],
    invoice: ['invoices.view'], invoices: ['invoices.view'],
    ticket: ['tickets.view'], tickets: ['tickets.view'],
    aiPolicy: ['ai.policy.read'], aiReplyLogs: ['ai.policy.read'],
    aiProviders: ['ai.providers.read'], aiPhrases: ['ai.phrases.read'],
  },
  Mutation: {
    aiDraftReply: ['ai.reply.draft'],
  },
};

// Nested type fields that cross into another resource (SEC-06). A root guard
// alone let a clients.view-only principal read every invoice and payment via
// clients{invoices payments}. Each edge requires the slug of the REST route
// that serves the same data: GET /clients/:id/invoices (invoices.view),
// /clients/:id/contracts (contracts.view), /invoices/:id/payments and
// /payments/:id/allocations (payments.view), /devices (devices.view), and the
// owning client (clients.view). Fields that stay inside a resource the caller
// could only reach with its slug (Client.ledger/balance/contacts, Invoice.items,
// Contract.addons, Ticket.comments) need no extra guard.
//
// A denied nested field resolves to an empty list / null WITHOUT a GraphQL
// error: the SPA's graphql-request client uses errorPolicy 'none', so any error
// would blank the whole Client/Contract detail page for support and technician
// users who are entitled to the rest of it (audit GQL-07).
const NESTED_FIELD_PERMISSIONS = {
  Client: {
    contracts: ['contracts.view'],
    invoices: ['invoices.view'],
    payments: ['payments.view'],
    devices: ['devices.view'],
  },
  Contract: {
    client: ['clients.view'],
    invoices: ['invoices.view'],
    devices: ['devices.view'],
  },
  Invoice: {
    client: ['clients.view'],
    appliedPayments: ['payments.view'],
  },
  Payment: {
    client: ['clients.view'],
    allocations: ['payments.view'],
  },
  PaymentAllocation: {
    invoice: ['invoices.view'],
  },
  Ticket: {
    client: ['clients.view'],
  },
};

function deniedFieldValue(info) {
  const type = info.returnType;
  if (isNonNullType(type) && !isListType(getNullableType(type))) {
    // A non-null scalar/object cannot be silently withheld.
    throw gqlForbidden('Forbidden');
  }
  return isListType(getNullableType(type)) ? [] : null;
}

function guardResolvers(resolverMap) {
  const guarded = { ...resolverMap };
  for (const typeName of ['Query', 'Mutation']) {
    const perms = FIELD_PERMISSIONS[typeName];
    if (!perms || !resolverMap[typeName]) continue;
    const wrappedType = { ...resolverMap[typeName] };
    for (const [field, required] of Object.entries(perms)) {
      const orig = resolverMap[typeName][field];
      if (typeof orig !== 'function') continue;
      wrappedType[field] = async (parent, args, ctx, info) => {
        await assertGraphqlPermission(ctx, required);
        return orig(parent, args, ctx, info);
      };
    }
    guarded[typeName] = wrappedType;
  }
  for (const [typeName, perms] of Object.entries(NESTED_FIELD_PERMISSIONS)) {
    if (!resolverMap[typeName]) {
      throw new Error(`GraphQL nested guard: no resolvers for type ${typeName}`);
    }
    const wrappedType = { ...resolverMap[typeName] };
    for (const [field, required] of Object.entries(perms)) {
      const orig = resolverMap[typeName][field];
      // Fail loudly at boot rather than leave a guarded edge unwrapped (a
      // default resolver would read the raw row without any check).
      if (typeof orig !== 'function') {
        throw new Error(`GraphQL nested guard: ${typeName}.${field} has no resolver`);
      }
      wrappedType[field] = async (parent, args, ctx, info) => {
        if (!(await graphqlHasPermission(ctx, required))) return deniedFieldValue(info);
        return orig(parent, args, ctx, info);
      };
    }
    guarded[typeName] = wrappedType;
  }
  return guarded;
}

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers: guardResolvers(resolvers) }),

  // Build resolver context from the Express req included in the server context.
  // graphql-yoga's requestListener automatically sets { req, res } on the
  // server context, so req.user and req.orgId (set by Express middleware) are
  // available here.
  context: ({ req }) => ({
    user: req.user,
    orgId: req.orgId,
    pubsub,
  }),

  // Express handles routing — this entry-point covers all sub-paths.
  graphqlEndpoint: '*',

  // Disable the built-in logger; VigaBSS uses Pino.
  logging: false,
});

/**
 * Express middleware that delegates the full request/response cycle to
 * graphql-yoga.  Using `yoga.requestListener` (rather than
 * `yoga.handleNodeRequestAndResponse`) ensures the Fetch Response is actually
 * written back to the Node ServerResponse.
 */
function graphqlMiddleware(req, res, next) {
  try {
    yoga.requestListener(req, res);
  } catch (err) {
    next(err);
  }
}

module.exports = graphqlMiddleware;
// Exposed for tests (REST/GraphQL permission parity).
module.exports.guardResolvers = guardResolvers;
module.exports.FIELD_PERMISSIONS = FIELD_PERMISSIONS;
module.exports.NESTED_FIELD_PERMISSIONS = NESTED_FIELD_PERMISSIONS;
