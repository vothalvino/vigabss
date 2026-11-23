'use strict';
// A stand-in for an OLT's command line: a duplex stream that echoes what is
// typed, prints a scripted answer and then the prompt, like the real thing.
// `answers` maps a command to its output, or to a function (command) => output.
// Pagination and parameter hints are scripted with { pages: [...] } and
// { hint: '{ <cr>|... }:', output: '...' }.

const { Duplex } = require('stream');

const PAGER = "---- More ( Press 'Q' to break ) ----";

function scriptedOlt(answers, { hostname = 'MA5800-X7', banner = '\r\n  Huawei Integrated Access Software.\r\n' } = {}) {
  const typed = [];
  let mode = '>';
  let pending = null; // remaining pages, or the output held behind a hint
  const stream = new Duplex({
    read() {},
    write(chunk, _enc, done) {
      const text = chunk.toString('utf8');
      if (pending && pending.type === 'pages' && text === ' ') {
        const page = pending.pages.shift();
        stream.push(`\x1b[37D${page}\r\n`);
        if (pending.pages.length) stream.push(PAGER);
        else { pending = null; stream.push(`\r\n${hostname}${mode}`); }
        return done();
      }
      if (pending && pending.type === 'hint' && text === '\n') {
        const out = pending.output;
        pending = null;
        stream.push(`\r\n${out}\r\n\r\n${hostname}${mode}`);
        return done();
      }
      const command = text.replace(/\n$/, '');
      typed.push(command);
      stream.push(`${command}\r\n`);
      if (command === 'enable') mode = '#';
      let answer = Object.hasOwn(answers, command) ? answers[command] : "% Unknown command, the error locates at '^'";
      if (typeof answer === 'function') answer = answer(command);
      if (answer && typeof answer === 'object' && answer.pages) {
        const pages = [...answer.pages];
        stream.push(`${pages.shift()}\r\n`);
        if (pages.length) { pending = { type: 'pages', pages }; stream.push(PAGER); return done(); }
      } else if (answer && typeof answer === 'object' && answer.hint) {
        pending = { type: 'hint', output: answer.output };
        stream.push(answer.hint);
        return done();
      } else if (answer && typeof answer === 'object' && answer.ask) {
        stream.push(answer.ask);
        return done();
      } else {
        stream.push(`${String(answer).replace(/\n/g, '\r\n')}\r\n`);
      }
      stream.push(`\r\n${hostname}${mode}`);
      return done();
    },
  });
  // The banner and first prompt, as after a successful login.
  setImmediate(() => stream.push(`${banner}\r\n${hostname}${mode}`));
  return { stream, typed };
}

module.exports = { scriptedOlt, PAGER };
