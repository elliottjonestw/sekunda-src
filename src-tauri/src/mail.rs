//! IMAP for the desktop app: the one custom command in this codebase.
//!
//! Architecture rule 1 says the Rust layer is plugin wiring and nothing else,
//! and this is the single deliberate exception. It exists because IMAP is a
//! stateful TCP protocol: `tauri-plugin-http` speaks HTTP, the webview cannot
//! open a socket, and there is no plugin that does. Without this file, mail on
//! the desktop would have to be relayed through our Worker — which would mean
//! routing the user's inbox through a server for no reason on the one platform
//! that can reach Apple directly.
//!
//! It is a mirror, not a second implementation of the feature. The op envelope
//! is `packages/shared/src/mail.ts`, the protocol logic matches
//! `worker/src/imap.ts` command for command, and both return RAW message bytes
//! so that all decoding — headers, MIME, charsets — happens once in
//! `src/lib/mail/mime.ts`. Anything changed here has a counterpart there.
//!
//! Three properties to preserve:
//!   * **Host allowlist.** Only iCloud's IMAP endpoint on its own port. Without
//!     it, any script that reaches the IPC bridge gets a general-purpose TCP
//!     client running outside the webview's origin rules — the same reason
//!     `capabilities/default.json` carries no blanket http scope.
//!   * **Reads are read-only; writes are a small named set.** Every READ op
//!     opens the mailbox with EXAMINE and fetches with BODY.PEEK, so the server
//!     itself refuses any change a read path could ask for. The WRITE ops, added
//!     deliberately for the reader UI, are `mark_seen` (SELECT + `UID STORE …
//!     FLAGS (\Seen)`), `delete` (SELECT + `UID MOVE` to Trash, or an expunge
//!     when already in Trash) and `move` (SELECT + `UID MOVE` to a named folder
//!     — Move to Junk today). Each issues one constrained mutation and takes no
//!     arbitrary flag or command from the caller. The AI tool layer builds none
//!     of these, so the assistant is read-only regardless of this command.
//!   * **No logging, ever.** This function holds the user's app-specific
//!     password and their mail. There is no `println!` here and there must
//!     never be one.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

/// The one server this command will talk to. Mirrors `ICLOUD_IMAP` in
/// `packages/shared/src/mail.ts`; adding a provider means adding it in both.
const ICLOUD_HOST: &str = "imap.mail.me.com";
const ICLOUD_PORT: u16 = 993;

/// Mirrors `MAIL_MAX_BODY_BYTES`.
const MAX_BODY_BYTES: usize = 262_144;
/// Mirrors `MAIL_SMALL_MESSAGE_BYTES` — at or below this a message is fetched
/// whole and walked by the client's original MIME parser.
const SMALL_MESSAGE_BYTES: u64 = 65_536;
/// Mirrors `MAIL_MAX_ATTACHMENT_WIRE_BYTES` — the cap on an attachment read,
/// measured on the wire where base64 costs four bytes per three.
const MAX_ATTACHMENT_WIRE_BYTES: usize = 14_000_000;
/// The response ceiling. Per-connection rather than a constant, because the
/// attachment op needs one forty times higher than everything else and lowering
/// the guard for every response to suit one of them is the wrong trade.
const MAX_RESPONSE_BYTES: usize = MAX_BODY_BYTES + 65_536;
const MAX_RESULTS: usize = 100;
/// Mirrors `MAIL_MAX_UIDS` — how far back the client may page.
const MAX_UIDS: usize = 5_000;
const DEADLINE: Duration = Duration::from_secs(20);
/// Downloading an attachment gets longer: it is the one op whose time is spent
/// on bytes rather than latency, and a working download that reports "the mail
/// server took too long" is the worst of both. Still bounded, by a deadline
/// rather than a hope.
const PART_DEADLINE: Duration = Duration::from_secs(60);
const HEADER_FIELDS: &str = "DATE SUBJECT FROM TO CC REPLY-TO MESSAGE-ID CONTENT-TYPE LIST-ID";

// ---------------------------------------------------------------------------
// The op envelope (mirror of packages/shared/src/mail.ts)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct Criteria {
    // TERMS, never a phrase — see `searchTerms` in packages/shared/src/mail.ts.
    // IMAP matches a key as one substring, so a multi-word query has to become
    // several keys, which IMAP then ANDs.
    from: Option<Vec<String>>,
    to: Option<Vec<String>>,
    subject: Option<Vec<String>>,
    text: Option<Vec<String>>,
    since: Option<String>,
    before: Option<String>,
    unseen: Option<bool>,
    /// Only uids at or above this one (`UID n:*`) — how new mail arrives
    /// without a re-search. See `uid_min` in packages/shared/src/mail.ts.
    uid_min: Option<u32>,
}

#[derive(Deserialize)]
pub struct Credentials {
    host: String,
    port: u16,
    user: String,
    pass: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum MailOp {
    List {
        #[serde(flatten)]
        creds: Credentials,
    },
    Search {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        #[serde(default)]
        criteria: Criteria,
        limit: usize,
    },
    Fetch {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        uid: u32,
    },
    /// Headers for uids we already hold — one page of an earlier search.
    Headers {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        uids: Vec<u32>,
    },
    /// What the server says about a mailbox, carrying no message data.
    Status {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
    },
    /// One MIME part's raw bytes — an attachment, downloaded on demand. Still a
    /// read: `BODY.PEEK` on a part is the same command shape as the text.
    Part {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        uid: u32,
        part: String,
    },
    /// Set (or clear) `\Seen` on one message — the reader's mark-as-read. The
    /// first write op: SELECT (not EXAMINE) + `UID STORE … FLAGS (\Seen)`.
    MarkSeen {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        uid: u32,
        seen: bool,
    },
    /// Move one message to Trash — the reader's delete. `UID MOVE` to the
    /// account's Trash folder, reversible; an expunge when already in Trash.
    Delete {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        uid: u32,
        trash: String,
    },
    /// Move one message to a named folder — the reader's file-away. `UID MOVE`
    /// to `dest`; the generic form of `delete`'s move, no expunge branch. Move
    /// to Junk is its first caller.
    Move {
        #[serde(flatten)]
        creds: Credentials,
        mailbox: String,
        uid: u32,
        dest: String,
    },
}

impl MailOp {
    fn credentials(&self) -> &Credentials {
        match self {
            MailOp::List { creds } => creds,
            MailOp::Search { creds, .. } => creds,
            MailOp::Fetch { creds, .. } => creds,
            MailOp::Headers { creds, .. } => creds,
            MailOp::Status { creds, .. } => creds,
            MailOp::Part { creds, .. } => creds,
            MailOp::MarkSeen { creds, .. } => creds,
            MailOp::Delete { creds, .. } => creds,
            MailOp::Move { creds, .. } => creds,
        }
    }
}

#[derive(Serialize)]
pub struct Folder {
    name: String,
    delimiter: String,
    flags: Vec<String>,
}

/// One leaf of the MIME tree — mirrors `ImapBodyPart`.
#[derive(Serialize, Clone, Default)]
pub struct BodyPart {
    /// IMAP part number, e.g. "2.1". Fetchable as `BODY.PEEK[<part>]`.
    part: String,
    #[serde(rename = "type")]
    kind: String,
    subtype: String,
    params: std::collections::BTreeMap<String, String>,
    encoding: String,
    /// Octets as encoded on the wire, which is what the server counts.
    size: Option<u64>,
    disposition: Option<String>,
    filename: Option<String>,
    /// True when this part is inside an attached `message/rfc822`.
    embedded: bool,
}

/// One isolated part's raw bytes — mirrors `ImapPartResult`.
#[derive(Serialize)]
pub struct PartResult {
    part: String,
    #[serde(rename = "type")]
    kind: String,
    encoding: String,
    charset: Option<String>,
    body: String,
}

#[derive(Serialize, Default)]
pub struct Message {
    uid: u32,
    flags: Vec<String>,
    internal_date: Option<String>,
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    structure: Option<Vec<BodyPart>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    part: Option<PartResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    /// The bytes of an isolated part, as they came off a `BODY[2.1]` fetch.
    /// Never serialized: `fetch_message` pairs it with the structure that
    /// describes it and puts the result in `part` before anything is returned.
    #[serde(skip)]
    part_body: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum OpResult {
    List {
        folders: Vec<Folder>,
    },
    Search {
        total: usize,
        truncated: bool,
        /// Every matching uid we will page over, NEWEST FIRST.
        uids: Vec<u32>,
        /// The freshness baseline, read off the EXAMINE this search already
        /// did. Zero when the server didn't volunteer them.
        uidnext: u32,
        exists: u32,
        /// A uid means nothing without this — see `MailOpResult` in
        /// packages/shared/src/mail.ts.
        uidvalidity: u32,
        /// Headers for the first page of `uids`.
        messages: Vec<Message>,
    },
    Headers {
        uidvalidity: u32,
        messages: Vec<Message>,
    },
    Status {
        uidvalidity: u32,
        uidnext: u32,
        messages: u32,
        unseen: u32,
    },
    Fetch {
        uidvalidity: u32,
        message: Message,
    },
    MarkSeen {
        uidvalidity: u32,
        /// The message's flags after the STORE, as the server reported them.
        flags: Vec<String>,
    },
    Delete {
        uidvalidity: u32,
    },
    Move {
        uidvalidity: u32,
    },
    Part {
        uidvalidity: u32,
        /// RAW bytes as a binary string, still in the part's transfer encoding.
        body: String,
        /// True when the read hit the wire cap. The client refuses to save a
        /// truncated part: a file cut short is a corrupted file that looks like
        /// a saved one.
        truncated: bool,
    },
}

// ---------------------------------------------------------------------------
// Bytes ↔ binary strings
//
// Mail is bytes in a charset the message declares, so nothing here decodes it:
// each byte becomes one `char` in U+0000..U+00FF, serde writes that as JSON,
// and the client reads the bytes back out before applying the real charset.
// Decoding as UTF-8 here would corrupt every message that isn't, irreversibly.
// ---------------------------------------------------------------------------

fn binary_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| *b as char).collect()
}

/// The inverse, for the bytes we send: our own commands are ASCII, and search
/// terms go out as UTF-8 literals, so this is only ever applied to ASCII.
fn ascii_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}

// ---------------------------------------------------------------------------
// Response tokens (mirror of parseTokens in worker/src/imap.ts)
// ---------------------------------------------------------------------------

enum Token {
    Atom(String),
    List(Vec<Token>),
}

impl Token {
    fn text(&self) -> &str {
        match self {
            Token::Atom(s) => s,
            Token::List(_) => "",
        }
    }
}

fn token_at(items: &[Token], i: usize) -> &str {
    items.get(i).map(|t| t.text()).unwrap_or("")
}

/// Atoms are bracket-aware: `BODY[HEADER.FIELDS (DATE SUBJECT)]` is ONE token.
/// Splitting it shifts every key/value pair in a FETCH response by one, which
/// reads as "the server sent nothing back".
fn parse_tokens(s: &[char], start: usize) -> (Vec<Token>, usize) {
    let mut items = Vec::new();
    let mut i = start;
    while i < s.len() {
        let c = s[i];
        if c == ' ' {
            i += 1;
            continue;
        }
        if c == ')' {
            i += 1;
            break;
        }
        if c == '(' {
            let (inner, next) = parse_tokens(s, i + 1);
            items.push(Token::List(inner));
            i = next;
            continue;
        }
        if c == '"' {
            let mut out = String::new();
            i += 1;
            while i < s.len() && s[i] != '"' {
                if s[i] == '\\' {
                    i += 1;
                }
                if i < s.len() {
                    out.push(s[i]);
                    i += 1;
                }
            }
            i += 1;
            items.push(Token::Atom(out));
            continue;
        }
        if c == '{' {
            // The literal's bytes sit immediately after the marker — see
            // `read_response`, which splices them in there.
            let close = (i..s.len()).find(|&k| s[k] == '}');
            let Some(close) = close else { break };
            let n: usize = s[i + 1..close].iter().collect::<String>().parse().unwrap_or(0);
            let from = close + 1;
            let to = (from + n).min(s.len());
            items.push(Token::Atom(s[from..to].iter().collect()));
            i = to;
            continue;
        }
        let mut atom = String::new();
        while i < s.len() && !matches!(s[i], ' ' | '(' | ')') {
            if s[i] == '[' {
                let mut depth = 0i32;
                loop {
                    if s[i] == '[' {
                        depth += 1;
                    } else if s[i] == ']' {
                        depth -= 1;
                    }
                    atom.push(s[i]);
                    i += 1;
                    if i >= s.len() || depth == 0 {
                        break;
                    }
                }
                continue;
            }
            atom.push(s[i]);
            i += 1;
        }
        items.push(Token::Atom(atom));
    }
    (items, i)
}

// ---------------------------------------------------------------------------
// BODYSTRUCTURE (mirror of worker/src/imapParse.ts)
//
// The grammar, because reading it off RFC 3501 §7.4.2 every time is how the
// index arithmetic below goes wrong:
//
//   multipart:  (<part> <part> … subtype (params) disposition language location)
//               — one or more nested part LISTS, then the subtype STRING. The
//                 leading run of lists is what distinguishes it from a leaf,
//                 whose first element is the type string.
//
//   leaf:       (type subtype (params) id description encoding size …)
//                 0    1        2      3  4           5        6
//               then, by type:
//                 text/*            7 = line count, extensions from 8
//                 message/rfc822    7 = envelope, 8 = the NESTED bodystructure,
//                                   9 = line count, extensions from 10
//                 anything else     extensions from 7
//               extensions are: md5, disposition, language, location — so the
//               disposition sits one past wherever they start.
// ---------------------------------------------------------------------------

/// Nesting bound. A hand-crafted message can nest multiparts far enough to blow
/// the stack, and nothing legitimate goes past a handful.
const MAX_DEPTH: usize = 10;

fn as_list(token: Option<&Token>) -> Option<&Vec<Token>> {
    match token {
        Some(Token::List(list)) => Some(list),
        _ => None,
    }
}

/// An atom the server may have sent as `NIL`, which means "no value" and is not
/// the three-letter string it looks like.
fn nilable(token: Option<&Token>) -> Option<String> {
    let text = match token {
        Some(Token::Atom(s)) => s.as_str(),
        _ => "",
    };
    if text.is_empty() || text.eq_ignore_ascii_case("NIL") {
        None
    } else {
        Some(text.to_string())
    }
}

fn param_list(token: Option<&Token>) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let Some(list) = as_list(token) else { return out };
    let mut i = 0;
    while i + 1 < list.len() {
        let key = list[i].text().to_lowercase();
        if let (false, Some(value)) = (key.is_empty(), nilable(list.get(i + 1))) {
            out.insert(key, value);
        }
        i += 2;
    }
    out
}

fn disposition_of(token: Option<&Token>) -> (Option<String>, std::collections::BTreeMap<String, String>) {
    let Some(list) = as_list(token) else {
        return (None, std::collections::BTreeMap::new());
    };
    (
        nilable(list.first()).map(|s| s.to_lowercase()),
        param_list(list.get(1)),
    )
}

/// Flatten a BODYSTRUCTURE into its leaves, each with the part number naming it.
///
/// `node` is the *body of a message* whose own part number is `prefix` (empty at
/// the top level). That framing is what makes the `message/rfc822` case fall out
/// for free: RFC 3501 §6.4.5 numbers the parts inside an attached message as the
/// attachment's number, a period, and the numbering that message would have had
/// on its own — which is precisely this function again with a new prefix.
fn parse_body_structure(node: Option<&Token>, prefix: &str, embedded: bool, depth: usize) -> Vec<BodyPart> {
    let Some(list) = as_list(node) else { return Vec::new() };
    // An empty list is not a part with empty fields — it is a server saying
    // nothing, and inventing a leaf out of it would put a nameless zero-byte
    // attachment on the message.
    if list.is_empty() || depth > MAX_DEPTH {
        return Vec::new();
    }
    let mut out = Vec::new();
    if matches!(list.first(), Some(Token::List(_))) {
        // Multipart: its children are 1..n under this prefix. The multipart
        // itself is never emitted — it is structure, and there is nothing to do
        // with one.
        for (i, child) in list.iter().enumerate() {
            if !matches!(child, Token::List(_)) {
                break;
            }
            let number = if prefix.is_empty() {
                format!("{}", i + 1)
            } else {
                format!("{}.{}", prefix, i + 1)
            };
            out.extend(walk_part(Some(child), &number, embedded, depth + 1));
        }
        return out;
    }
    // A message with no multipart at all still has one part, numbered 1.
    let number = if prefix.is_empty() { "1".to_string() } else { format!("{}.1", prefix) };
    walk_part(node, &number, embedded, depth + 1)
}

fn walk_part(node: Option<&Token>, part: &str, embedded: bool, depth: usize) -> Vec<BodyPart> {
    let Some(list) = as_list(node) else { return Vec::new() };
    if list.is_empty() || depth > MAX_DEPTH {
        return Vec::new();
    }
    if matches!(list.first(), Some(Token::List(_))) {
        let mut out = Vec::new();
        for (i, child) in list.iter().enumerate() {
            if !matches!(child, Token::List(_)) {
                break;
            }
            out.extend(walk_part(Some(child), &format!("{}.{}", part, i + 1), embedded, depth + 1));
        }
        return out;
    }

    let kind = list.first().map(|t| t.text().to_lowercase()).unwrap_or_default();
    let subtype = list.get(1).map(|t| t.text().to_lowercase()).unwrap_or_default();
    let params = param_list(list.get(2));
    let encoding = nilable(list.get(5)).unwrap_or_default().to_lowercase();
    let size = list.get(6).and_then(|t| t.text().parse::<u64>().ok());

    let is_message = kind == "message" && subtype == "rfc822";
    let extensions = if kind == "text" {
        8
    } else if is_message {
        10
    } else {
        7
    };
    let (disposition, disposition_params) = disposition_of(list.get(extensions + 1));

    let leaf = BodyPart {
        part: part.to_string(),
        kind: kind.clone(),
        subtype: subtype.clone(),
        // The name lives in either place depending on the sending client, and
        // neither is more correct — Content-Disposition wins because it is the
        // one that means "this is a file".
        filename: disposition_params
            .get("filename")
            .or_else(|| params.get("name"))
            .cloned(),
        params,
        encoding,
        size,
        disposition,
        embedded,
    };

    // An attached message is BOTH a thing to list and a tree to look inside.
    let mut out = vec![leaf];
    if is_message {
        out.extend(parse_body_structure(list.get(8), part, true, depth + 1));
    }
    out
}

/// The part to show as the message's body.
///
/// **This rule is written twice** — here and in `worker/src/imapParse.ts` —
/// because the choice has to be made by whoever holds the connection, and a
/// second round trip from the client would be a second TLS handshake and a
/// second login. So it is kept deliberately blunt: type first, never position.
///
/// Position is what the old whole-message walker used, and it is wrong for a
/// `multipart/alternative` whose HTML part comes first. Preferring the message's
/// own text over an attached message's is the other half: a forwarded email's
/// body is not this email's body, but it is better than nothing, so it is the
/// fallback rather than the answer.
fn choose_text_part(parts: &[BodyPart]) -> Option<&BodyPart> {
    let pick = |embedded: bool, subtype: &str| {
        parts.iter().find(|p| {
            p.embedded == embedded
                && p.subtype == subtype
                && p.kind == "text"
                && p.disposition.as_deref() != Some("attachment")
        })
    };
    pick(false, "plain")
        .or_else(|| pick(false, "html"))
        .or_else(|| pick(true, "plain"))
        .or_else(|| pick(true, "html"))
}

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

enum Arg {
    Text(String),
    /// Sent as a synchronizing literal — needed for any non-ASCII search term.
    Literal(String),
}

/// A string as IMAP wants it: quoted when it can be, a literal when it can't.
///
/// The quoting is the injection boundary. An unescaped `"` in a search term
/// would close the string and let the rest be read as command syntax, against
/// the user's own live session.
fn astring(value: &str) -> Arg {
    if value.chars().all(|c| (' '..='~').contains(&c)) && !value.contains('{') {
        Arg::Text(format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")))
    } else {
        Arg::Literal(value.to_string())
    }
}

/// CR/LF is IMAP's command separator. The shared schema already refuses it and
/// so does this — the client is not the only thing that can call this command.
fn reject_control(value: &str, what: &str) -> Result<(), String> {
    if value.contains('\r') || value.contains('\n') {
        return Err(format!("{} must not contain line breaks.", what));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

struct Conn {
    stream: TlsStream<TcpStream>,
    buf: Vec<u8>,
    tag: u32,
    /// Raised for the attachment op and nothing else.
    max_response: usize,
}

impl Conn {
    async fn fill(&mut self) -> Result<(), String> {
        let mut chunk = [0u8; 8192];
        let n = self
            .stream
            .read(&mut chunk)
            .await
            .map_err(|_| "Lost the connection to the mail server.".to_string())?;
        if n == 0 {
            return Err("The mail server closed the connection.".to_string());
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(())
    }

    async fn read_line(&mut self) -> Result<String, String> {
        loop {
            if let Some(idx) = self.buf.windows(2).position(|w| w == b"\r\n") {
                let line = binary_string(&self.buf[..idx]);
                self.buf.drain(..idx + 2);
                return Ok(line);
            }
            if self.buf.len() > self.max_response {
                return Err("The mail server sent more data than we will read.".to_string());
            }
            self.fill().await?;
        }
    }

    async fn read_bytes(&mut self, n: usize) -> Result<String, String> {
        while self.buf.len() < n {
            self.fill().await?;
        }
        let out = binary_string(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(out)
    }

    /// One logical response: a line with any literals spliced in where their
    /// `{n}` marker sits, so the parser can slice them back out by length. A
    /// reader that stops at the first CRLF mis-frames every message whose
    /// subject is non-ASCII.
    async fn read_response(&mut self) -> Result<String, String> {
        let mut out = self.read_line().await?;
        loop {
            let Some(n) = literal_length(&out) else { return Ok(out) };
            if n > self.max_response || out.len() + n > self.max_response {
                return Err("The mail server sent more data than we will read.".to_string());
            }
            let literal = self.read_bytes(n).await?;
            let rest = self.read_line().await?;
            out.push_str(&literal);
            out.push_str(&rest);
        }
    }

    async fn write(&mut self, text: &str) -> Result<(), String> {
        self.stream
            .write_all(&ascii_bytes(text))
            .await
            .map_err(|_| "Could not talk to the mail server.".to_string())
    }

    /// Run one command; return its untagged response lines. A NO/BAD becomes an
    /// error carrying the server's own (truncated) text — without it, a rejected
    /// sign-in is indistinguishable from a missing mailbox.
    async fn command(&mut self, args: &[Arg]) -> Result<Vec<String>, String> {
        self.tag += 1;
        let tag = format!("a{}", self.tag);
        let mut pending = format!("{} ", tag);

        for arg in args {
            match arg {
                Arg::Text(text) => pending.push_str(text),
                Arg::Literal(text) => {
                    let bytes = text.as_bytes().to_vec();
                    self.write(&format!("{}{{{}}}\r\n", pending, bytes.len())).await?;
                    pending.clear();
                    // Untagged responses may arrive before the continuation.
                    loop {
                        let line = self.read_response().await?;
                        if line.starts_with('+') {
                            break;
                        }
                        if !line.starts_with('*') {
                            return Err("The mail server refused the command.".to_string());
                        }
                    }
                    self.stream
                        .write_all(&bytes)
                        .await
                        .map_err(|_| "Could not talk to the mail server.".to_string())?;
                }
            }
        }

        self.write(&format!("{}\r\n", pending)).await?;

        let mut lines = Vec::new();
        loop {
            let line = self.read_response().await?;
            if let Some(rest) = line.strip_prefix(&format!("{} ", tag)) {
                if rest.len() >= 2 && rest[..2].eq_ignore_ascii_case("OK") {
                    return Ok(lines);
                }
                let detail: String = rest.chars().take(200).collect();
                return Err(if detail.trim().is_empty() {
                    "The mail server rejected the request.".to_string()
                } else {
                    detail.trim().to_string()
                });
            }
            lines.push(line);
        }
    }
}

/// The `{n}` at the end of a response line, if there is one.
fn literal_length(line: &str) -> Option<usize> {
    let trimmed = line.strip_suffix('}')?;
    let open = trimmed.rfind('{')?;
    let digits = &trimmed[open + 1..];
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

// ---------------------------------------------------------------------------
// Ops (mirror of runOp in worker/src/imap.ts)
// ---------------------------------------------------------------------------

fn parse_folders(lines: &[String]) -> Vec<Folder> {
    let mut folders = Vec::new();
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let (items, _) = parse_tokens(&chars, 0);
        if token_at(&items, 0) != "*" || !token_at(&items, 1).eq_ignore_ascii_case("LIST") {
            continue;
        }
        let flags: Vec<String> = match items.get(2) {
            Some(Token::List(list)) => list.iter().map(|t| t.text().to_string()).collect(),
            _ => Vec::new(),
        };
        // \Noselect names a hierarchy node that cannot be opened; offering it
        // produces a failure the user can do nothing about.
        if flags.iter().any(|f| f.eq_ignore_ascii_case("\\Noselect")) {
            continue;
        }
        let delimiter = match token_at(&items, 3) {
            "NIL" => String::new(),
            d => d.to_string(),
        };
        let name = token_at(&items, 4).to_string();
        if name.is_empty() {
            continue;
        }
        folders.push(Folder { name, delimiter, flags });
    }
    folders
}

/// The two numbers EXAMINE already volunteers: `* 1204 EXISTS` and
/// `* OK [UIDNEXT 9931] …`.
///
/// Reading them here is what keeps the freshness check off the critical path —
/// every search opens the mailbox anyway, so the baseline "how many, and what
/// uid comes next" costs no command at all.
///
/// EXAMINE's `* OK [UNSEEN n]` is deliberately NOT read: it is the sequence
/// number of the first unseen message, not a count, and treating it as one
/// gives a number that looks plausible and is wrong.
fn parse_examine(lines: &[String]) -> (u32, u32, u32) {
    let (mut uidnext, mut exists, mut uidvalidity) = (0u32, 0u32, 0u32);
    for line in lines {
        if let Some(rest) = strip_ci(line, "* OK [UIDNEXT ") {
            if let Some(end) = rest.find(']') {
                uidnext = rest[..end].trim().parse().unwrap_or(uidnext);
            }
        } else if let Some(rest) = strip_ci(line, "* OK [UIDVALIDITY ") {
            if let Some(end) = rest.find(']') {
                uidvalidity = rest[..end].trim().parse().unwrap_or(uidvalidity);
            }
        } else if let Some(rest) = strip_ci(line, "* ") {
            if let Some(n) = rest.strip_suffix(" EXISTS").or_else(|| rest.strip_suffix(" exists")) {
                exists = n.trim().parse().unwrap_or(exists);
            }
        }
    }
    (uidnext, exists, uidvalidity)
}

/// `strip_prefix`, case-insensitively on the prefix — IMAP keywords are
/// case-insensitive and servers do not agree on which case to use.
fn strip_ci<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    if line.len() >= prefix.len() && line[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&line[prefix.len()..])
    } else {
        None
    }
}

/// `* STATUS "INBOX" (MESSAGES 1204 UIDNEXT 9931 UNSEEN 3)`.
///
/// The mailbox name sits between the keyword and the list and is skipped rather
/// than matched: it comes back in the server's own quoting and its own modified
/// UTF-7, so comparing it to what we sent is a way to reject a correct answer.
/// There is only ever one STATUS in flight, so the pairs are what matter.
fn parse_status(lines: &[String]) -> (u32, u32, u32, u32) {
    let (mut uidnext, mut messages, mut unseen, mut uidvalidity) = (0u32, 0u32, 0u32, 0u32);
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let (items, _) = parse_tokens(&chars, 0);
        if token_at(&items, 0) != "*" || !token_at(&items, 1).eq_ignore_ascii_case("STATUS") {
            continue;
        }
        let Some(Token::List(pairs)) = items.iter().find(|t| matches!(t, Token::List(_))) else {
            continue;
        };
        let mut i = 0;
        while i + 1 < pairs.len() {
            let key = pairs[i].text().to_uppercase();
            if let Ok(value) = pairs[i + 1].text().parse::<u32>() {
                match key.as_str() {
                    "UIDNEXT" => uidnext = value,
                    "MESSAGES" => messages = value,
                    "UNSEEN" => unseen = value,
                    "UIDVALIDITY" => uidvalidity = value,
                    _ => {}
                }
            }
            i += 2;
        }
    }
    (uidnext, messages, unseen, uidvalidity)
}

fn parse_uids(lines: &[String]) -> Vec<u32> {
    let mut uids = Vec::new();
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let (items, _) = parse_tokens(&chars, 0);
        if token_at(&items, 0) != "*" || !token_at(&items, 1).eq_ignore_ascii_case("SEARCH") {
            continue;
        }
        for token in items.iter().skip(2) {
            if let Ok(n) = token.text().parse::<u32>() {
                if n > 0 {
                    uids.push(n);
                }
            }
        }
    }
    uids
}

fn parse_fetch(lines: &[String]) -> Vec<Message> {
    let mut out = Vec::new();
    for line in lines {
        let chars: Vec<char> = line.chars().collect();
        let (items, _) = parse_tokens(&chars, 0);
        if token_at(&items, 0) != "*" || !token_at(&items, 2).eq_ignore_ascii_case("FETCH") {
            continue;
        }
        let Some(Token::List(body)) = items.get(3) else { continue };

        let mut msg = Message::default();
        let mut i = 0;
        while i + 1 < body.len() {
            let key = body[i].text().to_uppercase();
            let value = &body[i + 1];
            match key.as_str() {
                "UID" => msg.uid = value.text().parse().unwrap_or(0),
                "FLAGS" => {
                    if let Token::List(list) = value {
                        msg.flags = list.iter().map(|t| t.text().to_string()).collect();
                    }
                }
                "INTERNALDATE" => msg.internal_date = Some(value.text().to_string()),
                "RFC822.SIZE" => msg.size = value.text().parse().ok(),
                "BODYSTRUCTURE" | "BODY" => {
                    msg.structure = Some(parse_body_structure(Some(value), "", false, 0));
                }
                // Matched in order of DECREASING specificity: the server echoes
                // back the section it was asked for, so `BODY[HEADER.FIELDS
                // (…)]`, `BODY[]<0>` and `BODY[2.1]<0>` all start `BODY[` and
                // mean three different things.
                _ if key.starts_with("BODY[HEADER") => msg.headers = Some(value.text().to_string()),
                _ if key.starts_with("BODY[]") => msg.raw = Some(value.text().to_string()),
                _ if key.starts_with("BODY[") => msg.part_body = Some(value.text().to_string()),
                _ => {}
            }
            i += 2;
        }
        if msg.uid > 0 {
            out.push(msg);
        }
    }
    out
}

/// The criteria as SEARCH arguments. `ALL` when nothing was asked for — an
/// empty key list is a syntax error, not "everything".
fn search_args(criteria: &Criteria) -> Result<(Vec<Arg>, bool), String> {
    // UNDELETED, always and first. A message flagged \Deleted has been deleted
    // in another client and is waiting for an expunge; showing it means
    // offering to open mail the user believes is gone. It also makes the key
    // list never empty, so the old `ALL` fallback has nothing left to guard.
    let mut args: Vec<Arg> = vec![Arg::Text("UNDELETED ".into())];
    let mut non_ascii = false;

    for (key, values) in [
        ("FROM", &criteria.from),
        ("TO", &criteria.to),
        ("SUBJECT", &criteria.subject),
        ("TEXT", &criteria.text),
    ] {
        for value in values.iter().flatten() {
            reject_control(value, "Search terms")?;
            if !value.is_ascii() {
                non_ascii = true;
            }
            args.push(Arg::Text(format!("{} ", key)));
            args.push(astring(value));
            args.push(Arg::Text(" ".to_string()));
        }
    }
    // Dates go into the command unquoted, so they are the one place a criterion
    // could carry command syntax — hence the same shape check the shared schema
    // applies, repeated here rather than trusted.
    for (key, value) in [("SINCE", &criteria.since), ("BEFORE", &criteria.before)] {
        if let Some(v) = value {
            if !is_imap_date(v) {
                return Err("Expected a d-MMM-yyyy date.".to_string());
            }
            args.push(Arg::Text(format!("{} {} ", key, v)));
        }
    }
    if criteria.unseen.unwrap_or(false) {
        args.push(Arg::Text("UNSEEN ".to_string()));
    }
    // `UID n:*` — everything that arrived since we last looked. A u32, so it is
    // interpolated rather than quoted; IMAP has no quoted form for a sequence
    // set anyway.
    if let Some(min) = criteria.uid_min.filter(|n| *n > 0) {
        args.push(Arg::Text(format!("UID {}:* ", min)));
    }

    // NO TRAILING SPACE BEFORE THE CRLF. Each term above appends its own
    // separator, which leaves one dangling on the last of them, and iCloud
    // answers `BAD Parse Error` to `UID SEARCH UNSEEN ` — the space is a token
    // boundary promising a search key that never arrives.
    if let Some(Arg::Text(last)) = args.last_mut() {
        if last.ends_with(' ') {
            let trimmed = last.trim_end().to_string();
            // A bare separator after a literal has nothing left once trimmed.
            if trimmed.is_empty() {
                args.pop();
            } else {
                *last = trimmed;
            }
        }
    }
    Ok((args, non_ascii))
}

/// An IMAP part number: `1`, `2.1`, `3.1.2`. Digits and dots, nothing else.
fn is_part_number(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.split('.').all(|seg| {
            !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()) && !seg.starts_with('0')
        })
}

fn is_imap_date(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 3
        && (1..=2).contains(&parts[0].len())
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].len() == 3
        && parts[1].chars().all(|c| c.is_ascii_alphabetic())
        && parts[2].len() == 4
        && parts[2].chars().all(|c| c.is_ascii_digit())
}

/// One message: ask what it is made of, then fetch only what is worth having.
///
/// Mirrors `fetchMessage` in `worker/src/imap.ts`, which carries the full
/// reasoning. In short: the old single `BODY.PEEK[]<0.262144>` downloaded
/// attachments in order to throw them away, and lost the body outright whenever
/// a large part happened to precede the text. `BODYSTRUCTURE` costs no body
/// bytes, so asking first is nearly free on a connection that is already open.
async fn fetch_message(conn: &mut Conn, uid: u32) -> Result<Message, String> {
    let lines = conn
        .command(&[Arg::Text(format!(
            "UID FETCH {} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE \
             BODY.PEEK[HEADER.FIELDS ({})])",
            uid, HEADER_FIELDS
        ))])
        .await?;
    let mut message = parse_fetch(&lines)
        .into_iter()
        .next()
        .ok_or_else(|| "That message no longer exists.".to_string())?;

    let size = message.size.unwrap_or(0);
    let structure = message.structure.clone().unwrap_or_default();
    // An unreadable structure is not fatal: fall back to the path that was here
    // before, which needs nothing from the server but the bytes.
    let whole = structure.is_empty() || (size > 0 && size <= SMALL_MESSAGE_BYTES);

    if whole {
        let lines = conn
            .command(&[Arg::Text(format!(
                "UID FETCH {} (UID BODY.PEEK[]<0.{}>)",
                uid, MAX_BODY_BYTES
            ))])
            .await?;
        message.raw = Some(
            parse_fetch(&lines)
                .into_iter()
                .next()
                .and_then(|m| m.raw)
                .unwrap_or_default(),
        );
        message.truncated = Some(size as usize > MAX_BODY_BYTES);
        return Ok(message);
    }

    let Some(text) = choose_text_part(&structure).cloned() else {
        // A message that is nothing but attachments. Its structure still
        // describes them, so there is something to show; there is just no body.
        message.truncated = Some(false);
        return Ok(message);
    };

    let lines = conn
        .command(&[Arg::Text(format!(
            "UID FETCH {} (UID BODY.PEEK[{}]<0.{}>)",
            uid, text.part, MAX_BODY_BYTES
        ))])
        .await?;
    message.part = Some(PartResult {
        part: text.part.clone(),
        kind: format!("{}/{}", text.kind, text.subtype),
        encoding: text.encoding.clone(),
        charset: text.params.get("charset").cloned(),
        body: parse_fetch(&lines)
            .into_iter()
            .next()
            .and_then(|m| m.part_body)
            .unwrap_or_default(),
    });
    message.truncated = Some(text.size.unwrap_or(0) as usize > MAX_BODY_BYTES);
    Ok(message)
}

/// Headers for a set of uids. One command; the caller decides which uids.
///
/// A message deleted since the uid list was taken simply comes back missing.
/// That is the whole reason paging over a uid snapshot is safe: there is no
/// offset to shift, so a gap is a gap and never a duplicated or skipped row.
async fn fetch_headers(conn: &mut Conn, uids: &[u32]) -> Result<Vec<Message>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let set: Vec<String> = uids.iter().map(|u| u.to_string()).collect();
    let mut messages = parse_fetch(
        &conn
            .command(&[Arg::Text(format!(
                "UID FETCH {} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS ({})])",
                set.join(","),
                HEADER_FIELDS
            ))])
            .await?,
    );
    messages.sort_by(|a, b| b.uid.cmp(&a.uid));
    Ok(messages)
}

async fn run_op(conn: &mut Conn, op: &MailOp) -> Result<OpResult, String> {
    match op {
        MailOp::List { .. } => Ok(OpResult::List {
            folders: parse_folders(&conn.command(&[Arg::Text("LIST \"\" \"*\"".into())]).await?),
        }),

        // STATUS is the one op that must NOT open the mailbox: the RFC
        // discourages STATUS on a selected mailbox, and there is nothing to
        // gain from EXAMINE here — the whole point is a single command carrying
        // no message data.
        MailOp::Status { mailbox, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            let lines = conn
                .command(&[
                    Arg::Text("STATUS ".into()),
                    astring(mailbox),
                    // UIDVALIDITY rides along: it is what makes the freshness
                    // check able to say "everything you remember about this
                    // mailbox is now meaningless", which no comparison of
                    // counts could ever detect.
                    Arg::Text(" (UIDVALIDITY UIDNEXT MESSAGES UNSEEN)".into()),
                ])
                .await?;
            let (uidnext, messages, unseen, uidvalidity) = parse_status(&lines);
            Ok(OpResult::Status { uidvalidity, uidnext, messages, unseen })
        }

        MailOp::Part { mailbox, uid, part, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            // The part number is INTERPOLATED into `BODY.PEEK[…]`, where IMAP
            // has no quoted form to hide behind the way a search term does — so
            // its shape is checked here rather than trusted, exactly as
            // `is_imap_date` is. The shared schema checks it too; this command
            // is not only reachable from our client.
            if !is_part_number(part) {
                return Err("That is not a part of this message.".to_string());
            }
            let (.., uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("EXAMINE ".into()), astring(mailbox)]).await?);
            // The one op allowed to read megabytes.
            conn.max_response = MAX_ATTACHMENT_WIRE_BYTES + 65_536;
            let lines = conn
                .command(&[Arg::Text(format!(
                    "UID FETCH {} (UID BODY.PEEK[{}]<0.{}>)",
                    uid, part, MAX_ATTACHMENT_WIRE_BYTES
                ))])
                .await?;
            let body = parse_fetch(&lines)
                .into_iter()
                .next()
                .ok_or_else(|| "That message no longer exists.".to_string())?
                .part_body
                .unwrap_or_default();
            let truncated = body.len() >= MAX_ATTACHMENT_WIRE_BYTES;
            Ok(OpResult::Part { uidvalidity, body, truncated })
        }

        MailOp::Headers { mailbox, uids, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            let (.., uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("EXAMINE ".into()), astring(mailbox)]).await?);
            let wanted: Vec<u32> = uids.iter().copied().filter(|u| *u > 0).take(MAX_RESULTS).collect();
            Ok(OpResult::Headers {
                uidvalidity,
                messages: fetch_headers(conn, &wanted).await?,
            })
        }

        MailOp::Fetch { mailbox, uid, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            // EXAMINE, not SELECT: read-only at the protocol level.
            let (.., uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("EXAMINE ".into()), astring(mailbox)]).await?);
            Ok(OpResult::Fetch {
                uidvalidity,
                message: fetch_message(conn, *uid).await?,
            })
        }

        // The two WRITE ops. They open the mailbox with SELECT (read-write)
        // rather than EXAMINE, and they are the only ops that do — see the
        // module header. SELECT shares EXAMINE's response grammar, so
        // `parse_examine` reads its UIDVALIDITY for the cache key just the same.
        MailOp::MarkSeen { mailbox, uid, seen, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            let (.., uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("SELECT ".into()), astring(mailbox)]).await?);
            // Non-SILENT: the untagged FETCH the server sends back carries the
            // resulting flags, so the client learns the real state instead of
            // trusting the write took. `\Seen` is a system flag, a literal — not
            // a caller value — so there is nothing here to quote or inject.
            let sign = if *seen { "+" } else { "-" };
            let lines = conn
                .command(&[Arg::Text(format!("UID STORE {} {}FLAGS (\\Seen)", uid, sign))])
                .await?;
            let flags = parse_fetch(&lines).into_iter().next().map(|m| m.flags).unwrap_or_default();
            Ok(OpResult::MarkSeen { uidvalidity, flags })
        }

        MailOp::Delete { mailbox, uid, trash, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            reject_control(trash, "Mailbox names")?;
            let (.., uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("SELECT ".into()), astring(mailbox)]).await?);
            if mailbox == trash {
                // Already in Trash: nowhere further to move it, so this is the
                // real, permanent removal a user emptying Trash means. Expunge
                // only that uid (UIDPLUS) so a concurrent delete elsewhere can't
                // take an unrelated message with it.
                conn.command(&[Arg::Text(format!("UID STORE {} +FLAGS (\\Deleted)", uid))]).await?;
                conn.command(&[Arg::Text(format!("UID EXPUNGE {}", uid))]).await?;
            } else {
                // The common case: move to Trash, reversible. `trash` is quoted
                // exactly like `mailbox`.
                conn.command(&[Arg::Text(format!("UID MOVE {} ", uid)), astring(trash)]).await?;
            }
            Ok(OpResult::Delete { uidvalidity })
        }

        MailOp::Move { mailbox, uid, dest, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            reject_control(dest, "Mailbox names")?;
            let (.., uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("SELECT ".into()), astring(mailbox)]).await?);
            // The generic file-away: move to a named folder, no expunge branch.
            // `dest` is quoted exactly like `mailbox`.
            conn.command(&[Arg::Text(format!("UID MOVE {} ", uid)), astring(dest)]).await?;
            Ok(OpResult::Move { uidvalidity })
        }

        MailOp::Search {
            mailbox,
            criteria,
            limit,
            ..
        } => {
            reject_control(mailbox, "Mailbox names")?;
            // EXAMINE also volunteers UIDNEXT and EXISTS, which is the
            // freshness baseline for free: a later STATUS can be compared
            // against it without this call paying for a second round trip.
            let (uidnext, exists, uidvalidity) =
                parse_examine(&conn.command(&[Arg::Text("EXAMINE ".into()), astring(mailbox)]).await?);

            let (criteria_args, non_ascii) = search_args(criteria)?;
            let mut args: Vec<Arg> = vec![Arg::Text("UID SEARCH ".into())];
            if non_ascii {
                // Required before non-ASCII keys, and rejected by some servers
                // when there are none — so it is sent only when it is needed.
                args.push(Arg::Text("CHARSET UTF-8 ".into()));
            }
            args.extend(criteria_args);

            let found = parse_uids(&conn.command(&args).await?);
            let limit = (*limit).clamp(1, MAX_RESULTS);
            // Newest last in a UID search, and newest is what a person means by
            // "my mail" — so both the cap and the first page come off the end.
            // Handing back the whole (capped) list rather than just the page is
            // what lets the client page backwards without asking the server to
            // run the query again.
            let uids: Vec<u32> = found.iter().rev().take(MAX_UIDS).copied().collect();
            let page: Vec<u32> = uids.iter().take(limit).copied().collect();
            Ok(OpResult::Search {
                total: found.len(),
                truncated: found.len() > uids.len(),
                uidnext,
                exists,
                uidvalidity,
                messages: fetch_headers(conn, &page).await?,
                uids,
            })
        }
    }
}

/// What to say when LOGIN fails.
///
/// The server's own text is KEPT. An earlier version collapsed every failure
/// here into "check your app-specific password", which was wrong twice over: it
/// mislabelled transport and framing errors as a bad password, and it threw away
/// the one line that says what actually happened
/// (`[AUTHENTICATIONFAILED]`, `[UNAVAILABLE]`, `[ALERT] …`). Apple's refusal
/// text describes the attempt, never the credential, so it is safe to show.
///
/// The username hint is here because it is the difference that catches people:
/// CalDAV accepts any address on the Apple ID, and iCloud Mail does not — an
/// account whose Apple ID is a Gmail or Outlook address must sign in to IMAP
/// with its @icloud.com alias. Same credentials, same server, different rule.
fn login_error(detail: &str) -> String {
    format!(
        "Apple rejected the sign-in: {}. Two things to check: the password must be an app-specific \
         password, not your Apple ID password; and the username must be your @icloud.com address — \
         iCloud Mail does not accept a non-Apple Apple ID here even though Calendar does.",
        detail.trim()
    )
}

async fn connect_and_run(op: MailOp) -> Result<OpResult, String> {
    let creds = op.credentials();
    // The allowlist. Everything else in this file assumes it has already run.
    if !creds.host.eq_ignore_ascii_case(ICLOUD_HOST) || creds.port != ICLOUD_PORT {
        return Err("That mail server is not supported.".to_string());
    }

    let tcp = TcpStream::connect((ICLOUD_HOST, ICLOUD_PORT))
        .await
        .map_err(|_| "Could not reach the mail server. Check your connection.".to_string())?;
    // Implicit TLS, which is what port 993 is — the STARTTLS form on 143 would
    // put the credential a downgrade away.
    let connector = tokio_native_tls::TlsConnector::from(
        native_tls::TlsConnector::new().map_err(|_| "Could not start a secure connection.".to_string())?,
    );
    let stream = connector
        .connect(ICLOUD_HOST, tcp)
        .await
        .map_err(|_| "Could not start a secure connection to the mail server.".to_string())?;

    let mut conn = Conn { stream, buf: Vec::new(), tag: 0, max_response: MAX_RESPONSE_BYTES };

    let greeting = conn.read_response().await?;
    if !(greeting.starts_with("* OK") || greeting.starts_with("* PREAUTH")) {
        return Err("The mail server refused the connection.".to_string());
    }

    if let Err(detail) = conn
        .command(&[
            Arg::Text("LOGIN ".into()),
            astring(&creds.user),
            Arg::Text(" ".into()),
            astring(&creds.pass),
        ])
        .await
    {
        return Err(login_error(&detail));
    }

    let result = run_op(&mut conn, &op).await;
    // A rude goodbye is not an error; the answer is already in hand.
    let _ = conn.command(&[Arg::Text("LOGOUT".into())]).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two framing rules that are invisible until they break: a literal's
    /// bytes are spliced in at its `{n}` marker, and `BODY[…]` is one atom.
    #[test]
    fn parses_a_fetch_with_a_literal() {
        let header = "Subject: Hi\r\n\r\n";
        let line = format!(
            "* 7 FETCH (UID 991 FLAGS (\\Seen) INTERNALDATE \"21-Jul-2026 10:00:00 +0800\" \
             RFC822.SIZE 4096 BODY[HEADER.FIELDS (DATE SUBJECT)] {{{}}}{})",
            header.len(),
            header
        );
        let messages = parse_fetch(&[line]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].uid, 991);
        assert_eq!(messages[0].flags, vec!["\\Seen".to_string()]);
        assert_eq!(messages[0].size, Some(4096));
        assert_eq!(messages[0].headers.as_deref(), Some(header));
    }

    /// `BODY[]<0>` carries an octet range; the atom reader must keep it whole.
    #[test]
    fn parses_a_body_fetch_with_an_octet_range() {
        let body = "hello (world) {not a literal}";
        let line = format!("* 1 FETCH (UID 5 FLAGS () BODY[]<0> {{{}}}{})", body.len(), body);
        let messages = parse_fetch(&[line]);
        assert_eq!(messages[0].raw.as_deref(), Some(body));
    }

    #[test]
    fn drops_unselectable_mailboxes() {
        let folders = parse_folders(&[
            "* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent Messages\"".to_string(),
            "* LIST (\\Noselect \\HasChildren) \"/\" \"Archive\"".to_string(),
            "* LIST (\\HasNoChildren) \"/\" INBOX".to_string(),
        ]);
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["Sent Messages", "INBOX"]
        );
    }

    #[test]
    fn quotes_search_terms_and_falls_back_to_a_literal() {
        match astring("he said \"hi\"\\") {
            Arg::Text(text) => assert_eq!(text, "\"he said \\\"hi\\\"\\\\\""),
            Arg::Literal(_) => panic!("ASCII should be quoted, not sent as a literal"),
        }
        match astring("台北") {
            Arg::Literal(text) => assert_eq!(text, "台北"),
            Arg::Text(_) => panic!("non-ASCII cannot be quoted"),
        }
    }

    #[test]
    fn builds_search_arguments() {
        let (args, non_ascii) = search_args(&Criteria {
            from: Some(vec!["alex".into()]),
            subject: Some(vec!["台北".into()]),
            since: Some("1-Jan-2026".into()),
            unseen: Some(true),
            ..Default::default()
        })
        .expect("valid criteria");
        assert!(non_ascii, "a non-ASCII term must ask for CHARSET UTF-8");
        let rendered: Vec<String> = args
            .iter()
            .map(|a| match a {
                Arg::Text(t) => t.clone(),
                Arg::Literal(t) => format!("<literal:{}>", t),
            })
            .collect();
        // UNDELETED leads every search: mail deleted in another client is
        // waiting for an expunge, and offering to open it is offering mail the
        // user believes is gone. Note also the absence of a trailing space:
        // iCloud answers `BAD Parse Error` to a command that ends with one.
        assert_eq!(
            rendered.join(""),
            "UNDELETED FROM \"alex\" SUBJECT <literal:台北> SINCE 1-Jan-2026 UNSEEN"
        );

        // No criteria is a bare UNDELETED, which is a complete search — so the
        // old `ALL` fallback for an empty key list has nothing left to guard.
        let (empty, _) = search_args(&Criteria::default()).unwrap();
        assert!(matches!(empty.as_slice(), [Arg::Text(t)] if t == "UNDELETED"));

        // `UID n:*` is how new mail arrives without re-running the query.
        let (fresh, _) = search_args(&Criteria { uid_min: Some(9931), ..Default::default() }).unwrap();
        assert!(matches!(fresh.last(), Some(Arg::Text(t)) if t == "UID 9931:*"));
    }

    /// A part number is INTERPOLATED into `BODY.PEEK[…]`. IMAP has no quoted
    /// form for one, so its shape is the whole defence — and this command is
    /// reachable from anything that gets to the IPC bridge, not only our
    /// client, so the shared schema's check is not the only one that matters.
    #[test]
    fn refuses_anything_that_is_not_a_part_number() {
        assert!(is_part_number("1") && is_part_number("2.1") && is_part_number("3.1.12"));
        for bad in [
            "",
            "TEXT",
            "1] BODY[",       // closing the section and opening another
            "1 UID FETCH 1",  // a whole second command
            "1.0",            // parts are 1-based
            "01",             // no leading zeros
            "1.",
            ".1",
            "1..2",
            "-1",
        ] {
            assert!(!is_part_number(bad), "should have been refused: {:?}", bad);
        }
    }

    #[test]
    fn reads_the_freshness_baseline_off_examine() {
        let (uidnext, exists, uidvalidity) = parse_examine(&[
            "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)".to_string(),
            "* 1204 EXISTS".to_string(),
            "* 0 RECENT".to_string(),
            "* OK [UIDVALIDITY 1517159100] UIDs valid".to_string(),
            "* OK [UIDNEXT 9931] Predicted next UID".to_string(),
            // A count of unseen messages is what this LOOKS like and is not
            // what it is — EXAMINE reports the sequence number of the first
            // unseen message. Reading it as a count gives a plausible wrong
            // number, so it is not read at all.
            "* OK [UNSEEN 1198] First unseen".to_string(),
        ]);
        assert_eq!((uidnext, exists, uidvalidity), (9931, 1204, 1_517_159_100));
        assert_eq!(parse_examine(&["* OK [READ-ONLY]".to_string()]), (0, 0, 0));
    }

    #[test]
    fn reads_a_status_response() {
        let (uidnext, messages, unseen, uidvalidity) = parse_status(&[
            "* STATUS \"INBOX\" (MESSAGES 1204 UIDNEXT 9931 UNSEEN 3 UIDVALIDITY 1517159100)".to_string(),
        ]);
        assert_eq!((uidnext, messages, unseen, uidvalidity), (9931, 1204, 3, 1_517_159_100));

        // A non-ASCII mailbox name comes back in the server's own modified
        // UTF-7 and its own quoting — matching it against what we sent is a way
        // to reject a correct answer, so the name is skipped, not compared.
        let (uidnext, ..) = parse_status(&["* STATUS \"&ZeVnLIqe-\" (UIDNEXT 42)".to_string()]);
        assert_eq!(uidnext, 42);
        assert_eq!(parse_status(&["a1 OK done".to_string()]), (0, 0, 0, 0));
    }

    /// The bug that made every filtered search fail against iCloud: each term
    /// appends its own separator, so the last one left a space before the CRLF.
    #[test]
    fn never_ends_a_search_with_a_separator() {
        for criteria in [
            Criteria { unseen: Some(true), ..Default::default() },
            Criteria { from: Some(vec!["alex".into()]), ..Default::default() },
            Criteria { since: Some("1-Jan-2026".into()), ..Default::default() },
            // A literal last: the dangling separator is its own arg, and
            // trimming has to remove it rather than leave an empty token.
            Criteria { subject: Some(vec!["台北".into()]), ..Default::default() },
            Criteria::default(),
        ] {
            let (args, _) = search_args(&criteria).unwrap();
            match args.last().expect("never empty") {
                Arg::Text(last) => assert!(
                    !last.ends_with(' '),
                    "search command ended with a separator: {:?}",
                    last
                ),
                Arg::Literal(_) => {} // a literal ends at its own byte count
            }
        }
    }

    #[test]
    fn refuses_command_injection_through_criteria() {
        let injected = Criteria {
            subject: Some(vec!["x\r\na1 LOGOUT".into()]),
            ..Default::default()
        };
        assert!(search_args(&injected).is_err());
        // A date is interpolated unquoted, so its shape is checked, not trusted.
        let bad_date = Criteria {
            since: Some("1-Jan-2026\r\nx".into()),
            ..Default::default()
        };
        assert!(search_args(&bad_date).is_err());
        assert!(is_imap_date("1-Jan-2026") && !is_imap_date("2026-01-01"));
    }

    // -----------------------------------------------------------------------
    // BODYSTRUCTURE
    //
    // The same cases as `worker/test/imapParse.test.ts`, deliberately. This is
    // the most intricate thing in IMAP and it is written twice; a desktop build
    // and a web build that disagree about which part is the body show different
    // emails for the same click.
    // -----------------------------------------------------------------------

    const TEXT_PLAIN: &str =
        "(\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 1234 30 NIL NIL NIL NIL)";
    const TEXT_HTML: &str =
        "(\"TEXT\" \"HTML\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 5678 90 NIL NIL NIL NIL)";
    const PDF: &str = "(\"APPLICATION\" \"PDF\" (\"NAME\" \"report.pdf\") NIL NIL \"BASE64\" 10485760 NIL \
                       (\"ATTACHMENT\" (\"FILENAME\" \"report.pdf\")) NIL NIL)";

    fn structure(text: &str) -> Vec<BodyPart> {
        let chars: Vec<char> = text.chars().collect();
        let (items, _) = parse_tokens(&chars, 0);
        parse_body_structure(items.first(), "", false, 0)
    }

    #[test]
    fn a_plain_message_is_one_part_numbered_1() {
        let parts = structure(TEXT_PLAIN);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part, "1");
        assert_eq!(parts[0].kind, "text");
        assert_eq!(parts[0].subtype, "plain");
        assert_eq!(parts[0].encoding, "quoted-printable");
        assert_eq!(parts[0].params.get("charset").map(String::as_str), Some("utf-8"));
        assert_eq!(parts[0].size, Some(1234));
        assert_eq!(parts[0].disposition, None);
    }

    #[test]
    fn numbers_multipart_children_and_never_emits_the_multipart() {
        let parts = structure(&format!(
            "(({}{} \"ALTERNATIVE\" (\"BOUNDARY\" \"abc\") NIL NIL NIL){} \"MIXED\" (\"BOUNDARY\" \"def\") NIL NIL NIL)",
            TEXT_PLAIN, TEXT_HTML, PDF
        ));
        assert_eq!(
            parts.iter().map(|p| p.part.as_str()).collect::<Vec<_>>(),
            vec!["1.1", "1.2", "2"]
        );
        assert_eq!(
            parts.iter().map(|p| format!("{}/{}", p.kind, p.subtype)).collect::<Vec<_>>(),
            vec!["text/plain", "text/html", "application/pdf"]
        );
    }

    /// The whole point: a 10 MB attachment's size and name are known without a
    /// byte of it crossing the wire.
    #[test]
    fn reads_an_attachments_true_size_and_name() {
        let parts = structure(&format!(
            "({}{} \"MIXED\" (\"BOUNDARY\" \"d\") NIL NIL NIL)",
            TEXT_PLAIN, PDF
        ));
        assert_eq!(parts[1].disposition.as_deref(), Some("attachment"));
        assert_eq!(parts[1].filename.as_deref(), Some("report.pdf"));
        assert_eq!(parts[1].size, Some(10_485_760));
    }

    /// HTML first — the ordering that made the old walker return flattened
    /// markup when a readable plain part was sitting right behind it.
    #[test]
    fn chooses_the_text_part_by_type_not_position() {
        let parts = structure(&format!(
            "({}{} \"ALTERNATIVE\" (\"BOUNDARY\" \"a\") NIL NIL NIL)",
            TEXT_HTML, TEXT_PLAIN
        ));
        let chosen = choose_text_part(&parts).expect("a plain part exists");
        assert_eq!(chosen.part, "2");
        assert_eq!(chosen.subtype, "plain");

        // HTML-only still has a body.
        let html_only = structure(&format!(
            "({} \"ALTERNATIVE\" (\"BOUNDARY\" \"a\") NIL NIL NIL)",
            TEXT_HTML
        ));
        assert_eq!(choose_text_part(&html_only).unwrap().subtype, "html");

        // Attachments only: nothing to show, and that is not an error.
        let no_text = structure(&format!(
            "({}{} \"MIXED\" (\"BOUNDARY\" \"a\") NIL NIL NIL)",
            PDF, PDF
        ));
        assert!(choose_text_part(&no_text).is_none());
    }

    #[test]
    fn lists_an_attached_email_and_looks_inside_it() {
        let nested = format!(
            "({}{} \"ALTERNATIVE\" (\"BOUNDARY\" \"in\") NIL NIL NIL)",
            TEXT_PLAIN, TEXT_HTML
        );
        let rfc822 = format!(
            "(\"MESSAGE\" \"RFC822\" (\"NAME\" \"fwd.eml\") NIL NIL \"7BIT\" 4321 \
             (\"Tue, 21 Jul 2026 10:00:00 +0800\" \"Fwd\" NIL NIL NIL NIL NIL NIL NIL NIL) \
             {} 50 NIL (\"ATTACHMENT\" (\"FILENAME\" \"fwd.eml\")) NIL NIL)",
            nested
        );
        let parts = structure(&format!(
            "({}{} \"MIXED\" (\"BOUNDARY\" \"out\") NIL NIL NIL)",
            TEXT_PLAIN, rfc822
        ));

        assert_eq!(
            parts.iter().map(|p| p.part.as_str()).collect::<Vec<_>>(),
            vec!["1", "2", "2.1", "2.2"]
        );
        assert_eq!(parts[1].filename.as_deref(), Some("fwd.eml"));
        // The attached message is a part of THIS message, so it is not
        // embedded — what is embedded is everything inside it, which is what
        // keeps the forwarded email's body from becoming this email's body.
        assert_eq!(
            parts.iter().map(|p| p.embedded).collect::<Vec<_>>(),
            vec![false, false, true, true]
        );
        assert_eq!(choose_text_part(&parts).unwrap().part, "1");
    }

    #[test]
    fn falls_back_to_an_attached_emails_text_when_there_is_no_other() {
        let rfc822 = format!(
            "(\"MESSAGE\" \"RFC822\" NIL NIL NIL \"7BIT\" 4321 \
             (\"date\" \"subj\" NIL NIL NIL NIL NIL NIL NIL NIL) {} 50 NIL NIL NIL NIL)",
            TEXT_PLAIN
        );
        let parts = structure(&format!(
            "({}{} \"MIXED\" (\"BOUNDARY\" \"o\") NIL NIL NIL)",
            PDF, rfc822
        ));
        assert_eq!(
            parts.iter().map(|p| p.part.as_str()).collect::<Vec<_>>(),
            vec!["1", "2", "2.1"]
        );
        assert_eq!(choose_text_part(&parts).unwrap().part, "2.1");
    }

    /// `BODY[HEADER.FIELDS (…)]`, `BODY[]<0>` and `BODY[2.1]<0>` all start
    /// `BODY[` and mean three different things.
    #[test]
    fn tells_body_keys_apart_by_specificity() {
        let headers = "Subject: Hi\r\n\r\n";
        let part = "SGVsbG8=";
        let messages = parse_fetch(&[
            format!(
                "* 7 FETCH (UID 991 FLAGS (\\Seen) RFC822.SIZE 900000 \
                 BODY[HEADER.FIELDS (DATE SUBJECT)] {{{}}}{} \
                 BODYSTRUCTURE ({}{} \"MIXED\" (\"BOUNDARY\" \"d\") NIL NIL NIL))",
                headers.len(),
                headers,
                TEXT_PLAIN,
                PDF
            ),
            format!("* 7 FETCH (UID 991 BODY[1]<0> {{{}}}{})", part.len(), part),
        ]);
        assert_eq!(messages[0].headers.as_deref(), Some(headers));
        assert!(messages[0].raw.is_none());
        assert_eq!(
            messages[0]
                .structure
                .as_ref()
                .unwrap()
                .iter()
                .map(|p| p.part.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "2"]
        );
        assert_eq!(messages[1].part_body.as_deref(), Some(part));
        assert!(messages[1].raw.is_none());
    }

    /// A structure we cannot read is empty, never a phantom part — the caller
    /// treats empty as "fall back to fetching the whole message".
    #[test]
    fn junk_in_empty_out() {
        assert!(structure("NIL").is_empty());
        assert!(structure("()").is_empty());
        assert!(choose_text_part(&[]).is_none());
    }

    /// The two write ops issue exactly one constrained mutation each, and this
    /// pins their command shape. `\Seen` and `\Deleted` are system-flag literals
    /// (never caller values), the uid is a validated integer interpolated as
    /// everywhere else, and a mailbox name goes through `astring` — so a crafted
    /// Trash name is quoted, not command syntax. Mirrors the same intent in
    /// `worker/src/imap.ts`.
    #[test]
    fn write_ops_build_the_expected_commands() {
        assert_eq!(format!("UID STORE {} {}FLAGS (\\Seen)", 991, "+"), "UID STORE 991 +FLAGS (\\Seen)");
        assert_eq!(format!("UID STORE {} {}FLAGS (\\Seen)", 991, "-"), "UID STORE 991 -FLAGS (\\Seen)");
        assert_eq!(format!("UID STORE {} +FLAGS (\\Deleted)", 991), "UID STORE 991 +FLAGS (\\Deleted)");
        assert_eq!(format!("UID EXPUNGE {}", 991), "UID EXPUNGE 991");
        assert_eq!(format!("UID MOVE {} ", 991), "UID MOVE 991 ");
        // A Trash mailbox name is a quoted astring; anything trying to break out
        // is escaped inside the quotes rather than run as syntax.
        match astring("Deleted Messages") {
            Arg::Text(t) => assert_eq!(t, "\"Deleted Messages\""),
            Arg::Literal(_) => panic!("an ASCII mailbox name should be quoted"),
        }
        match astring("x\" UID EXPUNGE 1:*") {
            Arg::Text(t) => assert_eq!(t, "\"x\\\" UID EXPUNGE 1:*\""),
            Arg::Literal(_) => panic!("ASCII should be quoted, not a literal"),
        }
    }

    #[test]
    fn finds_the_literal_marker_only_at_the_end() {
        assert_eq!(literal_length("* 1 FETCH (BODY[] {17}"), Some(17));
        assert_eq!(literal_length("* 1 FETCH (FLAGS ())"), None);
        assert_eq!(literal_length("a1 OK done"), None);
    }
}

/// Run one IMAP op against iCloud and return its raw result.
///
/// Stateless by design: connect, log in, one command, log out. Keeping a
/// session alive between calls would mean owning a connection pool in Rust and
/// a lifecycle the web path (which cannot have one) does not share.
#[tauri::command]
pub async fn imap_op(op: MailOp) -> Result<OpResult, String> {
    let deadline = if matches!(op, MailOp::Part { .. }) { PART_DEADLINE } else { DEADLINE };
    match tokio::time::timeout(deadline, connect_and_run(op)).await {
        Ok(result) => result,
        Err(_) => Err("The mail server took too long to answer.".to_string()),
    }
}
