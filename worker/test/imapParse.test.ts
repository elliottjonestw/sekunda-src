import assert from "node:assert/strict";
import { test } from "node:test";
import { ICLOUD_IMAP, MAIL_MAX_RESULTS, mailOpSchema } from "@secondbrain/shared";
import {
  chooseTextPart, parseBodyStructure, parseExamine, parseFetch, parseStatus, parseTokens,
} from "../src/imapParse";

/**
 * BODYSTRUCTURE, against responses shaped like the ones iCloud actually sends.
 *
 * This is the most intricate thing in IMAP and it is written twice — here and
 * in `src-tauri/src/mail.rs`, which carries the same cases as `#[test]`s. The
 * two must agree, because a desktop build and a web build that disagree about
 * which part is the body show different emails for the same click.
 *
 * Deliberately not in `worker/src`: that directory is typechecked with only
 * `@cloudflare/workers-types`, so `node:test` does not exist there. Run with
 * `npm test -w @secondbrain/worker`.
 */

/** The token tree of one bracketed BODYSTRUCTURE value. */
function structure(text: string) {
  return parseTokens(text, 0).items[0];
}

const TEXT_PLAIN = '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 1234 30 NIL NIL NIL NIL)';
const TEXT_HTML = '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 5678 90 NIL NIL NIL NIL)';
const PDF =
  '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 10485760 NIL ' +
  '("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL)';

test("a plain message is one part, numbered 1", () => {
  const parts = parseBodyStructure(structure(TEXT_PLAIN));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].part, "1");
  assert.equal(parts[0].type, "text");
  assert.equal(parts[0].subtype, "plain");
  assert.equal(parts[0].encoding, "quoted-printable");
  assert.equal(parts[0].params.charset, "utf-8");
  assert.equal(parts[0].size, 1234);
  assert.equal(parts[0].disposition, null);
});

test("multipart children are numbered, and the multipart itself is not a part", () => {
  const parts = parseBodyStructure(
    structure(`((${TEXT_PLAIN}${TEXT_HTML} "ALTERNATIVE" ("BOUNDARY" "abc") NIL NIL NIL)${PDF} ` +
      '"MIXED" ("BOUNDARY" "def") NIL NIL NIL)'),
  );
  assert.deepEqual(parts.map((p) => p.part), ["1.1", "1.2", "2"]);
  assert.deepEqual(parts.map((p) => `${p.type}/${p.subtype}`), [
    "text/plain",
    "text/html",
    "application/pdf",
  ]);
});

test("an attachment's true size and name come off the structure, not the bytes", () => {
  const parts = parseBodyStructure(structure(`(${TEXT_PLAIN}${PDF} "MIXED" ("BOUNDARY" "d") NIL NIL NIL)`));
  const pdf = parts[1];
  assert.equal(pdf.disposition, "attachment");
  assert.equal(pdf.filename, "report.pdf");
  // The whole point: 10 MB is known without a byte of it crossing the wire.
  assert.equal(pdf.size, 10_485_760);
});

test("the text part is chosen by TYPE, never by position", () => {
  // HTML first — the ordering that made the old walker return the flattened
  // markup when a readable plain part was sitting right behind it.
  const parts = parseBodyStructure(
    structure(`(${TEXT_HTML}${TEXT_PLAIN} "ALTERNATIVE" ("BOUNDARY" "a") NIL NIL NIL)`),
  );
  assert.equal(chooseTextPart(parts)?.part, "2");
  assert.equal(chooseTextPart(parts)?.subtype, "plain");
});

test("an HTML-only message still has a text part", () => {
  const parts = parseBodyStructure(structure(`(${TEXT_HTML} "ALTERNATIVE" ("BOUNDARY" "a") NIL NIL NIL)`));
  assert.equal(chooseTextPart(parts)?.subtype, "html");
});

test("a message of nothing but attachments has no text part", () => {
  const parts = parseBodyStructure(structure(`(${PDF}${PDF} "MIXED" ("BOUNDARY" "a") NIL NIL NIL)`));
  assert.equal(chooseTextPart(parts), null);
});

test("an attached email is listed AND looked inside", () => {
  const nested = `(${TEXT_PLAIN}${TEXT_HTML} "ALTERNATIVE" ("BOUNDARY" "in") NIL NIL NIL)`;
  const rfc822 =
    '("MESSAGE" "RFC822" ("NAME" "fwd.eml") NIL NIL "7BIT" 4321 ' +
    '("Tue, 21 Jul 2026 10:00:00 +0800" "Fwd" NIL NIL NIL NIL NIL NIL NIL NIL) ' +
    `${nested} 50 NIL ("ATTACHMENT" ("FILENAME" "fwd.eml")) NIL NIL)`;
  const parts = parseBodyStructure(
    structure(`(${TEXT_PLAIN}${rfc822} "MIXED" ("BOUNDARY" "out") NIL NIL NIL)`),
  );

  assert.deepEqual(parts.map((p) => p.part), ["1", "2", "2.1", "2.2"]);
  assert.equal(parts[1].filename, "fwd.eml");
  // The attached message is a part of THIS message, so it is not embedded —
  // what is embedded is everything inside it, which is what keeps the forwarded
  // email's body from being shown as this email's body.
  assert.deepEqual(parts.map((p) => p.embedded), [false, false, true, true]);
  assert.equal(chooseTextPart(parts)?.part, "1");
});

test("an attached email's text is the fallback when there is no other", () => {
  const nested = TEXT_PLAIN;
  const rfc822 =
    '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 4321 ' +
    '("date" "subj" NIL NIL NIL NIL NIL NIL NIL NIL) ' +
    `${nested} 50 NIL NIL NIL NIL)`;
  const parts = parseBodyStructure(structure(`(${PDF}${rfc822} "MIXED" ("BOUNDARY" "o") NIL NIL NIL)`));
  assert.deepEqual(parts.map((p) => p.part), ["1", "2", "2.1"]);
  assert.equal(chooseTextPart(parts)?.part, "2.1");
});

test("BODY[…] keys are told apart by specificity", () => {
  const headers = "Subject: Hi\r\n\r\n";
  const part = "SGVsbG8=";
  const lines = [
    `* 7 FETCH (UID 991 FLAGS (\\Seen) RFC822.SIZE 900000 ` +
    `BODY[HEADER.FIELDS (DATE SUBJECT)] {${headers.length}}${headers} ` +
    `BODYSTRUCTURE (${TEXT_PLAIN}${PDF} "MIXED" ("BOUNDARY" "d") NIL NIL NIL))`,
    `* 7 FETCH (UID 991 BODY[1]<0> {${part.length}}${part})`,
  ];
  const [head, body] = parseFetch(lines);
  assert.equal(head.headers, headers);
  assert.equal(head.raw, undefined);
  assert.deepEqual(head.structure?.map((p) => p.part), ["1", "2"]);
  assert.equal(body.partBody, part);
  assert.equal(body.raw, undefined);
});

test("a whole-message fetch is still raw, not a part", () => {
  const raw = "Subject: Hi\r\n\r\nhello (world) {not a literal}";
  const [msg] = parseFetch([`* 1 FETCH (UID 5 BODY[]<0> {${raw.length}}${raw})`]);
  assert.equal(msg.raw, raw);
  assert.equal(msg.partBody, undefined);
});

test("EXAMINE volunteers the freshness baseline for free", () => {
  const seen = parseExamine([
    "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)",
    "* 1204 EXISTS",
    "* 0 RECENT",
    "* OK [UIDVALIDITY 1517159100] UIDs valid",
    "* OK [UIDNEXT 9931] Predicted next UID",
    // A count of unseen messages is what this LOOKS like and is not what it
    // is — EXAMINE reports the sequence number of the first unseen message.
    // Reading it as a count gives a plausible wrong number.
    "* OK [UNSEEN 1198] First unseen",
  ]);
  assert.deepEqual(seen, { uidnext: 9931, exists: 1204, uidvalidity: 1_517_159_100 });
  assert.deepEqual(parseExamine(["* OK [READ-ONLY]"]), { uidnext: 0, exists: 0, uidvalidity: 0 });
});

test("STATUS is read by its pairs, not by its mailbox name", () => {
  assert.deepEqual(
    parseStatus(['* STATUS "INBOX" (MESSAGES 1204 UIDNEXT 9931 UNSEEN 3 UIDVALIDITY 1517159100)']),
    { uidnext: 9931, messages: 1204, unseen: 3, uidvalidity: 1_517_159_100 },
  );
  // A non-ASCII mailbox comes back in the server's own modified UTF-7 and its
  // own quoting, so matching it against what we sent rejects a correct answer.
  assert.equal(parseStatus(['* STATUS "&ZeVnLIqe-" (UIDNEXT 42)']).uidnext, 42);
  assert.deepEqual(parseStatus(["a1 OK done"]), { uidnext: 0, messages: 0, unseen: 0, uidvalidity: 0 });
});

test("junk in, empty out — a structure we cannot read is not a crash", () => {
  assert.deepEqual(parseBodyStructure("NIL"), []);
  assert.deepEqual(parseBodyStructure(structure("()")), []);
  assert.deepEqual(chooseTextPart([]), null);
});

/**
 * The op envelope, round-tripped through the schema both TypeScript ends
 * validate against.
 *
 * This is the file's other job. The Rust executor mirrors these shapes by hand
 * and cannot import them, so the schema is what stops the *two TypeScript* ends
 * drifting — and an op the client can build but the Worker rejects surfaces as
 * "expected a mail op", which says nothing about which field was wrong.
 */
test("every op the client can build is one the Worker will accept", () => {
  const creds = { host: ICLOUD_IMAP.host, port: ICLOUD_IMAP.port, user: "a@icloud.com", pass: "x" };
  for (const op of [
    { ...creds, op: "list" },
    { ...creds, op: "status", mailbox: "INBOX" },
    { ...creds, op: "fetch", mailbox: "INBOX", uid: 991 },
    { ...creds, op: "headers", mailbox: "INBOX", uids: [3, 2, 1] },
    { ...creds, op: "search", mailbox: "INBOX", limit: 50, criteria: {} },
    // The freshness call: same search, restricted to what arrived since.
    { ...creds, op: "search", mailbox: "INBOX", limit: 50, criteria: { text: ["a", "b"], uid_min: 9931 } },
    { ...creds, op: "part", mailbox: "INBOX", uid: 991, part: "2.1" },
    // The two write ops — the reader's mark-as-read and delete.
    { ...creds, op: "mark_seen", mailbox: "INBOX", uid: 991, seen: true },
    { ...creds, op: "delete", mailbox: "INBOX", uid: 991, trash: "Deleted Messages" },
    { ...creds, op: "move", mailbox: "INBOX", uid: 991, dest: "Junk" },
  ]) {
    const parsed = mailOpSchema.safeParse(op);
    assert.ok(parsed.success, `${op.op} rejected: ${parsed.error?.message}`);
  }
});

test("the envelope still refuses what it exists to refuse", () => {
  const creds = { host: ICLOUD_IMAP.host, port: ICLOUD_IMAP.port, user: "a@icloud.com", pass: "x" };
  const bad = [
    // CR/LF is IMAP's command separator — the injection boundary, refused at
    // the schema before either executor's quoting gets a chance.
    { ...creds, op: "search", mailbox: "INBOX", limit: 1, criteria: { subject: ["x\r\na1 LOGOUT"] } },
    { ...creds, op: "search", mailbox: "IN\r\nBOX", limit: 1, criteria: {} },
    // A phrase is not a term list, and a page is not unbounded.
    { ...creds, op: "search", mailbox: "INBOX", limit: 1, criteria: { text: "one string" } },
    { ...creds, op: "headers", mailbox: "INBOX", uids: [] },
    { ...creds, op: "headers", mailbox: "INBOX", uids: Array(MAIL_MAX_RESULTS + 1).fill(1) },
    { ...creds, op: "search", mailbox: "INBOX", limit: 1, criteria: { since: "2026-01-01" } },
    { ...creds, op: "search", mailbox: "INBOX", limit: 1, criteria: { uid_min: 0 } },
    // A part number is INTERPOLATED into `BODY.PEEK[…]` — IMAP has no quoted
    // form for one, so its shape is the whole defence. Both executors check it
    // again; this is the first of the three layers.
    { ...creds, op: "part", mailbox: "INBOX", uid: 1, part: "1] BODY[" },
    { ...creds, op: "part", mailbox: "INBOX", uid: 1, part: "TEXT" },
    { ...creds, op: "part", mailbox: "INBOX", uid: 1, part: "1.0" },
    { ...creds, op: "part", mailbox: "INBOX", uid: 1, part: "01" },
    { ...creds, op: "part", mailbox: "INBOX", uid: 1, part: "1." },
    { ...creds, op: "part", mailbox: "INBOX", uid: 1, part: "" },
    // The delete op's Trash destination is a mailbox name, so CR/LF is refused
    // there too — it is interpolated into a `UID MOVE … <trash>` command.
    { ...creds, op: "delete", mailbox: "INBOX", uid: 1, trash: "Trash\r\na1 LOGOUT" },
    { ...creds, op: "mark_seen", mailbox: "INBOX", uid: 1, seen: "yes" },
    // The move op's destination is a mailbox name too — interpolated into
    // `UID MOVE … <dest>`, so CR/LF is refused at the schema.
    { ...creds, op: "move", mailbox: "INBOX", uid: 1, dest: "Junk\r\na1 LOGOUT" },
  ];
  for (const op of bad) assert.equal(mailOpSchema.safeParse(op).success, false, JSON.stringify(op.criteria ?? op));
});
