'use strict';
// =============================================================================
// The scheduled_tasks rows a fresh install ends up with (ASY-35)
// =============================================================================
// Replays the INSERT, UPDATE and DELETE statements on scheduled_tasks from SQL text, in
// order: the baseline and every later migration for a migrated install, or
// schema.sql. Only literal
// values and `task_name = ... / IN (...)` filters are understood; anything else
// throws, so a new seed shape is noticed instead of silently skipped.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { listMigrationFiles } = require('../../src/utils/migrationFiles');

const ROOT = path.join(__dirname, '..', '..', 'database');

// Drop -- and /* */ comments, but not their look-alikes inside strings.
function stripComments(sql) {
  let out = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === '\\') out += sql[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '\'' || c === '"') {
      quote = c;
      out += c;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}

// Split on `sep` outside quotes and parentheses.
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote && text[i + 1] === quote) i++;
      else if (c === quote) quote = null;
    } else if (c === '\'' || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

function literal(token) {
  const t = token.trim();
  if (/^'.*'$/s.test(t)) return t.slice(1, -1).replace(/''/g, '\'').replace(/\\'/g, '\'');
  if (/^null$/i.test(t)) return null;
  if (/^(true|1)$/i.test(t)) return 1;
  if (/^(false|0)$/i.test(t)) return 0;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^JSON_(OBJECT|ARRAY)\(/i.test(t) || /^(NOW|CURRENT_TIMESTAMP)(\(\))?$/i.test(t)) return t; // payloads and timestamps, kept as text
  throw new Error(`Not a literal in a scheduled_tasks statement: ${t}`);
}

// The parenthesized groups of `VALUES (...), (...)`.
function tuples(text) {
  return splitTop(text, ',').map((group) => {
    const m = /^\(([\s\S]*)\)$/.exec(group.trim());
    if (!m) throw new Error(`Unexpected VALUES group: ${group.slice(0, 80)}`);
    return splitTop(m[1], ',');
  });
}

// Drop EXISTS (...) subqueries: their task_name is not the row being updated.
// Their conditions hold on a fresh install, which is what is replayed here.
function withoutSubqueries(where) {
  let out = where;
  for (let at = out.search(/\bEXISTS\s*\(/i); at !== -1; at = out.search(/\bEXISTS\s*\(/i)) {
    let i = out.indexOf('(', at);
    let depth = 0;
    for (; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')' && --depth === 0) break;
    }
    out = `${out.slice(0, at)}TRUE${out.slice(i + 1)}`;
  }
  return out;
}

function taskFilter(rawWhere) {
  const where = withoutSubqueries(rawWhere);
  const one = /task_name\s*=\s*'([^']+)'/i.exec(where);
  if (one) return [one[1]];
  const many = /task_name\s+IN\s*\(([^)]*)\)/i.exec(where);
  if (many) return splitTop(many[1], ',').map(literal);
  return null;
}

function apply(rows, statement) {
  const insert = /^INSERT\s+(?:IGNORE\s+)?INTO\s+`?scheduled_tasks`?\s*\(([^)]*)\)\s*([\s\S]*)$/i.exec(statement);
  if (insert) {
    const columns = insert[1].split(',').map(c => c.trim().replace(/`/g, ''));
    const rest = insert[2].trim();
    let valueLists;
    if (/^VALUES/i.test(rest)) {
      valueLists = tuples(rest.replace(/^VALUES/i, '').replace(/\s+ON\s+DUPLICATE\s+KEY[\s\S]*$/i, ''));
    } else if (/^SELECT/i.test(rest)) {
      const select = rest.replace(/^SELECT/i, '');
      // The first FROM or WHERE outside a string ends the select list.
      const masked = select.replace(/'(?:[^'\\]|\\.|'')*'/g, m => ' '.repeat(m.length));
      const fromAt = masked.search(/\b(FROM|WHERE)\b/i);
      valueLists = [splitTop(fromAt === -1 ? select : select.slice(0, fromAt), ',')];
    } else {
      throw new Error(`Unexpected scheduled_tasks INSERT: ${statement.slice(0, 120)}`);
    }
    for (const values of valueLists) {
      const row = Object.fromEntries(columns.map((c, i) => [c, literal(values[i])]));
      const key = `${row.task_name}|${row.organization_id ?? ''}`;
      if (!rows.has(key)) rows.set(key, { is_enabled: 1, organization_id: null, ...row });
    }
    return;
  }
  const update = /^UPDATE\s+`?scheduled_tasks`?\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(statement);
  if (update) {
    const names = taskFilter(update[2]);
    if (!names) return; // a column backfill (task_type = '' etc.), not a per-task change
    const changes = splitTop(update[1], ',').map((assignment) => {
      const [column, value] = assignment.split(/=(.*)/s);
      return [column.trim(), literal(value)];
    });
    for (const row of rows.values()) {
      if (names.includes(row.task_name)) for (const [column, value] of changes) row[column] = value;
    }
    return;
  }
  const remove = /^DELETE\s+FROM\s+`?scheduled_tasks`?\s+WHERE\s+([\s\S]*)$/i.exec(statement);
  if (remove) {
    const names = taskFilter(remove[1]);
    if (!names) throw new Error(`Unexpected scheduled_tasks DELETE: ${statement.slice(0, 120)}`);
    for (const [key, row] of rows) if (names.includes(row.task_name)) rows.delete(key);
  }
}

function replay(sqlTexts) {
  const rows = new Map();
  for (const sql of sqlTexts) {
    for (const statement of splitTop(stripComments(sql), ';')) {
      if (/^(INSERT\s+(IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+`?scheduled_tasks`?/i.test(statement)) apply(rows, statement);
    }
  }
  return [...rows.values()];
}

function migratedSeeds() {
  const dir = path.join(ROOT, 'migrations');
  return replay(listMigrationFiles(dir).map(file => fs.readFileSync(path.join(dir, file), 'utf8')));
}

function schemaSeeds() {
  return replay([fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')]);
}

module.exports = { migratedSeeds, schemaSeeds, replay };
