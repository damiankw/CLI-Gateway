'use strict';

/*
 * Core helpers shared by every adapter: OpenAI message flattening, process
 * spawning, and OpenAI-shaped response/stream formatting. Adapters stay tiny —
 * they only describe how to invoke one CLI and how to read its output.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');

function now() { return Math.floor(Date.now() / 1000); }
function genId(prefix) { return prefix + crypto.randomBytes(16).toString('hex'); }

// Extract plain text from an OpenAI message `content` (string or parts array).
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && (p.type === 'text' || p.type === 'input_text')) return p.text || '';
        return ''; // images / other parts dropped — CLIs here are text-only
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function safeParse(s) { if (s == null) return {}; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } }

// Build the system-prompt block that teaches a model OpenAI-style function calling.
function buildToolInstructions(tools, toolChoice) {
  const lines = [
    'You are the reasoning core of an automated assistant, connected to the outside world ONLY',
    'through a text protocol. You have NO built-in or native tools. The one and only way to',
    'perform an action or fetch data is to output a "tool call" in the exact JSON format shown',
    'below. Outputting this JSON is NOT pretending or roleplay: a downstream executor reads your',
    'output, actually runs the function, and sends you back the result.',
    '',
    'To call one or more tools, your ENTIRE reply MUST be a single JSON object and nothing else:',
    '{"tool_calls": [{"name": "<tool_name>", "arguments": { ...args matching the schema... }}]}',
    'Add more entries to the array to call several tools at once.',
    '',
    'Rules:',
    '- NEVER say a tool is unavailable, broken, or not wired up. If a function is listed below,',
    '  it IS available to you right now through this JSON mechanism — use it.',
    '- NEVER claim you performed an action, or that something succeeded or failed, unless you',
    '  actually received a tool result for it. The ONLY way to do anything is to emit the JSON.',
    '- If a capability first needs a connector/tool to be loaded or enabled, CALL the tool that',
    '  does that (e.g. a loader function) instead of assuming it is broken.',
    '- When calling tools, output ONLY the JSON — no prose, no markdown, no backticks.',
    '- If no tool is needed, reply with a normal plain-text message for the user.',
    '- A message is either tool_calls JSON or a normal answer, never both.',
    '',
    'Functions available to you:',
  ];
  for (const t of tools) {
    const f = (t && t.function) || t || {};
    lines.push(`- ${f.name}: ${f.description || ''}`);
    if (f.parameters) lines.push(`  arguments JSON Schema: ${JSON.stringify(f.parameters)}`);
  }
  if (toolChoice === 'required') {
    lines.push('', 'You MUST call at least one tool right now. Reply with only the tool_calls JSON.');
  } else if (toolChoice && toolChoice.function && toolChoice.function.name) {
    lines.push('', `You MUST call the function "${toolChoice.function.name}" right now. Reply with only the tool_calls JSON.`);
  }
  return lines.join('\n');
}

// Turn OpenAI messages[] into { system, prompt }, honoring tool calls/results.
// `toolSpec` (optional) = { tools, toolChoice } enables the function-calling shim.
function flatten(messages, defaultSystem, toolSpec) {
  const systemParts = [];
  const turns = [];
  const callNames = {}; // tool_call_id -> function name, so tool results can be labelled
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system' || m.role === 'developer') { const t = contentText(m.content); if (t) systemParts.push(t); continue; }
    if (m.role === 'assistant') {
      const text = contentText(m.content);
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of tcs) if (tc && tc.id && tc.function) callNames[tc.id] = tc.function.name;
      if (text || tcs.length) turns.push({ role: 'assistant', text, tool_calls: tcs });
      continue;
    }
    if (m.role === 'tool') {
      turns.push({ role: 'tool', text: contentText(m.content), name: callNames[m.tool_call_id] || m.name || 'tool' });
      continue;
    }
    const text = contentText(m.content);
    if (text) turns.push({ role: 'user', text });
  }

  let system = systemParts.join('\n\n') || defaultSystem || 'You are a helpful assistant.';
  if (toolSpec && toolSpec.tools && toolSpec.tools.length) {
    system += '\n\n' + buildToolInstructions(toolSpec.tools, toolSpec.toolChoice);
  }

  // A short, high-recency reminder placed at the very END of the prompt — the last
  // thing the model reads before generating. This markedly improves tool-call
  // compliance when a long assistant persona dominates the system prompt.
  const reminder = (toolSpec && toolSpec.tools && toolSpec.tools.length)
    ? '\n\n---\nReminder: if answering the message above needs any listed tool/function, your ENTIRE reply must be ONLY the JSON {"tool_calls":[...]} and nothing else. If a capability must be loaded/enabled first, call that loader function NOW. Do NOT narrate actions, apologise, or say a tool is unavailable.'
    : '';

  // fast path: a plain conversation with only user text
  if (turns.length && turns.every((t) => t.role === 'user')) {
    return { system, prompt: turns.map((t) => t.text).join('\n\n') + reminder };
  }

  const parts = [];
  for (const t of turns) {
    if (t.role === 'user') parts.push(`User: ${t.text}`);
    else if (t.role === 'tool') parts.push(`Tool result for "${t.name}": ${t.text}`);
    else if (t.role === 'assistant') {
      if (t.tool_calls && t.tool_calls.length) {
        const calls = t.tool_calls.map((c) => ({ name: c.function && c.function.name, arguments: safeParse(c.function && c.function.arguments) }));
        parts.push(`Assistant (tool call): ${JSON.stringify({ tool_calls: calls })}`);
      }
      if (t.text) parts.push(`Assistant: ${t.text}`);
    }
  }
  const prompt = 'Continue this conversation. Respond only as the assistant to the final message.\n\n' + parts.join('\n\n') + reminder;
  return { system, prompt };
}

// Pull the first balanced {...} object out of a string (quote/escape aware).
function extractJsonObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { if (--depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// If the model's reply is a tool-call directive, return the normalized calls; else null.
function parseToolCalls(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (!s.includes('tool_calls')) return null;
  const jsonStr = extractJsonObject(s);
  if (!jsonStr) return null;
  let obj; try { obj = JSON.parse(jsonStr); } catch { return null; }
  if (!obj || !Array.isArray(obj.tool_calls)) return null;
  const calls = obj.tool_calls
    .filter((c) => c && c.name)
    .map((c) => ({ name: c.name, arguments: c.arguments !== undefined ? c.arguments : (c.args || {}) }));
  return calls.length ? calls : null;
}

// Normalize to the OpenAI tool_calls wire shape (arguments must be a string).
function formatToolCalls(calls) {
  return calls.map((c) => ({
    id: 'call_' + crypto.randomBytes(12).toString('hex'),
    type: 'function',
    function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}) },
  }));
}

function mapFinish(reason) {
  switch (reason) {
    case 'max_tokens':
    case 'length': return 'length';
    case 'tool_use':
    case 'tool_calls': return 'tool_calls';
    default: return 'stop';
  }
}

// ---------------------------------------------------------------------------
// run an adapter non-streaming -> resolves { text, usage, finishReason }
// ---------------------------------------------------------------------------
function runOnce(adapter, cfg, { prompt, system, model }) {
  return new Promise((resolve, reject) => {
    const args = adapter.buildArgs({ prompt, system, model, stream: false, cfg });
    const child = spawnCli(adapter, cfg, args, reject);
    if (!child) return;
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => reject(new Error(`${adapter.id}: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error((err.trim() || out.trim() || `${adapter.id} exited ${code}`).slice(0, 2000)));
      try { resolve(adapter.parseFinal(out, err)); }
      catch (e) { reject(new Error(`${adapter.id}: ${e.message}`)); }
    });
  });
}

// ---------------------------------------------------------------------------
// run an adapter streaming -> calls onEvent({delta?, usage?, finishReason?, error?})
// resolves when the process closes
// ---------------------------------------------------------------------------
function runStream(adapter, cfg, { prompt, system, model }, onEvent) {
  return new Promise((resolve) => {
    const args = adapter.buildArgs({ prompt, system, model, stream: true, cfg });
    let child;
    try { child = spawnCli(adapter, cfg, args); }
    catch (e) { onEvent({ error: e.message }); return resolve(); }
    if (!child) { onEvent({ error: `${adapter.id}: spawn failed` }); return resolve(); }

    let buf = '', err = '';
    child.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          try { adapter.parseStreamLine(line.trim(), onEvent); }
          catch { /* skip malformed line */ }
        }
      }
    });
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => { onEvent({ error: e.message }); resolve(); });
    child.on('close', (code) => {
      if (buf.trim()) { try { adapter.parseStreamLine(buf.trim(), onEvent); } catch { /* */ } }
      if (code !== 0 && err.trim()) onEvent({ error: err.trim().slice(0, 500) });
      resolve();
    });
    onEvent.__child = child; // let caller kill on client disconnect
  });
}

function spawnCli(adapter, cfg, args, reject) {
  const bin = (cfg && cfg.bin) || adapter.bin || adapter.id;
  try {
    // stdin 'ignore' => the CLI sees EOF immediately and won't block waiting for piped input
    return spawn(bin, args, { cwd: (cfg && cfg.cwd) || process.cwd(), env: { ...process.env, ...(cfg && cfg.env) }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (reject) reject(new Error(`${adapter.id}: ${e.message}`));
    else throw e;
    return null;
  }
}

module.exports = { now, genId, contentText, flatten, mapFinish, runOnce, runStream, parseToolCalls, formatToolCalls };
