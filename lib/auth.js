'use strict';

/*
 * Auth panel: connect/re-connect the backend CLIs from the browser or API,
 * so you never have to SSH in just to re-login.
 *
 *  GET  /auth                  -> small HTML panel
 *  GET  /auth/status           -> { claude, codex, gemini } booleans
 *  POST /auth/codex/start      -> runs `codex login --device-auth`, returns {url, code, output}
 *  GET  /auth/codex/status     -> { running, authed, url, code, output }
 *  POST /auth/gemini/creds     -> body = contents of oauth_creds.json, written to ~/.gemini/
 *
 * Codex uses the OAuth device flow (show code -> finish on your phone). Gemini
 * has no device flow, so you paste the creds file you generated on a machine
 * with a browser.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CRED_FILES = {
  claude: path.join(HOME, '.claude', '.credentials.json'),
  codex: path.join(HOME, '.codex', 'auth.json'),
  gemini: path.join(HOME, '.gemini', 'oauth_creds.json'),
};
const ENV_KEYS = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

function status() {
  const s = {};
  for (const k of Object.keys(CRED_FILES)) {
    s[k] = fs.existsSync(CRED_FILES[k]) || !!process.env[ENV_KEYS[k]];
  }
  return s;
}

// ---- codex device-auth -----------------------------------------------------
let codexProc = null;
let codexOut = '';

function parseDevice(out) {
  const url = (out.match(/https?:\/\/[^\s"']+/) || [])[0] || null;
  // user codes are usually like ABCD-1234 or ABCDEFGH
  const code = (out.match(/\b[A-Z0-9]{4}[-\s][A-Z0-9]{4}\b/) || out.match(/\bcode[:\s]+([A-Z0-9-]{6,})/i) || [])[0] || null;
  return { url, code };
}

function codexStart(bin) {
  if (codexProc) return { running: true, output: codexOut, ...parseDevice(codexOut) };
  codexOut = '';
  try {
    codexProc = spawn(bin || 'codex', ['login', '--device-auth'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { running: false, error: e.message };
  }
  codexProc.stdout.on('data', (d) => { codexOut += d; });
  codexProc.stderr.on('data', (d) => { codexOut += d; });
  codexProc.on('close', (c) => { codexOut += `\n[codex login exited with code ${c}]`; codexProc = null; });
  codexProc.on('error', (e) => { codexOut += `\n[error: ${e.message}]`; codexProc = null; });
  return { running: true, output: codexOut };
}

function codexStatus() {
  return { running: !!codexProc, authed: fs.existsSync(CRED_FILES.codex), output: codexOut, ...parseDevice(codexOut) };
}

// ---- gemini creds paste ----------------------------------------------------
function geminiWriteCreds(body) {
  const json = JSON.parse(body); // throws if invalid -> surfaced as 400
  const dir = path.join(HOME, '.gemini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CRED_FILES.gemini, JSON.stringify(json, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) reject(new Error('too large')); });
    req.on('end', () => resolve(b)); req.on('error', reject);
  });
}

// Main entry — returns true if it handled the request.
async function handle(req, res, url, config) {
  const p = url.pathname.replace(/\/$/, '') || '/';
  if (p !== '/auth' && !p.startsWith('/auth/')) return false;

  // gate: if a gateway apiKey is set, require it via ?key= (browser) or Bearer
  if (config.apiKey) {
    const q = url.searchParams.get('key');
    const bearer = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
    if (q !== config.apiKey && !(bearer && bearer[1] === config.apiKey)) {
      send(res, 401, { error: 'unauthorized (append ?key=YOUR_GATEWAY_KEY)' }); return true;
    }
  }

  const codexBin = (config.adapters && config.adapters.codex && config.adapters.codex.bin) || 'codex';

  if (p === '/auth') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return true; }
  if (p === '/auth/status') { send(res, 200, status()); return true; }
  if (p === '/auth/codex/start' && req.method === 'POST') { send(res, 200, codexStart(codexBin)); return true; }
  if (p === '/auth/codex/status') { send(res, 200, codexStatus()); return true; }
  if (p === '/auth/gemini/creds' && req.method === 'POST') {
    try { await readBody(req).then(geminiWriteCreds); send(res, 200, { ok: true }); }
    catch (e) { send(res, 400, { error: 'invalid creds JSON: ' + e.message }); }
    return true;
  }
  send(res, 404, { error: 'unknown auth route' });
  return true;
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cli-gateway · connectors</title><style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#1f1e1d;color:#ece9e3;max-width:640px;margin:0 auto;padding:24px}
h1{font-size:20px}.row{display:flex;align-items:center;justify-content:space-between;background:#2a2927;border:1px solid #3a3836;border-radius:12px;padding:14px 16px;margin:10px 0}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:8px}.ok{background:#7bbf6a}.no{background:#d9574e}
button{background:#d97757;color:#1a1a1a;border:0;border-radius:9px;padding:9px 14px;font-weight:600;cursor:pointer}button:hover{background:#c4613f}
code{background:#141312;padding:2px 6px;border-radius:5px;font-family:ui-monospace,monospace}
.box{background:#141312;border:1px solid #3a3836;border-radius:10px;padding:12px;margin-top:8px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12.5px;display:none}
textarea{width:100%;height:90px;background:#141312;color:#ece9e3;border:1px solid #3a3836;border-radius:8px;padding:8px;font-family:ui-monospace,monospace;font-size:12px}
a{color:#d97757}.muted{color:#a8a39a;font-size:13px}
</style></head><body>
<h1>✳ cli-gateway · connectors</h1>
<p class="muted">Connect or re-connect a backend without SSHing into the box.</p>
<div id="rows"></div>

<div class="row" style="flex-direction:column;align-items:stretch">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div><span id="codexdot" class="dot no"></span><b>Codex</b> <span class="muted">— ChatGPT login (device code)</span></div>
    <button onclick="codexStart()">Connect Codex</button>
  </div>
  <div id="codexbox" class="box"></div>
</div>

<div class="row" style="flex-direction:column;align-items:stretch">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div><span id="geminidot" class="dot no"></span><b>Gemini</b> <span class="muted">— paste ~/.gemini/oauth_creds.json</span></div>
    <button onclick="saveGemini()">Save creds</button>
  </div>
  <p class="muted">Log in once on a machine with a browser (<code>gemini</code> → Login with Google), then paste the contents of <code>~/.gemini/oauth_creds.json</code> here.</p>
  <textarea id="geminicreds" placeholder='{ "access_token": "...", "refresh_token": "...", ... }'></textarea>
</div>

<script>
const key = new URLSearchParams(location.search).get('key');
const q = (u)=> u + (key? (u.includes('?')?'&':'?')+'key='+encodeURIComponent(key):'');
async function refresh(){
  const s = await (await fetch(q('/auth/status'))).json();
  document.getElementById('rows').innerHTML =
    '<div class="row"><div><span class="dot '+(s.claude?'ok':'no')+'"></span><b>Claude</b> <span class="muted">— Pro/Max login</span></div><span class="muted">'+(s.claude?'connected':'not connected')+'</span></div>';
  document.getElementById('codexdot').className='dot '+(s.codex?'ok':'no');
  document.getElementById('geminidot').className='dot '+(s.gemini?'ok':'no');
}
async function codexStart(){
  const box=document.getElementById('codexbox'); box.style.display='block'; box.textContent='starting…';
  await fetch(q('/auth/codex/start'),{method:'POST'});
  const poll=async()=>{
    const d=await (await fetch(q('/auth/codex/status'))).json();
    let msg='';
    if(d.url) msg+='1) Open: '+d.url+'\\n';
    if(d.code) msg+='2) Enter code: '+d.code+'\\n\\n';
    msg += (d.authed?'✅ Connected!':(d.running?'waiting for you to finish on your phone…':'')) + '\\n\\n'+(d.output||'');
    box.textContent=msg; refresh();
    if(!d.authed && (d.running||!d.output)) setTimeout(poll,2500);
  };
  poll();
}
async function saveGemini(){
  const v=document.getElementById('geminicreds').value;
  const r=await fetch(q('/auth/gemini/creds'),{method:'POST',body:v});
  const d=await r.json(); alert(d.ok?'Saved. Gemini connected.':('Error: '+(d.error||'failed'))); refresh();
}
refresh(); setInterval(refresh,5000);
</script></body></html>`;

module.exports = { handle, status };
