//! A shell command, read as the commands it runs, or not at all.
//!
//! Deliberately a small subset of shell: words, quotes, escapes, comments and
//! the operators `;`, `&`, `&&`, `|`, `|&`, `||` and newline. Anything else
//! (a redirect, subshell, group, substitution, heredoc, control word) returns
//! `None`, and so does anything malformed, because `None` is the answer that
//! fails safe: every caller keeps its old behaviour on it.
//!
//! `@intutic/gate` `shellParse.ts` and intutic-clawde `gate/shell_parse.py` are
//! ports. All three run `shell-parse-vectors.json` in `@intutic/shared-types`.

/// Words that open a construct this parser does not model. `alias` is here
/// because it changes what the next word means.
const CONTROL_WORDS: &[&str] = &[
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
    "select", "function", "coproc", "alias",
];

/// One command and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimpleCommand {
    /// The words after quote removal.
    pub argv: Vec<String>,
    /// False when a word still holds an expansion or glob, so `argv` is not
    /// exactly what runs.
    pub literal: bool,
    /// Where it sits in the text, as byte offsets.
    pub start: usize,
    pub end: usize,
}

/// `text` as pipelines of simple commands, or `None` when not understood.
pub fn parse(text: &str) -> Option<Vec<Vec<SimpleCommand>>> {
    let b = text.as_bytes();
    let mut pipelines: Vec<Vec<SimpleCommand>> = Vec::new();
    let mut pipeline: Vec<SimpleCommand> = Vec::new();
    let mut command: Option<SimpleCommand> = None;
    let mut word: Option<Vec<u8>> = None;
    let mut pipe_open = false;
    let mut i = 0;

    fn start_word(word: &mut Option<Vec<u8>>, command: &mut Option<SimpleCommand>, at: usize) {
        word.get_or_insert_with(Vec::new);
        command.get_or_insert(SimpleCommand {
            argv: Vec::new(),
            literal: true,
            start: at,
            end: at,
        });
    }
    fn end_word(word: &mut Option<Vec<u8>>, command: &mut Option<SimpleCommand>, at: usize) {
        if let (Some(w), Some(c)) = (word.take(), command.as_mut()) {
            c.argv.push(String::from_utf8_lossy(&w).into_owned());
            c.end = at;
        }
    }

    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' => {
                end_word(&mut word, &mut command, i);
                i += 1;
            }
            b'\\' if b.get(i + 1) == Some(&b'\n') => i += 2,
            b'\\' => {
                let next = *b.get(i + 1)?;
                start_word(&mut word, &mut command, i);
                word.as_mut()?.push(next);
                i += 2;
            }
            b'\'' => {
                start_word(&mut word, &mut command, i);
                i += 1;
                while *b.get(i)? != b'\'' {
                    word.as_mut()?.push(b[i]);
                    i += 1;
                }
                i += 1;
            }
            b'"' => {
                start_word(&mut word, &mut command, i);
                i += 1;
                loop {
                    let q = *b.get(i)?;
                    match q {
                        b'"' => break,
                        b'`' => return None,
                        b'$' if b.get(i + 1) == Some(&b'(') => return None,
                        b'$' => command.as_mut()?.literal = false,
                        b'\\' => {
                            let next = *b.get(i + 1)?;
                            if !matches!(next, b'$' | b'"' | b'\\' | b'`' | b'\n') {
                                word.as_mut()?.push(b'\\');
                            }
                            if next != b'\n' {
                                word.as_mut()?.push(next);
                            }
                            i += 2;
                            continue;
                        }
                        _ => {}
                    }
                    word.as_mut()?.push(q);
                    i += 1;
                }
                i += 1;
            }
            b'#' if word.is_none() => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'<' | b'>' | b'(' | b')' | b'{' | b'}' | b'`' => return None,
            b'\n' | b';' | b'&' | b'|' => {
                end_word(&mut word, &mut command, i);
                let doubled = matches!(c, b'&' | b'|') && b.get(i + 1) == Some(&c);
                match command.take() {
                    Some(done) => {
                        if CONTROL_WORDS.contains(&done.argv[0].as_str()) {
                            return None;
                        }
                        pipeline.push(done);
                    }
                    // A newline may follow an operator or stand alone. Any
                    // other operator here has nothing to its left.
                    None if c == b'\n' => {
                        i += 1;
                        continue;
                    }
                    None => return None,
                }
                pipe_open = c == b'|' && !doubled;
                if pipe_open {
                    if b.get(i + 1) == Some(&b'&') {
                        i += 1;
                    }
                } else {
                    pipelines.push(std::mem::take(&mut pipeline));
                }
                i += if doubled { 2 } else { 1 };
            }
            _ => {
                if matches!(c, b'$' | b'*' | b'?' | b'[' | b'~')
                    || word.is_none() && is_assignment(&b[i..])
                {
                    start_word(&mut word, &mut command, i);
                    command.as_mut()?.literal = false;
                }
                start_word(&mut word, &mut command, i);
                word.as_mut()?.push(c);
                i += 1;
            }
        }
    }
    end_word(&mut word, &mut command, b.len());
    if let Some(done) = command.take() {
        if CONTROL_WORDS.contains(&done.argv[0].as_str()) {
            return None;
        }
        pipeline.push(done);
    } else if pipe_open {
        return None;
    }
    if !pipeline.is_empty() {
        pipelines.push(pipeline);
    }
    Some(pipelines)
}

/// Does this word start `NAME=`? It sets a variable for the command after it.
fn is_assignment(rest: &[u8]) -> bool {
    let name = rest
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_')
        .count();
    name > 0 && !rest[0].is_ascii_digit() && rest.get(name) == Some(&b'=')
}

/// `text` without the text no command consumes: a lone `echo`, `printf` or
/// `git commit`. Unchanged unless the whole of it parsed.
pub fn drop_carried_text(text: &str) -> String {
    let Some(pipelines) = parse(text) else {
        return text.to_string();
    };
    let mut out = String::with_capacity(text.len());
    let mut kept = 0;
    for pipeline in &pipelines {
        if let [only] = pipeline.as_slice() {
            let carries = matches!(only.argv[0].as_str(), "echo" | "printf")
                || only
                    .argv
                    .starts_with(&["git".to_string(), "commit".to_string()]);
            if carries {
                out.push_str(&text[kept..only.start]);
                kept = only.end;
            }
        }
    }
    out.push_str(&text[kept..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shared_vector_parses_as_listed() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared-types/fixtures/shell-parse-vectors.json");
        let body = std::fs::read_to_string(&path).expect("shell-parse-vectors.json is readable");
        let doc: serde_json::Value = serde_json::from_str(&body).expect("the vectors parse");
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() > 40, "the vector file lost its cases");
        for case in cases {
            let text = case["text"].as_str().expect("text");
            let got = parse(text).map(|pipelines| {
                pipelines
                    .iter()
                    .map(|p| {
                        p.iter()
                            .map(|c| serde_json::json!({ "argv": c.argv, "literal": c.literal }))
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            });
            assert_eq!(
                serde_json::to_value(&got).expect("serialises"),
                case["parsed"],
                "{text:?}"
            );
        }
    }
}
