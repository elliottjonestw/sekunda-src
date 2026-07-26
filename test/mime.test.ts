import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addTextLinks, decodeMailboxName, decodePartBytes, decodeStandalonePart, parseContentType,
  parseMailDate, safeLink, splitQuoted,
} from "../src/lib/mail/mime";

/** HTML through the real entry point the large-message path uses. */
function html(source: string) {
  return decodeStandalonePart(source, "7bit", "utf-8", "text/html");
}

/**
 * The client half of the mail pipeline, where the executors' raw bytes become
 * something a person reads.
 *
 * Outside `src/` for the same reason `worker/test/` is outside `worker/src/`:
 * `tsconfig.json` includes only `src`, and `node:test` is not part of a DOM
 * build. Run with `npm test`.
 *
 * `mime.ts` touches no browser API beyond `atob` and `TextDecoder`, both of
 * which Node has — which is what makes this testable at all without a headless
 * browser.
 */

test("a mailbox name comes out of modified UTF-7", () => {
  // The encoding IMAP predates UTF-8 with: base64 of UTF-16BE between & and -,
  // with `,` standing in for `/` because `/` is the hierarchy delimiter.
  assert.equal(decodeMailboxName("&ZeVnLIqe-"), "日本語");
  assert.equal(decodeMailboxName("~peter/mail/&U,BTFw-/&ZeVnLIqe-"), "~peter/mail/台北/日本語");
  // ASCII is left exactly alone — most names are, and touching them is how a
  // folder called "INBOX" stops matching itself.
  assert.equal(decodeMailboxName("INBOX"), "INBOX");
  assert.equal(decodeMailboxName("Archive/2025"), "Archive/2025");
  // `&-` is a literal ampersand; anything that isn't really an encoded run is
  // left as it was, because a folder named `R&D` is not an error.
  assert.equal(decodeMailboxName("Sent &- Drafts"), "Sent & Drafts");
  assert.equal(decodeMailboxName("R&D"), "R&D");
});

test("the sender's Date wins only while it is plausible", () => {
  const internal = "21-Jul-2026 10:00:00 +0800";

  // Ordinary mail: the header is what every other client shows.
  assert.equal(
    parseMailDate("Tue, 21 Jul 2026 09:30:00 +0800", internal),
    new Date("2026-07-21T09:30:00+08:00").toISOString(),
  );

  // The header is written by the SENDER, so a spammer sets it to next year to
  // pin the message to the top of a list sorted by date. Beyond a day's grace
  // — enough for a merely wrong clock — what the server saw wins.
  const server = new Date("2026-07-21T10:00:00+08:00").toISOString();
  assert.equal(parseMailDate("Fri, 1 Jan 2999 00:00:00 +0000", internal), server);
  assert.equal(parseMailDate("Mon, 1 Jan 1970 00:00:00 +0000", internal), server);

  // Missing or unparseable falls back; both missing is null, not epoch.
  assert.equal(parseMailDate("", internal), server);
  assert.equal(parseMailDate("not a date", internal), server);
  assert.equal(parseMailDate("", null), null);
  // With nothing to fall back to, an absurd claim is still better than nothing.
  assert.equal(
    parseMailDate("Fri, 1 Jan 2999 00:00:00 +0000", null),
    new Date("2999-01-01T00:00:00Z").toISOString(),
  );
});

test("an attachment comes back as BYTES, not as text", () => {
  // A PDF header: bytes that are not valid UTF-8 anywhere downstream. Putting
  // this through `TextDecoder` does not give a slightly damaged PDF, it gives
  // something that is not a PDF — which is why the download path stops one
  // step earlier than every other decoder in the module.
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xd8, 0x00]);
  const base64 = Buffer.from(pdf).toString("base64");
  assert.deepEqual(decodePartBytes(base64, "base64"), pdf);
  // Folded across lines, as it actually arrives on the wire.
  assert.deepEqual(decodePartBytes(base64.replace(/(.{4})/g, "$1\r\n"), "base64"), pdf);

  // Quoted-printable, soft line breaks and all.
  assert.deepEqual(
    decodePartBytes("caf=\r\n=C3=A9", "quoted-printable"),
    Uint8Array.from([0x63, 0x61, 0x66, 0xc3, 0xa9]),
  );
  // 7bit/8bit/binary are already the bytes.
  assert.deepEqual(decodePartBytes("hi", "7bit"), Uint8Array.from([0x68, 0x69]));
  // Junk is empty, never a throw that takes the whole message with it.
  assert.deepEqual(decodePartBytes("!!!!not base64!!!!", "base64"), new Uint8Array(0));
});

// ---------------------------------------------------------------------------
// Links
//
// The feature these exist for: an HTML-only sign-in mail used to lose its link
// entirely — `<a href="…">Verify</a>` flattened to the word "Verify" with no
// way back to the address. Everything below is either "the link survives" or
// "the link cannot lie about where it goes".
// ---------------------------------------------------------------------------

test("an anchor's href survives flattening, with a marker where it stood", () => {
  const { text, links } = html(
    '<p>Hi</p><p><a href="https://acme.example/verify?token=abc&amp;id=1">Verify your email</a></p>',
  );
  assert.equal(text, "Hi\n\nVerify your email [1]");
  assert.deepEqual(links, [{
    // `&amp;` decoded: the entity-encoded form is a DIFFERENT url, and getting
    // this wrong produces a verification link that looks right and 404s.
    url: "https://acme.example/verify?token=abc&id=1",
    host: "acme.example",
    label: "Verify your email",
  }]);
});

test("a link cannot lie about where it goes", () => {
  // Credentials in the authority are the classic dress-up: everything left of
  // the `@` is decoration. `host` reports the half that decides the request,
  // and the url handed to the opener has the decoration removed.
  const spoof = html('<a href="https://apple.com@evil.example/login">Apple ID</a>');
  assert.equal(spoof.links[0].host, "evil.example");
  assert.equal(spoof.links[0].url, "https://evil.example/login");
  assert.equal(spoof.links[0].label, "Apple ID");

  // An IDN homograph — а is Cyrillic U+0430 — reports as punycode, which is
  // visibly not the real thing. A sender-supplied label would show neither.
  const homograph = safeLink("https://аpple.com/signin");
  assert.ok(homograph);
  assert.ok(homograph.host.startsWith("xn--"), homograph.host);
  assert.notEqual(homograph.host, "apple.com");
});

test("only http, https and mailto are ever offered", () => {
  // On the web the click is `window.open`, which runs a `javascript:` url in
  // this origin — so this filter is the guard, not a second one.
  for (const href of ["javascript:alert(1)", "data:text/plain,hi", "file:///etc/passwd", "/relative"]) {
    assert.equal(safeLink(href), null, href);
  }
  // Control characters are stripped rather than trusted to break the parse:
  // `java\nscript:` is an old evasion and `URL` would ignore the newline.
  assert.equal(safeLink("java\nscript:alert(1)"), null);

  assert.equal(safeLink("mailto:someone@example.com")?.host, "someone@example.com");
  assert.equal(safeLink("https://example.com/x")?.host, "example.com");

  // A rejected href leaves the anchor's words alone and contributes nothing.
  const { text, links } = html('<p>Press <a href="javascript:alert(1)">here</a> now</p>');
  assert.equal(text, "Press here now");
  assert.deepEqual(links, []);
});

test("the same destination is one row, labelled by whichever anchor had words", () => {
  // An image link and a text link to the same place, which is every newsletter.
  const { text, links } = html(
    '<a href="https://x.example/a"><img src="p.png"></a><a href="https://x.example/a">Read more</a>',
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].label, "Read more");
  // Both markers point at the one row.
  assert.equal(text.match(/\[1\]/g)?.length, 2);
});

test("bare urls in text are found too, without their trailing punctuation", () => {
  const links = addTextLinks([], "Open (https://acme.example/a) or https://acme.example/b. Thanks!");
  assert.deepEqual(links.map((l) => l.url), [
    // The closing bracket belongs to the sentence, not to the url; so does the
    // full stop. Keeping either produces a 404 that reads as a broken link.
    "https://acme.example/a",
    "https://acme.example/b",
  ]);

  // Deduped against what the markup already gave, keeping the label.
  const merged = addTextLinks(
    [{ url: "https://acme.example/a", host: "acme.example", label: "A" }],
    "see https://acme.example/a",
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, "A");
});

test("script, style and comments are dropped before anchors are read", () => {
  const { text, links } = html(
    '<style>.a{color:red}</style><title>Ignore</title><p>Hello</p>'
    + '<!-- <a href="https://evil.example">hidden</a> -->',
  );
  assert.equal(text, "Hello");
  assert.deepEqual(links, []);
});

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

test("lists and blockquotes survive as text", () => {
  assert.equal(html("<ul><li>One</li><li>Two</li></ul>").text, "- One\n- Two");

  // The `> ` prefix is not decoration — it is what lets `splitQuoted` find the
  // reply trail in an HTML message the same way it does in a plain-text one.
  assert.equal(
    html("<p>Sure.</p><blockquote><p>Are we still on?</p></blockquote>").text,
    "Sure.\n\n> Are we still on?",
  );
  // Nesting deepens the prefix, in the `> > ` form mail clients write.
  assert.equal(
    html("<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>").text,
    "> a\n\n> > b",
  );
});

// ---------------------------------------------------------------------------
// Quoted replies — a DISPLAY split; `body` always keeps the whole message
// ---------------------------------------------------------------------------

test("the thread underneath a reply is split off", () => {
  const { visible, quoted } = splitQuoted([
    "Sounds good, see you then.",
    "",
    "On Mon, 20 Jul 2026 at 09:00, Alex <alex@example.com> wrote:",
    "> Are we still on for Tuesday?",
    "> I can do the morning or the afternoon.",
    "> Let me know which suits you best.",
    "> Thanks, Alex",
  ].join("\n"));
  assert.equal(visible, "Sounds good, see you then.");
  assert.ok(quoted.startsWith("On Mon, 20 Jul 2026"));

  // Outlook writes a rule and then the forwarded headers.
  const outlook = splitQuoted([
    "Passing this on.",
    "__________________________________",
    "From: Alex <alex@example.com>",
    "Sent: Monday, 20 July 2026 09:00",
    "Subject: Tuesday",
    "",
    "Are we still on for Tuesday? Let me know either way.",
  ].join("\n"));
  assert.equal(outlook.visible, "Passing this on.");
  assert.ok(outlook.quoted.includes("From: Alex"));
});

test("splitting never hides the whole message, or a mere aside", () => {
  // Every line quoted: there is no new text to leave visible, so it all shows.
  const allQuoted = "> one\n> two\n> three\n> four\n> five and some more text here";
  assert.equal(splitQuoted(allQuoted).quoted, "");
  assert.equal(splitQuoted(allQuoted).visible, allQuoted);

  // One quoted line mid-message is someone quoting a sentence, not a thread.
  const aside = "He said:\n> just the one line\nand then I carried on at some length about it.";
  assert.equal(splitQuoted(aside).quoted, "");

  // A trail too short to be in the way is not worth a button.
  assert.equal(splitQuoted("Yes.\n\nOn Mon Alex wrote:\n> ok").quoted, "");
});

// ---------------------------------------------------------------------------
// Parameters — RFC 2231, and the quoted semicolon
// ---------------------------------------------------------------------------

test("a filename split across RFC 2231 continuations is put back together", () => {
  // Before this, the second half was dropped and the download path wrote a real
  // file under the truncated name.
  assert.equal(
    parseContentType('attachment; filename*0="invoice-2026-"; filename*1="q3.pdf"').params.filename,
    "invoice-2026-q3.pdf",
  );
  // Sections arrive in any order.
  assert.equal(
    parseContentType('attachment; filename*1="q3.pdf"; filename*0="invoice-2026-"').params.filename,
    "invoice-2026-q3.pdf",
  );
  // A continuation beats a plain parameter of the same name — a sender that
  // sends both is offering the short one as a fallback.
  assert.equal(
    parseContentType('attachment; filename="short.pdf"; filename*0="a-very-"; filename*1="long.pdf"')
      .params.filename,
    "a-very-long.pdf",
  );
});

test("an RFC 2231 extended value carries its own charset", () => {
  assert.equal(
    parseContentType("attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf").params.filename,
    "日本.pdf",
  );
  // Extended AND continued, which is what a long non-ASCII name actually looks
  // like. The sections are joined before decoding, because a multi-byte
  // character can be split across two of them.
  assert.equal(
    parseContentType("attachment; filename*0*=UTF-8''%E6%97%A5; filename*1*=%E6%9C%AC.pdf")
      .params.filename,
    "日本.pdf",
  );
});

test("a semicolon inside quotes does not split a parameter", () => {
  // The half that survived a naive split is what got written to disk.
  assert.equal(
    parseContentType('attachment; filename="report; final.pdf"').params.filename,
    "report; final.pdf",
  );
  // The other victim: a boundary, where losing it loses every part.
  const multipart = parseContentType('multipart/mixed; boundary="----=_Part_1; 2"');
  assert.equal(multipart.type, "multipart/mixed");
  assert.equal(multipart.params.boundary, "----=_Part_1; 2");
});
