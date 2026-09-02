use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// The only shell Control Room renders for. Structured inspection targets Bash
/// hosts, and quoting rules are not portable, so the shell is recorded on every
/// snippet instead of being assumed.
pub const SNIPPET_SHELL: &str = "bash";

pub const KIND_STRING: &str = "string";
pub const KIND_INTEGER: &str = "integer";
pub const KIND_CHOICE: &str = "choice";

pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_TEMPLATE_CHARS: usize = 2000;
pub const MAX_PARAMETERS: usize = 8;
pub const MAX_PROMPT_CHARS: usize = 80;
pub const MAX_CHOICES: usize = 20;
pub const MAX_CHOICE_CHARS: usize = 64;
pub const MAX_VALUE_CHARS: usize = 512;
pub const MAX_RENDERED_CHARS: usize = 4000;
pub const MAX_SNIPPETS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetParameter {
    pub name: String,
    pub prompt: String,
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub minimum: Option<i64>,
    #[serde(default)]
    pub maximum: Option<i64>,
    /// Author-set, not a value anyone entered. Entered values are never stored.
    #[serde(default)]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandSnippet {
    pub id: String,
    pub name: String,
    pub template: String,
    pub parameters: Vec<SnippetParameter>,
    pub shell: String,
    pub connection_id: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSnippetInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub template: String,
    #[serde(default)]
    pub parameters: Vec<SnippetParameter>,
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetError {
    /// The parameter the message belongs to, so a form can show it in place.
    pub parameter: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRender {
    /// The exact text that will be inserted, or nothing when a value is not
    /// usable. Preview and insertion read this same field.
    pub command: Option<String>,
    pub errors: Vec<SnippetError>,
    pub shell: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplatePart {
    Literal(String),
    Parameter(String),
}

fn has_control_characters(value: &str) -> bool {
    value.chars().any(char::is_control)
}

pub fn valid_parameter_name(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() || value.len() > 32 {
        return false;
    }
    characters.all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    })
}

/// `{{name}}` and nothing else. A lone brace is literal; an unclosed or nested
/// placeholder is an error rather than a guess.
pub fn parse_template(template: &str) -> Result<Vec<TemplatePart>, String> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let characters: Vec<char> = template.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '{' && characters.get(index + 1) == Some(&'{') {
            if characters.get(index + 2) == Some(&'{') {
                return Err("A placeholder cannot start with three braces".into());
            }
            let rest: String = characters[index + 2..].iter().collect();
            let Some(end) = rest.find("}}") else {
                return Err("A placeholder is missing its closing braces".into());
            };
            let name = &rest[..end];
            if name.contains('{') {
                return Err("A placeholder cannot contain another placeholder".into());
            }
            if !valid_parameter_name(name) {
                return Err(format!(
                    "{{{{{name}}}}} is not a usable parameter name. Use lowercase letters, digits, and underscores."
                ));
            }
            if !literal.is_empty() {
                parts.push(TemplatePart::Literal(std::mem::take(&mut literal)));
            }
            parts.push(TemplatePart::Parameter(name.to_string()));
            index += 2 + name.chars().count() + 2;
            continue;
        }
        literal.push(characters[index]);
        index += 1;
    }
    if !literal.is_empty() {
        parts.push(TemplatePart::Literal(literal));
    }
    Ok(parts)
}

fn validate_parameter(parameter: &SnippetParameter) -> Result<(), String> {
    if !valid_parameter_name(&parameter.name) {
        return Err(format!(
            "\"{}\" is not a usable parameter name. Use lowercase letters, digits, and underscores.",
            parameter.name
        ));
    }
    if parameter.prompt.trim().is_empty()
        || parameter.prompt.chars().count() > MAX_PROMPT_CHARS
        || has_control_characters(&parameter.prompt)
    {
        return Err(format!(
            "The prompt for {} must be 1 to {MAX_PROMPT_CHARS} characters with no control characters",
            parameter.name
        ));
    }
    match parameter.kind.as_str() {
        KIND_STRING => {}
        KIND_INTEGER => {
            if let (Some(minimum), Some(maximum)) = (parameter.minimum, parameter.maximum)
                && minimum > maximum
            {
                return Err(format!(
                    "The range for {} has a minimum above its maximum",
                    parameter.name
                ));
            }
        }
        KIND_CHOICE => {
            if parameter.choices.is_empty() || parameter.choices.len() > MAX_CHOICES {
                return Err(format!(
                    "{} needs 1 to {MAX_CHOICES} choices",
                    parameter.name
                ));
            }
            let mut seen = HashSet::new();
            for choice in &parameter.choices {
                if choice.is_empty()
                    || choice.chars().count() > MAX_CHOICE_CHARS
                    || has_control_characters(choice)
                {
                    return Err(format!(
                        "A choice for {} must be 1 to {MAX_CHOICE_CHARS} characters with no control characters",
                        parameter.name
                    ));
                }
                if !seen.insert(choice) {
                    return Err(format!("{} repeats the choice {choice}", parameter.name));
                }
            }
        }
        other => return Err(format!("{other} is not a supported parameter type")),
    }
    if let Some(default) = &parameter.default_value {
        // A default that could not be rendered would fail only at insertion
        // time, so it is checked when the snippet is saved.
        render_value(parameter, default).map_err(|error| {
            format!(
                "The default for {} is not usable: {}",
                parameter.name, error
            )
        })?;
    }
    Ok(())
}

pub fn validate_input(input: &CommandSnippetInput) -> Result<(), String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || has_control_characters(name) {
        return Err(format!(
            "A snippet name must be 1 to {MAX_NAME_CHARS} characters"
        ));
    }
    if input.template.trim().is_empty() || input.template.chars().count() > MAX_TEMPLATE_CHARS {
        return Err(format!(
            "A snippet template must be 1 to {MAX_TEMPLATE_CHARS} characters"
        ));
    }
    if has_control_characters(&input.template) {
        return Err(
            "A snippet template is one command line. Remove any line breaks, tabs, or other control characters."
                .into(),
        );
    }
    if input.parameters.len() > MAX_PARAMETERS {
        return Err(format!(
            "A snippet can have at most {MAX_PARAMETERS} parameters"
        ));
    }
    let mut names = HashSet::new();
    for parameter in &input.parameters {
        validate_parameter(parameter)?;
        if !names.insert(parameter.name.as_str()) {
            return Err(format!("{} is defined more than once", parameter.name));
        }
    }
    let parts = parse_template(&input.template)?;
    let mut used = HashSet::new();
    for part in &parts {
        if let TemplatePart::Parameter(name) = part {
            if !names.contains(name.as_str()) {
                return Err(format!("{{{{{name}}}}} has no parameter definition"));
            }
            used.insert(name.clone());
        }
    }
    for parameter in &input.parameters {
        if !used.contains(&parameter.name) {
            return Err(format!(
                "{} is defined but never used in the template",
                parameter.name
            ));
        }
    }
    Ok(())
}

/// Single-quoted, with an embedded quote closed and reopened. This is the only
/// rule for strings and choices: there is no raw mode, because a raw mode would
/// remove the one guarantee the preview is making.
pub fn quote_bash(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn render_value(parameter: &SnippetParameter, value: &str) -> Result<String, String> {
    match parameter.kind.as_str() {
        KIND_INTEGER => {
            let parsed: i64 = value
                .trim()
                .parse()
                .map_err(|_| "enter a whole number".to_string())?;
            if let Some(minimum) = parameter.minimum
                && parsed < minimum
            {
                return Err(format!("enter {minimum} or more"));
            }
            if let Some(maximum) = parameter.maximum
                && parsed > maximum
            {
                return Err(format!("enter {maximum} or less"));
            }
            Ok(parsed.to_string())
        }
        KIND_CHOICE => {
            if !parameter.choices.iter().any(|choice| choice == value) {
                return Err("choose one of the listed values".into());
            }
            Ok(quote_bash(value))
        }
        _ => {
            if has_control_characters(value) {
                return Err("remove control characters".into());
            }
            if value.chars().count() > MAX_VALUE_CHARS {
                return Err(format!("use at most {MAX_VALUE_CHARS} characters"));
            }
            Ok(quote_bash(value))
        }
    }
}

/// An optional parameter left empty renders as nothing, and one space directly
/// before it is dropped so the result does not carry a gap the author did not
/// write. Everything else in the template is literal.
pub fn render(snippet: &CommandSnippet, values: &HashMap<String, String>) -> SnippetRender {
    let mut errors = Vec::new();
    let definitions: HashMap<&str, &SnippetParameter> = snippet
        .parameters
        .iter()
        .map(|parameter| (parameter.name.as_str(), parameter))
        .collect();

    let parts = match parse_template(&snippet.template) {
        Ok(parts) => parts,
        Err(message) => {
            return SnippetRender {
                command: None,
                errors: vec![SnippetError {
                    parameter: None,
                    message,
                }],
                shell: snippet.shell.clone(),
            };
        }
    };

    let mut command = String::new();
    for part in parts {
        match part {
            TemplatePart::Literal(text) => command.push_str(&text),
            TemplatePart::Parameter(name) => {
                let Some(parameter) = definitions.get(name.as_str()) else {
                    errors.push(SnippetError {
                        parameter: Some(name.clone()),
                        message: format!("{{{{{name}}}}} has no parameter definition"),
                    });
                    continue;
                };
                let entered = values
                    .get(&name)
                    .map(String::as_str)
                    .filter(|value| !value.is_empty());
                let value = entered.or(parameter.default_value.as_deref());
                match value {
                    None => {
                        if parameter.required {
                            errors.push(SnippetError {
                                parameter: Some(name.clone()),
                                message: format!("{} is required", parameter.prompt),
                            });
                        } else if command.ends_with(' ') {
                            command.pop();
                        }
                    }
                    Some(value) => match render_value(parameter, value) {
                        Ok(rendered) => command.push_str(&rendered),
                        Err(message) => errors.push(SnippetError {
                            parameter: Some(name.clone()),
                            message: format!("{}: {message}", parameter.prompt),
                        }),
                    },
                }
            }
        }
    }

    if command.chars().count() > MAX_RENDERED_CHARS {
        errors.push(SnippetError {
            parameter: None,
            message: format!("The result is longer than {MAX_RENDERED_CHARS} characters"),
        });
    }
    SnippetRender {
        command: if errors.is_empty() {
            Some(command)
        } else {
            None
        },
        errors,
        shell: snippet.shell.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parameter(name: &str, kind: &str) -> SnippetParameter {
        SnippetParameter {
            name: name.into(),
            prompt: format!("Value for {name}"),
            kind: kind.into(),
            required: true,
            choices: Vec::new(),
            minimum: None,
            maximum: None,
            default_value: None,
        }
    }

    fn snippet(template: &str, parameters: Vec<SnippetParameter>) -> CommandSnippet {
        CommandSnippet {
            id: "snippet-1".into(),
            name: "Unit journal".into(),
            template: template.into(),
            parameters,
            shell: SNIPPET_SHELL.into(),
            connection_id: None,
            position: 0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn input(template: &str, parameters: Vec<SnippetParameter>) -> CommandSnippetInput {
        CommandSnippetInput {
            id: None,
            name: "Unit journal".into(),
            template: template.into(),
            parameters,
            connection_id: None,
        }
    }

    fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn a_template_splits_into_literals_and_parameters() {
        assert_eq!(
            parse_template("journalctl -u {{service}} -n {{lines}}").unwrap(),
            vec![
                TemplatePart::Literal("journalctl -u ".into()),
                TemplatePart::Parameter("service".into()),
                TemplatePart::Literal(" -n ".into()),
                TemplatePart::Parameter("lines".into()),
            ]
        );
    }

    #[test]
    fn a_lone_brace_is_literal_text() {
        assert_eq!(
            parse_template("awk '{print $1}'").unwrap(),
            vec![TemplatePart::Literal("awk '{print $1}'".into())]
        );
    }

    #[test]
    fn a_malformed_placeholder_is_refused_rather_than_guessed_at() {
        for (template, fragment) in [
            ("journalctl -u {{service", "closing braces"),
            ("journalctl -u {{{service}}}", "three braces"),
            ("journalctl -u {{ser vice}}", "not a usable parameter name"),
            ("journalctl -u {{Service}}", "not a usable parameter name"),
            ("journalctl -u {{}}", "not a usable parameter name"),
            ("journalctl -u {{a{{b}}}}", "another placeholder"),
        ] {
            let error = parse_template(template).expect_err(template);
            assert!(error.contains(fragment), "{template} gave {error}");
        }
    }

    #[test]
    fn a_string_value_is_single_quoted_and_an_embedded_quote_is_closed_and_reopened() {
        assert_eq!(quote_bash("nginx.service"), "'nginx.service'");
        assert_eq!(quote_bash("it's"), r"'it'\''s'");
        assert_eq!(quote_bash(""), "''");
        assert_eq!(quote_bash("a b; rm -rf /"), "'a b; rm -rf /'");
        assert_eq!(quote_bash("$(id)"), "'$(id)'");
        assert_eq!(quote_bash("`id`"), "'`id`'");
    }

    #[test]
    fn the_spec_example_renders_exactly() {
        let rendered = render(
            &snippet(
                "journalctl -u {{service}} -n {{lines}}",
                vec![
                    parameter("service", KIND_STRING),
                    parameter("lines", KIND_INTEGER),
                ],
            ),
            &values(&[("service", "nginx.service"), ("lines", "200")]),
        );
        assert_eq!(
            rendered.command.as_deref(),
            Some("journalctl -u 'nginx.service' -n 200")
        );
        assert!(rendered.errors.is_empty());
        assert_eq!(rendered.shell, SNIPPET_SHELL);
    }

    #[test]
    fn a_shell_metacharacter_in_a_value_stays_inside_the_quotes() {
        let rendered = render(
            &snippet(
                "systemctl status {{unit}}",
                vec![parameter("unit", KIND_STRING)],
            ),
            &values(&[("unit", "nginx.service; rm -rf /")]),
        );
        assert_eq!(
            rendered.command.as_deref(),
            Some("systemctl status 'nginx.service; rm -rf /'")
        );
    }

    #[test]
    fn an_integer_is_rendered_bare_and_range_checked() {
        let mut lines = parameter("lines", KIND_INTEGER);
        lines.minimum = Some(1);
        lines.maximum = Some(1000);
        let template = snippet("journalctl -n {{lines}}", vec![lines]);
        assert_eq!(
            render(&template, &values(&[("lines", "50")]))
                .command
                .as_deref(),
            Some("journalctl -n 50")
        );
        for (entered, fragment) in [
            ("0", "1 or more"),
            ("1001", "1000 or less"),
            ("ten", "whole number"),
            ("5.5", "whole number"),
        ] {
            let rendered = render(&template, &values(&[("lines", entered)]));
            assert!(rendered.command.is_none(), "{entered} rendered anyway");
            assert!(
                rendered.errors[0].message.contains(fragment),
                "{entered} gave {:?}",
                rendered.errors[0]
            );
            assert_eq!(rendered.errors[0].parameter.as_deref(), Some("lines"));
        }
    }

    #[test]
    fn a_choice_must_be_one_of_the_declared_values() {
        let mut mode = parameter("mode", KIND_CHOICE);
        mode.choices = vec!["--follow".into(), "--no-pager".into()];
        let template = snippet("journalctl {{mode}}", vec![mode]);
        assert_eq!(
            render(&template, &values(&[("mode", "--follow")]))
                .command
                .as_deref(),
            Some("journalctl '--follow'")
        );
        let rejected = render(&template, &values(&[("mode", "--wipe")]));
        assert!(rejected.command.is_none());
        assert!(
            rejected.errors[0]
                .message
                .contains("choose one of the listed values")
        );
    }

    #[test]
    fn a_control_character_in_a_value_is_refused_before_rendering() {
        let rendered = render(
            &snippet("echo {{text}}", vec![parameter("text", KIND_STRING)]),
            &values(&[("text", "first\nsecond")]),
        );
        assert!(rendered.command.is_none());
        assert!(rendered.errors[0].message.contains("control characters"));
    }

    #[test]
    fn an_oversized_value_is_refused() {
        let rendered = render(
            &snippet("echo {{text}}", vec![parameter("text", KIND_STRING)]),
            &values(&[("text", &"a".repeat(MAX_VALUE_CHARS + 1))]),
        );
        assert!(rendered.command.is_none());
        assert!(rendered.errors[0].message.contains("at most"));
    }

    #[test]
    fn a_required_parameter_with_no_value_stops_the_render() {
        let rendered = render(
            &snippet(
                "systemctl status {{unit}}",
                vec![parameter("unit", KIND_STRING)],
            ),
            &values(&[]),
        );
        assert!(rendered.command.is_none());
        assert!(rendered.errors[0].message.contains("is required"));
    }

    #[test]
    fn an_optional_parameter_left_empty_takes_its_space_with_it() {
        let mut mode = parameter("mode", KIND_STRING);
        mode.required = false;
        let rendered = render(
            &snippet("journalctl -u nginx {{mode}}", vec![mode]),
            &values(&[]),
        );
        assert_eq!(rendered.command.as_deref(), Some("journalctl -u nginx"));
    }

    #[test]
    fn a_default_fills_in_for_an_empty_value_without_being_a_stored_entry() {
        let mut lines = parameter("lines", KIND_INTEGER);
        lines.default_value = Some("200".into());
        let template = snippet("journalctl -n {{lines}}", vec![lines]);
        assert_eq!(
            render(&template, &values(&[])).command.as_deref(),
            Some("journalctl -n 200")
        );
        assert_eq!(
            render(&template, &values(&[("lines", "50")]))
                .command
                .as_deref(),
            Some("journalctl -n 50")
        );
    }

    #[test]
    fn a_parameter_used_twice_renders_twice() {
        let rendered = render(
            &snippet(
                "systemctl status {{unit}} && journalctl -u {{unit}}",
                vec![parameter("unit", KIND_STRING)],
            ),
            &values(&[("unit", "nginx.service")]),
        );
        assert_eq!(
            rendered.command.as_deref(),
            Some("systemctl status 'nginx.service' && journalctl -u 'nginx.service'")
        );
    }

    #[test]
    fn a_render_never_ends_with_a_newline() {
        let rendered = render(
            &snippet(
                "systemctl status {{unit}}",
                vec![parameter("unit", KIND_STRING)],
            ),
            &values(&[("unit", "nginx.service")]),
        );
        let command = rendered.command.expect("renders");
        assert!(!command.ends_with('\n'));
        assert!(!command.ends_with('\r'));
        assert!(!command.contains('\n'));
    }

    #[test]
    fn every_value_error_is_reported_with_its_parameter() {
        let mut lines = parameter("lines", KIND_INTEGER);
        lines.minimum = Some(1);
        let rendered = render(
            &snippet(
                "journalctl -u {{service}} -n {{lines}}",
                vec![parameter("service", KIND_STRING), lines],
            ),
            &values(&[("service", "bad\u{7}"), ("lines", "0")]),
        );
        assert_eq!(rendered.errors.len(), 2);
        assert_eq!(
            rendered
                .errors
                .iter()
                .filter_map(|error| error.parameter.as_deref())
                .collect::<Vec<_>>(),
            vec!["service", "lines"]
        );
    }

    #[test]
    fn a_valid_definition_is_accepted() {
        assert!(
            validate_input(&input(
                "journalctl -u {{service}} -n {{lines}}",
                vec![
                    parameter("service", KIND_STRING),
                    parameter("lines", KIND_INTEGER)
                ],
            ))
            .is_ok()
        );
    }

    #[test]
    fn a_definition_with_an_unknown_placeholder_is_refused() {
        let error = validate_input(&input(
            "journalctl -u {{service}} -n {{lines}}",
            vec![parameter("service", KIND_STRING)],
        ))
        .expect_err("unknown placeholder");
        assert!(error.contains("{{lines}} has no parameter definition"));
    }

    #[test]
    fn a_definition_with_an_unused_parameter_is_refused() {
        let error = validate_input(&input(
            "journalctl -u {{service}}",
            vec![
                parameter("service", KIND_STRING),
                parameter("lines", KIND_INTEGER),
            ],
        ))
        .expect_err("unused parameter");
        assert!(error.contains("never used"));
    }

    #[test]
    fn a_duplicate_parameter_definition_is_refused() {
        let error = validate_input(&input(
            "journalctl -u {{service}}",
            vec![
                parameter("service", KIND_STRING),
                parameter("service", KIND_STRING),
            ],
        ))
        .expect_err("duplicate");
        assert!(error.contains("defined more than once"));
    }

    #[test]
    fn a_multiline_template_is_refused() {
        let error = validate_input(&input(
            "systemctl status {{unit}}\nsystemctl restart {{unit}}",
            vec![parameter("unit", KIND_STRING)],
        ))
        .expect_err("multiline");
        assert!(error.contains("one command line"));
    }

    #[test]
    fn an_unsupported_parameter_type_is_refused() {
        let error = validate_input(&input("echo {{value}}", vec![parameter("value", "regex")]))
            .expect_err("bad type");
        assert!(error.contains("not a supported parameter type"));
    }

    #[test]
    fn a_choice_parameter_needs_usable_choices() {
        let mut mode = parameter("mode", KIND_CHOICE);
        assert!(validate_input(&input("journalctl {{mode}}", vec![mode.clone()])).is_err());
        mode.choices = vec!["--follow".into(), "--follow".into()];
        let error = validate_input(&input("journalctl {{mode}}", vec![mode.clone()]))
            .expect_err("duplicate choice");
        assert!(error.contains("repeats the choice"));
        mode.choices = vec!["--follow".into()];
        assert!(validate_input(&input("journalctl {{mode}}", vec![mode])).is_ok());
    }

    #[test]
    fn an_integer_range_with_a_minimum_above_its_maximum_is_refused() {
        let mut lines = parameter("lines", KIND_INTEGER);
        lines.minimum = Some(100);
        lines.maximum = Some(10);
        let error =
            validate_input(&input("journalctl -n {{lines}}", vec![lines])).expect_err("bad range");
        assert!(error.contains("minimum above its maximum"));
    }

    #[test]
    fn a_default_that_could_not_render_is_refused_at_save_time() {
        let mut lines = parameter("lines", KIND_INTEGER);
        lines.maximum = Some(10);
        lines.default_value = Some("500".into());
        let error = validate_input(&input("journalctl -n {{lines}}", vec![lines]))
            .expect_err("bad default");
        assert!(error.contains("The default for lines is not usable"));
    }

    #[test]
    fn an_empty_or_oversized_name_and_template_are_refused() {
        let mut blank = input("echo hello", Vec::new());
        blank.name = "   ".into();
        assert!(validate_input(&blank).is_err());
        let mut long = input("echo hello", Vec::new());
        long.name = "a".repeat(MAX_NAME_CHARS + 1);
        assert!(validate_input(&long).is_err());
        let mut empty_template = input("   ", Vec::new());
        empty_template.name = "Name".into();
        assert!(validate_input(&empty_template).is_err());
    }

    #[test]
    fn too_many_parameters_are_refused() {
        let parameters: Vec<SnippetParameter> = (0..MAX_PARAMETERS + 1)
            .map(|index| parameter(&format!("p{index}"), KIND_STRING))
            .collect();
        let template = (0..MAX_PARAMETERS + 1)
            .map(|index| format!("{{{{p{index}}}}}"))
            .collect::<Vec<_>>()
            .join(" ");
        let error = validate_input(&input(&template, parameters)).expect_err("too many");
        assert!(error.contains("at most"));
    }

    #[test]
    fn the_renderer_holds_no_execution_path() {
        let source = include_str!("snippets.rs");
        let renderer = &source[..source.find("mod tests").expect("tests module exists")];
        // Rendering produces text. Split so the assertion text itself is not
        // what the scan finds.
        assert!(!renderer.contains(concat!("Remote", "CommandExecutor")));
        assert!(!renderer.contains("write_session"));
        assert!(!renderer.contains(r"\r"));
        assert!(!renderer.contains("push('\\n')"));
    }
}
