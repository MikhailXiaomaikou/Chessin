//! PGN export of a decoded game.

use std::io::Write;

use crate::{Game, Node};

const LINE_WIDTH: usize = 80;

fn escape_tag(v: &str) -> String {
    v.replace('\\', "\\\\").replace('"', "\\\"")
}

fn or_unknown(v: &str) -> String {
    if v.is_empty() {
        "?".to_string()
    } else {
        v.to_string()
    }
}

/// Makes a comment safe to put between braces.
fn sanitize_comment(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('}', ")")
        .trim()
        .to_string()
}

fn merged_comment(text: Option<&str>, commands: &[String]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = text {
        let t = sanitize_comment(t);
        if !t.is_empty() {
            parts.push(t);
        }
    }
    parts.extend(commands.iter().cloned());
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Writes one move with its comments and glyphs. Returns whether something
/// followed the move that forces the next black move to carry its number.
fn write_move(nodes: &[Node], idx: usize, out: &mut String, force_number: bool) -> bool {
    let n = &nodes[idx];
    let mut force = force_number;
    if let Some(c) = merged_comment(n.comment_before.as_deref(), &[]) {
        out.push('{');
        out.push_str(&c);
        out.push_str("} ");
        force = true;
    }
    if n.white {
        out.push_str(&format!("{}. ", n.fullmove));
    } else if force {
        out.push_str(&format!("{}... ", n.fullmove));
    }
    out.push_str(&n.san);
    for nag in &n.nags {
        out.push_str(&format!(" ${nag}"));
    }
    out.push(' ');
    match merged_comment(n.comment_after.as_deref(), &n.commands) {
        Some(c) => {
            out.push('{');
            out.push_str(&c);
            out.push_str("} ");
            true
        }
        None => false,
    }
}

/// Writes the line that starts at `start`: at each node the main continuation
/// first, then every other child as a parenthesised variation.
fn write_line(nodes: &[Node], start: usize, out: &mut String, force_number: bool) {
    let mut cur = start;
    let mut force = force_number;
    loop {
        let children = &nodes[cur].children;
        let Some(&main) = children.first() else {
            break;
        };
        let mut interrupted = write_move(nodes, main, out, force);
        for &var in &children[1..] {
            out.push('(');
            write_move(nodes, var, out, true);
            write_line(nodes, var, out, false);
            while out.ends_with(' ') {
                out.pop();
            }
            out.push_str(") ");
            interrupted = true;
        }
        force = interrupted;
        cur = main;
    }
}

/// Splits movetext into tokens at spaces, keeping each `{...}` comment whole so
/// a line break never lands inside a `[%...]` command.
fn tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = None;
    let mut in_comment = false;
    for (i, c) in text.char_indices() {
        match c {
            ' ' if !in_comment => {
                if let Some(s) = start.take() {
                    out.push(&text[s..i]);
                }
            }
            '{' if !in_comment => {
                in_comment = true;
                start.get_or_insert(i);
            }
            '}' if in_comment => in_comment = false,
            _ => {
                start.get_or_insert(i);
            }
        }
    }
    if let Some(s) = start {
        out.push(&text[s..]);
    }
    out
}

fn wrap(text: &str) -> String {
    let mut out = String::new();
    let mut col = 0usize;
    for token in tokens(text) {
        let width = token.chars().count();
        if col > 0 && col + 1 + width > LINE_WIDTH {
            out.push('\n');
            col = 0;
        } else if col > 0 {
            out.push(' ');
            col += 1;
        }
        out.push_str(token);
        match token.rfind('\n') {
            Some(i) => col = token[i + 1..].chars().count(),
            None => col += width,
        }
    }
    out
}

/// The movetext of a game, wrapped, with the result at the end.
pub fn movetext(game: &Game) -> String {
    let mut out = String::new();
    if let Some(c) = merged_comment(game.game_comment.as_deref(), &game.game_commands) {
        out.push('{');
        out.push_str(&c);
        out.push_str("} ");
    }
    if !game.nodes.is_empty() {
        write_line(&game.nodes, 0, &mut out, true);
    }
    out.push_str(&game.headers.result);
    wrap(&out)
}

/// Writes the game as one PGN game followed by a blank line.
pub fn write_pgn<W: Write>(game: &Game, w: &mut W) -> std::io::Result<()> {
    let h = &game.headers;
    let mut tags: Vec<(&str, String)> = vec![
        ("Event", or_unknown(&h.event)),
        ("Site", or_unknown(&h.site)),
        ("Date", h.date.clone()),
        ("Round", or_unknown(&h.round)),
        ("White", or_unknown(&h.white)),
        ("Black", or_unknown(&h.black)),
        ("Result", h.result.clone()),
    ];
    if let Some(e) = h.white_elo {
        tags.push(("WhiteElo", e.to_string()));
    }
    if let Some(e) = h.black_elo {
        tags.push(("BlackElo", e.to_string()));
    }
    if let Some(eco) = &h.eco {
        tags.push(("ECO", eco.clone()));
    }
    if let Some(d) = &h.event_date {
        tags.push(("EventDate", d.clone()));
    }
    if let Some(a) = &h.annotator {
        tags.push(("Annotator", a.clone()));
    }
    if let Some(s) = &h.source {
        tags.push(("Source", s.clone()));
    }
    if let Some(tc) = &h.time_control {
        tags.push(("TimeControl", tc.clone()));
    }
    if h.forfeit {
        tags.push(("Termination", "forfeit".to_string()));
    }
    if game.chess960 {
        tags.push(("Variant", "Chess960".to_string()));
    }
    if let Some(fen) = &game.setup_fen {
        tags.push(("SetUp", "1".to_string()));
        tags.push(("FEN", fen.clone()));
    }
    for (name, value) in tags {
        writeln!(w, "[{name} \"{}\"]", escape_tag(&value))?;
    }
    writeln!(w)?;
    writeln!(w, "{}", movetext(game))?;
    writeln!(w)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Headers;

    fn node(san: &str, white: bool, fullmove: u32) -> Node {
        Node {
            san: san.to_string(),
            white,
            fullmove,
            ..Node::default()
        }
    }

    fn game() -> Game {
        // 1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4
        let mut nodes = vec![Node::default()];
        nodes.push(node("e4", true, 1)); // 1
        nodes.push(node("c5", false, 1)); // 2
        nodes.push(node("Nf3", true, 2)); // 3
        nodes.push(node("d6", false, 2)); // 4
        nodes.push(node("d4", true, 3)); // 5
        nodes.push(node("Nc6", false, 2)); // 6
        nodes.push(node("Bb5", true, 3)); // 7
        nodes.push(node("c6", false, 1)); // 8
        nodes.push(node("d4", true, 2)); // 9
        nodes.push(node("Nf6", false, 1)); // 10
        nodes.push(node("e5", true, 2)); // 11
        nodes[0].children = vec![1];
        nodes[1].children = vec![2, 8, 10];
        nodes[2].children = vec![3];
        nodes[3].children = vec![4, 6];
        nodes[4].children = vec![5];
        nodes[6].children = vec![7];
        nodes[8].children = vec![9];
        nodes[10].children = vec![11];
        Game {
            id: 1,
            headers: Headers {
                white: "Carlsen, Magnus".into(),
                black: "Ding, Liren".into(),
                date: "2024.01.13".into(),
                result: "1-0".into(),
                event: "Tata Steel".into(),
                site: "Wijk aan Zee".into(),
                round: "3".into(),
                white_elo: Some(2830),
                black_elo: None,
                eco: Some("B50".into()),
                ..Headers::default()
            },
            nodes,
            ..Game::default()
        }
    }

    #[test]
    fn writes_the_spec_example_tree() {
        let mut out = Vec::new();
        write_pgn(&game(), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(
            text,
            "[Event \"Tata Steel\"]\n[Site \"Wijk aan Zee\"]\n[Date \"2024.01.13\"]\n[Round \"3\"]\n[White \"Carlsen, Magnus\"]\n[Black \"Ding, Liren\"]\n[Result \"1-0\"]\n[WhiteElo \"2830\"]\n[ECO \"B50\"]\n\n1. e4 c5 (1... c6 2. d4) (1... Nf6 2. e5) 2. Nf3 d6 (2... Nc6 3. Bb5) 3. d4 1-0\n\n"
        );
    }

    #[test]
    fn comments_glyphs_and_commands() {
        let mut g = game();
        g.game_comment = Some("Game\r\nnote".into());
        g.game_commands = vec!["[%clk 1:00:00]".into()];
        g.nodes[1].comment_before = Some("before".into());
        g.nodes[1].nags = vec![1, 14];
        g.nodes[1].comment_after = Some("after } brace".into());
        g.nodes[1].commands = vec!["[%csl Ge4]".into(), "[%eval 0.30]".into()];
        g.nodes[2].comment_after = Some("   ".into());
        g.nodes[3].comment_after = Some("x".into());
        g.nodes[5].is_null = true;
        g.nodes[5].san = "--".into();
        g.setup_fen = Some("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into());
        g.headers.annotator = Some("A \"B\"".into());
        g.headers.forfeit = true;
        let text = movetext(&g);
        assert_eq!(
            text,
            "{Game\nnote [%clk 1:00:00]} {before} 1. e4 $1 $14\n{after ) brace [%csl Ge4] [%eval 0.30]} 1... c5 (1... c6 2. d4) (1... Nf6 2. e5)\n2. Nf3 {x} 2... d6 (2... Nc6 3. Bb5) 3. -- 1-0"
        );
        let mut out = Vec::new();
        write_pgn(&g, &mut out).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("[Annotator \"A \\\"B\\\"\"]"));
        assert!(s.contains("[Termination \"forfeit\"]"));
        assert!(s.contains("[SetUp \"1\"]\n[FEN \"rnbqkbnr/"));
    }

    #[test]
    fn wraps_long_lines_at_spaces() {
        let text = (1..=40)
            .map(|i| format!("{i}. e4 e5"))
            .collect::<Vec<_>>()
            .join(" ");
        for line in wrap(&text).lines() {
            assert!(line.len() <= LINE_WIDTH, "{line}");
        }
        assert_eq!(wrap("a b"), "a b");
    }

    #[test]
    fn empty_game_is_just_the_result() {
        let mut g = game();
        g.nodes = vec![Node::default()];
        g.headers.result = "*".into();
        assert_eq!(movetext(&g), "*");
        g.nodes.clear();
        assert_eq!(movetext(&g), "*");
    }
}
