'use strict';

/*
 * Adapter: OpenAI Codex CLI  (`codex exec --json`)
 * Auth: run `codex login` once (ChatGPT subscription) or set OPENAI_API_KEY.
 * Status: interface wired to documented flags; verify after login.
 *
 * Codex always emits JSONL thread events (even non-streaming), so both paths
 * parse the same event stream. There is no --system-prompt flag, so the system
 * message is prepended to the prompt.
 */

function foldSystem(system, prompt) {
  return system && system.trim() ? `${system}\n\n${prompt}` : prompt;
}

// Pull assistant text out of a codex thread event, tolerating schema variants.
function assistantText(d) {
  const item = d.item || d.msg || d;
  const type = item && (item.type || item.role || '');
  if (!/assistant|agent|message/i.test(String(type))) return '';
  const c = item.text || item.content || item.message || '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b && b.text) || '').join('');
  return '';
}

function eventUsage(d) {
  const u = d.usage || (d.turn && d.turn.usage) || null;
  if (!u) return null;
  return {
    prompt_tokens: u.input_tokens || u.prompt_tokens || 0,
    completion_tokens: u.output_tokens || u.completion_tokens || 0,
  };
}

module.exports = {
  id: 'codex',
  bin: 'codex',

  models: [
    { id: 'gpt-5-codex', alias: ['codex'] },
    { id: 'gpt-5', alias: [] },
    { id: 'o3', alias: [] },
    { id: 'o4-mini', alias: ['mini'] },
  ],

  buildArgs({ prompt, system, model, cfg }) {
    const sandbox = cfg && cfg.allowTools ? 'workspace-write' : 'read-only';
    // --json works for both stream and non-stream; core reduces the JSONL either way
    return ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-m', model, foldSystem(system, prompt)];
  },

  parseFinal(stdout) {
    let text = '', usage = { prompt_tokens: 0, completion_tokens: 0 }, finishReason = 'stop';
    for (const line of stdout.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let d; try { d = JSON.parse(s); } catch { continue; }
      if (/completed/i.test(d.type || '')) { const t = assistantText(d); if (t) text = t; }
      const u = eventUsage(d); if (u) usage = u;
    }
    if (!text) throw new Error('no assistant message in codex output (is `codex login` done?)');
    return { text, usage, finishReason };
  },

  // codex emits item-level (not token-level) events, so stream = whole message chunks
  parseStreamLine(line, emit) {
    let d; try { d = JSON.parse(line); } catch { return; }
    if (/completed/i.test(d.type || '')) { const t = assistantText(d); if (t) emit({ delta: t }); }
    const u = eventUsage(d); if (u) emit({ usage: u });
  },
};
