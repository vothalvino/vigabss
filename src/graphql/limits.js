// =============================================================================
// VigaBSS 5.0 — GraphQL query limits (SEC-25)
// =============================================================================
// Every nested resolver issues its own SQL per parent row, and nothing bounded
// how deep, wide or aliased a query could be, so one request could fan out
// into an unbounded number of queries. These validation rules reject a
// document before execution when an operation nests selection sets deeper
// than MAX_DEPTH, selects more than MAX_FIELDS fields or uses more than
// MAX_ALIASES aliases (fragments are expanded, so they cannot hide either).
//
// The SPA's largest query nests 4 levels and selects 65 fields.
// =============================================================================

const { GraphQLError, Kind } = require('graphql');

const MAX_DEPTH = 6;
const MAX_FIELDS = 300;
const MAX_ALIASES = 15;

function measure(selectionSet, fragments, depth, seen, acc) {
  if (!selectionSet) return;
  acc.depth = Math.max(acc.depth, depth);
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      acc.fields += 1;
      if (sel.alias) acc.aliases += 1;
      measure(sel.selectionSet, fragments, depth + 1, seen, acc);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      measure(sel.selectionSet, fragments, depth, seen, acc);
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const name = sel.name.value;
      if (seen.has(name)) continue; // cycles are rejected by NoFragmentCycles
      const fragment = fragments[name];
      if (fragment) {
        seen.add(name);
        measure(fragment.selectionSet, fragments, depth, seen, acc);
        seen.delete(name);
      }
    }
  }
}

function queryLimitsRule(context) {
  const doc = context.getDocument();
  const fragments = Object.fromEntries(
    doc.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]),
  );
  return {
    OperationDefinition(node) {
      const acc = { depth: 0, fields: 0, aliases: 0 };
      measure(node.selectionSet, fragments, 1, new Set(), acc);
      const fail = (message) => context.reportError(new GraphQLError(message, { nodes: [node], extensions: { code: 'QUERY_TOO_COMPLEX' } }));
      if (acc.depth > MAX_DEPTH) fail(`Query is nested ${acc.depth} levels deep; the limit is ${MAX_DEPTH}`);
      if (acc.fields > MAX_FIELDS) fail(`Query selects ${acc.fields} fields; the limit is ${MAX_FIELDS}`);
      if (acc.aliases > MAX_ALIASES) fail(`Query uses ${acc.aliases} aliases; the limit is ${MAX_ALIASES}`);
    },
  };
}

module.exports = { queryLimitsRule, MAX_DEPTH, MAX_FIELDS, MAX_ALIASES };
