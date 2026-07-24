import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseTextPart, parseFetch, parseTokens, parseBodyStructure } from "../src/imapParse";

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

test("junk in, empty out — a structure we cannot read is not a crash", () => {
  assert.deepEqual(parseBodyStructure("NIL"), []);
  assert.deepEqual(parseBodyStructure(structure("()")), []);
  assert.deepEqual(chooseTextPart([]), null);
});
