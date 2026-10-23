#!/usr/bin/env node
'use strict';

/*
 * cli-gateway — one OpenAI-compatible API in front of many AI CLIs.
 *
 * The CORE here owns HTTP, auth, the OpenAI request/response + SSE wire format,
 * and model routing. Each backend is a small module in ./adapters that only
 * describes how to invoke its CLI and read its output. Add a CLI => add a file.
 *
 * Zero runtime dependencies (Node stdlib only).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./lib/core');
const registry = require('./lib/registry');
const auth = require('./lib/auth');

// ---------------------------------------------------------------------------
// config: config.json (next to this file) overlaid with env vars
// ---------------------------------------------------------------------------
function loadConfig() {
  let file = {};
  const p = path.join(__dirname, 'config.json');
  try { file = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* defaults */ }
  return {
    host: process.env.GATEWAY_HOST || file.host || '0.0.0.0',
    port: parseInt(process.env.GATEWAY_PORT || file.port || '8787', 10),
    apiKey: process.env.GATEWAY_KEY || file.apiKey || '',
    defaultModel: process.env.GATEWAY_DEFAULT_MODEL || file.defaultModel || 'claude/sonnet',
    defaultSystem: process.env.GATEWAY_SYSTEM || file.defaultSystem || 'You are a helpful assistant.',
    toolModel: process.env.GATEWAY_TOOL_MODEL || file.toolModel || '', // if set, requests WITH tools use this model
    debug: process.env.GATEWAY_DEBUG ? /^(1|true|yes)$/i.test(process.env.GATEWAY_DEBUG) : (file.debug !== false),
    adapters: file.adapters || {},
  };
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(JSON.stringify(obj));
}
function apiError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJSON(res, status, { error: { message, type, code, param: null } });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function checkAuth(req) {
  if (!config.apiKey) return true;
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === config.apiKey;
}

// ---------------------------------------------------------------------------
// request/response logging (for debugging what a client actually sends)
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, 'logs');
let logSeq = 0;

function logEvent(kind, obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...obj });
  if (config.debug) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'requests.jsonl'), line + '\n'); } catch { /* */ }
  }
  return line;
}

function logRequest(body) {
  const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => (t.function && t.function.name) || t.name).filter(Boolean) : [];
  const lastUser = [...(body.messages || [])].reverse().find((m) => m && m.role === 'user');
  const lu = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : null;
  const id = ++logSeq;
  console.log(`  » #${id} model=${body.model} tools=${toolNames.length}${toolNames.length ? ' [' + toolNames.join(', ') + ']' : ''} tool_choice=${JSON.stringify(body.tool_choice)} msg="${(lu || '').slice(0, 80)}"`);
  logEvent('request', { id, model: body.model, messages: (body.messages || []).length, last_user: lu && lu.slice(0, 500), tools: toolNames.length, tool_names: toolNames, tool_choice: body.tool_choice, stream: !!body.stream });
  return id;
}

function logResult(id, { rawText, toolCalls, finish }) {
  console.log(`  « #${id} ${toolCalls ? 'TOOL_CALLS=' + toolCalls.map((c) => c.name).join(',') : 'text'} finish=${finish}`);
  logEvent('result', { id, finish, tool_calls: toolCalls ? toolCalls.map((c) => c.name) : null, raw_text: (rawText || '').slice(0, 2000) });
}

// Dump the EXACT input the model saw + its raw output, for debugging fabrication.
function dumpPayload(id, data) {
  if (!config.debug) return;
  try {
    const dir = path.join(LOG_DIR, 'payloads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `req-${id}.json`), JSON.stringify(data, null, 2));
  } catch { /* */ }
}

// ---------------------------------------------------------------------------
// load adapters + model registry
// ---------------------------------------------------------------------------
console.log('\n  cli-gateway — loading adapters:');
const reg = registry.load(config);
if (!reg.list.length) console.warn('  (no models available — are any CLIs installed/enabled?)');

function resolveModel(requested) {
  // no model given -> use the configured default; an explicit unknown model -> null (400)
  if (!requested) return reg.index[(config.defaultModel || '').toLowerCase()] || null;
  return reg.index[requested.toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// chat completions
// ---------------------------------------------------------------------------
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return apiError(res, 400, 'invalid JSON body: ' + e.message); }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return apiError(res, 400, '`messages` must be a non-empty array');
  }
  const reqId = logRequest(body);
  let entry = resolveModel(body.model);
  if (!entry) return apiError(res, 400, `unknown model '${body.model}'. See GET /v1/models.`, 'invalid_request_error', 'model_not_found');

  const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : null;
  const toolMode = !!tools && body.tool_choice !== 'none';

  // optional: route tool-bearing requests to a stronger model (weak models call tools unreliably)
  if (toolMode && config.toolModel) {
    const up = resolveModel(config.toolModel);
    if (up && up !== entry) { console.log(`  ↑ #${reqId} tool request: upgrading ${body.model} -> ${config.toolModel}`); entry = up; }
  }

  const { system, prompt } = core.flatten(body.messages, config.defaultSystem, toolMode ? { tools, toolChoice: body.tool_choice } : null);
  if (!prompt.trim()) return apiError(res, 400, 'no text content found in messages');

  const call = { prompt, system, model: entry.cliModel };
  const label = body.model || entry.id;

  // Function calling: buffer the full reply, detect a tool-call directive, and
  // emit it as OpenAI tool_calls (true token streaming isn't possible until we
  // know whether the reply is a tool call or prose).
  if (toolMode) return handleToolMode(res, entry, call, label, body, reqId);

  if (body.stream) {
    const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
    return streamChat(req, res, entry, call, label, includeUsage);
  }

  try {
    const r = await core.runOnce(entry.adapter, entry.cfg, call);
    sendJSON(res, 200, {
      id: core.genId('chatcmpl-'), object: 'chat.completion', created: core.now(), model: label,
      choices: [{ index: 0, message: { role: 'assistant', content: r.text || '' }, finish_reason: core.mapFinish(r.finishReason) }],
      usage: {
        prompt_tokens: (r.usage && r.usage.prompt_tokens) || 0,
        completion_tokens: (r.usage && r.usage.completion_tokens) || 0,
        total_tokens: ((r.usage && r.usage.prompt_tokens) || 0) + ((r.usage && r.usage.completion_tokens) || 0),
      },
    });
  } catch (e) {
    apiError(res, 502, String(e.message || e).slice(0, 2000), 'api_error');
  }
}

async function handleToolMode(res, entry, call, label, body, reqId) {
  let r;
  try { r = await core.runOnce(entry.adapter, entry.cfg, call); }
  catch (e) { logResult(reqId, { rawText: '', toolCalls: null, finish: 'error' }); return apiError(res, 502, String(e.message || e).slice(0, 2000), 'api_error'); }

  const calls = core.parseToolCalls(r.text);
  logResult(reqId, { rawText: r.text, toolCalls: calls, finish: calls ? 'tool_calls' : 'stop' });
  dumpPayload(reqId, { model: entry.id, system: call.system, prompt: call.prompt, raw_output: r.text, parsed_tool_calls: calls });
  const usage = {
    prompt_tokens: (r.usage && r.usage.prompt_tokens) || 0,
    completion_tokens: (r.usage && r.usage.completion_tokens) || 0,
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  const message = calls
    ? { role: 'assistant', content: null, tool_calls: core.formatToolCalls(calls) }
    : { role: 'assistant', content: r.text || '' };
  const finish = calls ? 'tool_calls' : core.mapFinish(r.finishReason);

  if (!body.stream) {
    return sendJSON(res, 200, {
      id: core.genId('chatcmpl-'), object: 'chat.completion', created: core.now(), model: label,
      choices: [{ index: 0, message, finish_reason: finish }], usage,
    });
  }

  // streamed form of the same result
  const id = core.genId('chatcmpl-'), created = core.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no',
  });
  const chunk = (delta, fin = null) => res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: label, choices: [{ index: 0, delta, finish_reason: fin }],
  })}\n\n`);

  chunk({ role: 'assistant', content: calls ? null : '' });
  if (calls) {
    chunk({ tool_calls: message.tool_calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: c.function })) });
  } else {
    chunk({ content: r.text || '' });
  }
  chunk({}, finish);
  if (body.stream_options && body.stream_options.include_usage) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: label, choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function streamChat(req, res, entry, call, label, includeUsage) {
  const id = core.genId('chatcmpl-'), created = core.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no',
  });
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: label, choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);

  chunk({ role: 'assistant', content: '' });

  let usage = null, finish = 'stop';
  const onEvent = (ev) => {
    if (ev.delta) chunk({ content: ev.delta });
    if (ev.usage) usage = ev.usage;
    if (ev.finishReason) finish = core.mapFinish(ev.finishReason);
    if (ev.error) chunk({ content: `\n[error: ${String(ev.error).slice(0, 500)}]` });
  };

  req.on('close', () => { if (onEvent.__child && !onEvent.__child.killed) onEvent.__child.kill(); });

  try { await core.runStream(entry.adapter, entry.cfg, call, onEvent); }
  catch (e) { onEvent({ error: e.message }); }

  chunk({}, finish);
  if (includeUsage && usage) {
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: label, choices: [],
      usage: { ...usage, total_tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) },
    })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  if (p === '/' || p === '/health') {
    return sendJSON(res, 200, { status: 'ok', backends: Object.keys(reg.adapters), models: reg.list.length });
  }

  // auth panel (/auth*) — has its own key gate so it works from a browser
  if (await auth.handle(req, res, url, config)) return;

  if (!checkAuth(req)) return apiError(res, 401, 'invalid or missing API key', 'authentication_error');

  if (p === '/v1/models' && req.method === 'GET') return sendJSON(res, 200, { object: 'list', data: reg.list });
  if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
    try { return await handleChat(req, res); }
    catch (e) { return apiError(res, 500, e.message || 'internal error', 'api_error'); }
  }
  return apiError(res, 404, `unknown route: ${req.method} ${p}`, 'invalid_request_error', 'not_found');
});

server.listen(config.port, config.host, () => {
  console.log(`\n  listening     http://${config.host}:${config.port}/v1`);
  console.log(`  backends      ${Object.keys(reg.adapters).join(', ') || '(none)'}`);
  console.log(`  models        ${reg.list.length}  (GET /v1/models)`);
  console.log(`  default       ${config.defaultModel}`);
  console.log(`  auth          ${config.apiKey ? 'Bearer key required' : 'open (no key set)'}\n`);
});
