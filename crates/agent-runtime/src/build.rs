//! Prompts for building one PRD step with the harness.

use crate::strip_frontmatter;

const BUILD_SKILL: &str = include_str!("../../../skills/product/build-story/SKILL.md");

/// The skill plus the rules of this session: one writable file, no commands.
pub fn build_system_prompt(write_path: &str) -> String {
    format!(
        "{}\n\n## How this session runs\n\n\
         - You can read, list and search files in the project folder.\n\
         - You can write only `{write_path}`.\n\
         - Keep the whole app in that one file, with CSS and JS inline and no external URLs (the preview blocks them).\n\
         - You cannot run anything.\n\
         - When you are done, reply without tool calls with a short summary of what you built and which acceptance lines you think now pass.\n",
        strip_frontmatter(BUILD_SKILL).trim_end()
    )
}

/// From the `### {id}. ` heading up to the next `### ` or `## ` line.
pub fn story_section(prd: &str, story_id: &str) -> Option<String> {
    let head = format!("### {story_id}. ");
    let mut lines = prd.lines().skip_while(|l| !l.starts_with(&head)).peekable();
    lines.peek()?;
    let mut out = String::new();
    for (i, line) in lines.enumerate() {
        if i > 0 && (line.starts_with("### ") || line.starts_with("## ")) {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

pub fn build_prompt(prd: &str, story_id: &str) -> Result<String, String> {
    let section = story_section(prd, story_id).ok_or_else(|| format!("{story_id} is not a step in prd.md"))?;
    Ok(format!(
        "Build step {story_id} now.\n\n{}\n\nThe whole PRD, for context:\n\n{prd}",
        section.trim_end()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRD: &str = "# Orders\n\n## Steps\n\n### S1. List orders\nShow ORD-2041.\n- [ ] the list shows ORD-2041\n\n### S2. Filter\nBy customer.\n\n## Later\n- export\n";

    #[test]
    fn a_story_is_its_heading_up_to_the_next_heading() {
        let s1 = story_section(PRD, "S1").unwrap();
        assert_eq!(s1.trim(), "### S1. List orders\nShow ORD-2041.\n- [ ] the list shows ORD-2041");
        let s2 = story_section(PRD, "S2").unwrap();
        assert!(s2.contains("By customer.") && !s2.contains("## Later"));
    }

    #[test]
    fn unknown_steps_are_an_error() {
        assert_eq!(build_prompt(PRD, "S9").unwrap_err(), "S9 is not a step in prd.md");
    }

    #[test]
    fn the_system_prompt_names_the_one_file() {
        let p = build_system_prompt("app/index.html");
        assert!(p.contains("app/index.html") && p.contains("## How this session runs"));
        assert!(!p.contains("---\nname:"));
    }
}
