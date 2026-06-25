/// Thin Claude API client for optional flow-explanation feature.
///
/// Gated at runtime by `ANTHROPIC_API_KEY`. When the key is absent every
/// call-site falls back gracefully — no Cargo feature flag, no rebuild needed.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const MODEL: &str = "claude-sonnet-4-6";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

// ── key helper ────────────────────────────────────────────────────────────────

/// Returns the API key from the environment, or `None` if absent / empty.
pub fn api_key() -> Option<String> {
    std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|v| !v.is_empty())
}

// ── Messages API wire types ───────────────────────────────────────────────────

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: String,
}

#[derive(Serialize)]
struct Request {
    model: &'static str,
    max_tokens: u32,
    system: String,
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    content: Vec<ContentBlock>,
    #[serde(default)]
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

// ── prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT: &str = "\
You are an expert software architect reviewing a feature flow extracted by affini, \
a deterministic static-analysis tool for TypeScript/JavaScript repositories.\n\
\n\
A \"flow\" is a depth-first call-graph walk from a public entry point. Each step \
carries fragility flags computed from the module graph:\n\
  • scc_cycle        — the step crosses a circular import dependency\n\
  • high_instability — the callee module has Martin's instability > 75% (changes often)\n\
  • violation        — the edge crosses a boundary forbidden in affini.toml\n\
  • any_payload      — a parameter is typed `any` or `unknown` (no contract)\n\
  • untyped_boundary — a parameter has no type annotation at all\n\
  • any_return        — the return type is `any` or `unknown`\n\
  • churn_caller     — the calling module changed since the baseline snapshot\n\
  • churn_callee     — the called module changed since the baseline snapshot\n\
\n\
Your task: read the flow JSON and write a concise plain-English risk assessment \
for a working engineer. Cover:\n\
  1. What the flow does (one sentence from the entry point and kind).\n\
  2. The most important risks — which steps are fragile, why, and what could go wrong.\n\
  3. One concrete, actionable suggestion per significant risk.\n\
\n\
Rules:\n\
  • Plain prose only — no markdown headings, no bullet lists, no code fences.\n\
  • Short paragraphs (2–4 sentences each).\n\
  • Be specific to the actual function names and module paths in the JSON.\n\
  • If the flow has no fragility flags at all, say so plainly in one sentence.\n\
  • Do not invent information not present in the JSON.";

// ── public API ────────────────────────────────────────────────────────────────

/// Call Claude to explain a flow's fragility. `flow_json` is the serialized `Flow`.
/// Returns the explanation as a plain-text string.
pub async fn explain_flow(flow_json: &str) -> Result<String> {
    let key = api_key().context("ANTHROPIC_API_KEY not set")?;

    let body = Request {
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT.to_string(),
        messages: vec![Message {
            role: "user",
            content: format!(
                "Here is the affini flow JSON. Please write the risk assessment.\n\n```json\n{flow_json}\n```"
            ),
        }],
    };

    let client = reqwest::Client::new();
    let res = client
        .post(API_URL)
        .header("x-api-key", &key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .context("request to Anthropic API failed")?;

    let status = res.status();
    let resp: Response = res
        .json()
        .await
        .context("failed to parse Anthropic API response")?;

    if !status.is_success() {
        let msg = resp
            .error
            .map(|e| e.message)
            .unwrap_or_else(|| format!("HTTP {status}"));
        bail!("Anthropic API error: {msg}");
    }

    let text: String = resp
        .content
        .into_iter()
        .filter(|b| b.kind == "text")
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join("");

    if text.is_empty() {
        bail!("Anthropic API returned no text content");
    }
    Ok(text)
}
