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
//!   * **Read-only.** EXAMINE, never SELECT; BODY.PEEK, never BODY. The server
//!     itself then refuses anything that would change the mailbox.
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
const MAX_RESPONSE_BYTES: usize = MAX_BODY_BYTES + 65_536;
const MAX_RESULTS: usize = 100;
const DEADLINE: Duration = Duration::from_secs(20);
const HEADER_FIELDS: &str = "DATE SUBJECT FROM TO CC REPLY-TO MESSAGE-ID CONTENT-TYPE LIST-ID";

// ---------------------------------------------------------------------------
// The op envelope (mirror of packages/shared/src/mail.ts)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct Criteria {
    from: Option<String>,
    to: Option<String>,
    subject: Option<String>,
    text: Option<String>,
    since: Option<String>,
    before: Option<String>,
    unseen: Option<bool>,
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
}

impl MailOp {
    fn credentials(&self) -> &Credentials {
        match self {
            MailOp::List { creds } => creds,
            MailOp::Search { creds, .. } => creds,
            MailOp::Fetch { creds, .. } => creds,
        }
    }
}

#[derive(Serialize)]
pub struct Folder {
    name: String,
    delimiter: String,
    flags: Vec<String>,
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
    truncated: Option<bool>,
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
        messages: Vec<Message>,
    },
    Fetch {
        message: Message,
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
            if self.buf.len() > MAX_RESPONSE_BYTES {
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
            if n > MAX_RESPONSE_BYTES || out.len() + n > MAX_RESPONSE_BYTES {
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
                _ if key.starts_with("BODY[HEADER") => msg.headers = Some(value.text().to_string()),
                _ if key.starts_with("BODY[]") => msg.raw = Some(value.text().to_string()),
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
    let mut args: Vec<Arg> = Vec::new();
    let mut non_ascii = false;

    for (key, value) in [
        ("FROM", &criteria.from),
        ("TO", &criteria.to),
        ("SUBJECT", &criteria.subject),
        ("TEXT", &criteria.text),
    ] {
        let Some(value) = value else { continue };
        reject_control(value, "Search terms")?;
        if !value.is_ascii() {
            non_ascii = true;
        }
        args.push(Arg::Text(format!("{} ", key)));
        args.push(astring(value));
        args.push(Arg::Text(" ".to_string()));
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
    if args.is_empty() {
        args.push(Arg::Text("ALL".to_string()));
    }

    // NO TRAILING SPACE BEFORE THE CRLF. Each term above appends its own
    // separator, which leaves one dangling on the last of them, and iCloud
    // answers `BAD Parse Error` to `UID SEARCH UNSEEN ` — the space is a token
    // boundary promising a search key that never arrives. `ALL` was the only
    // branch that didn't append one, which is why an unfiltered list worked and
    // every filter failed.
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

async fn run_op(conn: &mut Conn, op: &MailOp) -> Result<OpResult, String> {
    match op {
        MailOp::List { .. } => Ok(OpResult::List {
            folders: parse_folders(&conn.command(&[Arg::Text("LIST \"\" \"*\"".into())]).await?),
        }),

        MailOp::Fetch { mailbox, uid, .. } => {
            reject_control(mailbox, "Mailbox names")?;
            // EXAMINE, not SELECT: read-only at the protocol level.
            conn.command(&[Arg::Text("EXAMINE ".into()), astring(mailbox)]).await?;
            let lines = conn
                .command(&[Arg::Text(format!(
                    "UID FETCH {} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.{}>)",
                    uid, MAX_BODY_BYTES
                ))])
                .await?;
            let mut message = parse_fetch(&lines)
                .into_iter()
                .next()
                .ok_or_else(|| "That message no longer exists.".to_string())?;
            message.truncated = Some(message.size.unwrap_or(0) as usize > MAX_BODY_BYTES);
            Ok(OpResult::Fetch { message })
        }

        MailOp::Search {
            mailbox,
            criteria,
            limit,
            ..
        } => {
            reject_control(mailbox, "Mailbox names")?;
            conn.command(&[Arg::Text("EXAMINE ".into()), astring(mailbox)]).await?;

            let (criteria_args, non_ascii) = search_args(criteria)?;
            let mut args: Vec<Arg> = vec![Arg::Text("UID SEARCH ".into())];
            if non_ascii {
                // Required before non-ASCII keys, and rejected by some servers
                // when there are none — so it is sent only when it is needed.
                args.push(Arg::Text("CHARSET UTF-8 ".into()));
            }
            args.extend(criteria_args);

            let uids = parse_uids(&conn.command(&args).await?);
            let limit = (*limit).clamp(1, MAX_RESULTS);
            // Newest last in a UID search, and newest is what a person means by
            // "my mail" — so the window comes off the end.
            let wanted: Vec<u32> = uids.iter().rev().take(limit).rev().copied().collect();
            if wanted.is_empty() {
                return Ok(OpResult::Search {
                    total: 0,
                    truncated: false,
                    messages: Vec::new(),
                });
            }

            let set: Vec<String> = wanted.iter().map(|u| u.to_string()).collect();
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
            Ok(OpResult::Search {
                total: uids.len(),
                truncated: uids.len() > wanted.len(),
                messages,
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

    let mut conn = Conn { stream, buf: Vec::new(), tag: 0 };

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
            from: Some("alex".into()),
            subject: Some("台北".into()),
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
        // Note the absence of a trailing space: iCloud answers `BAD Parse
        // Error` to a command that ends with one.
        assert_eq!(
            rendered.join(""),
            "FROM \"alex\" SUBJECT <literal:台北> SINCE 1-Jan-2026 UNSEEN"
        );

        // No criteria is ALL — an empty key list is a syntax error, not
        // "everything".
        let (empty, _) = search_args(&Criteria::default()).unwrap();
        assert!(matches!(empty.as_slice(), [Arg::Text(t)] if t == "ALL"));
    }

    /// The bug that made every filtered search fail against iCloud: each term
    /// appends its own separator, so the last one left a space before the CRLF.
    #[test]
    fn never_ends_a_search_with_a_separator() {
        for criteria in [
            Criteria { unseen: Some(true), ..Default::default() },
            Criteria { from: Some("alex".into()), ..Default::default() },
            Criteria { since: Some("1-Jan-2026".into()), ..Default::default() },
            // A literal last: the dangling separator is its own arg, and
            // trimming has to remove it rather than leave an empty token.
            Criteria { subject: Some("台北".into()), ..Default::default() },
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
            subject: Some("x\r\na1 LOGOUT".into()),
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
    match tokio::time::timeout(DEADLINE, connect_and_run(op)).await {
        Ok(result) => result,
        Err(_) => Err("The mail server took too long to answer.".to_string()),
    }
}
