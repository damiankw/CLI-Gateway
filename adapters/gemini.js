'use strict';

/*
 * Adapter: Google Gemini CLI  (`gemini -p`)
 * Auth: run `gemini` once and log in with a Google account (free tier) or set
 *       GEMINI_API_KEY.
 * Status: interface wired to documented flags; verify after login.
 *
 * Notes: Gemini CLI has no --system-prompt flag, so the system message is
 * prepended to the prompt. `--approval-mode plan` keeps it read-only (no tools).
 */

function foldSystem(system, prompt) {
  return system && system.trim() ? `${system}\n\n${prompt}` : prompt;
}

// dig token counts out of gemini's stats blob, wherever they live
function statsUsage(stats) {
  if (!stats || typeof stats !== 'object') return { prompt_tokens: 0, completion_tokens: 0 };
  let prompt = 0, completion = 0;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') {
        if (/prompt|input/i.test(k)) prompt += v;
        else if (/candidate|output|completion/i.test(k)) completion += v;
      } else walk(v);
    }
  };
  walk(stats);
  return { prompt_tokens: prompt, completion_tokens: completion };
}

module.exports = {
  id: 'gemini',
  bin: 'gemini',

  models: [
    { id: 'gemini-2.5-pro', alias: ['pro'] },
    { id: 'gemini-2.5-flash', alias: ['flash'] },
    { id: 'gemini-2.5-flash-lite', alias: ['flash-lite'] },
    { id: 'gemini-2.0-flash', alias: [] },
  ],

  buildArgs({ prompt, system, model, stream, cfg }) {
    const fmt = stream ? 'stream-json' : 'json';
    const args = ['-p', foldSystem(system, prompt), '-m', model, '-o', fmt];
    // Only request an approval mode when tools are allowed. Asking for `plan` in
    // an untrusted folder trips gemini's folder-trust guard; leaving it unset in
    // an untrusted cwd (see config) already means no tools run.
    if (cfg && cfg.allowTools) args.push('--approval-mode', 'yolo');
    return args;
  },

  parseFinal(stdout) {
    let d;
    try { d = JSON.parse(stdout); } catch { return { text: stdout.trim(), finishReason: 'stop', usage: { prompt_tokens: 0, completion_tokens: 0 } }; }
    // gemini exits 0 even on failure, putting the problem in `error`
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    const text = d.response || d.text || d.content || (d.candidates && d.candidates[0] && d.candidates[0].content) || '';
    return { text: typeof text === 'string' ? text : JSON.stringify(text), finishReason: 'stop', usage: statsUsage(d.stats) };
  },

  parseStreamLine(line, emit) {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    if (d.error) { emit({ error: d.error.message || JSON.stringify(d.error) }); return; }
    // tolerate several shapes of gemini stream-json events
    const piece =
      (d.type === 'content' && (d.content || d.text)) ||
      (d.delta && (d.delta.text || d.delta.content)) ||
      (d.response && typeof d.response === 'string' && d.response) ||
      (typeof d.text === 'string' && d.text) || '';
    if (piece) emit({ delta: piece });
    if (d.stats) emit({ usage: statsUsage(d.stats) });
  },
};
