'use strict';

/*
 * Adapter: Anthropic Claude Code CLI  (`claude -p`)
 * Auth: `claude` (Pro/Max subscription) or ANTHROPIC_API_KEY.
 */

const SUPPRESS_TOOLS = [
  'Task', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Skill', 'Workflow', 'AskUserQuestion', 'ToolSearch',
];

module.exports = {
  id: 'claude',
  bin: 'claude',

  models: [
    { id: 'claude-opus-4-8', alias: ['opus'] },
    { id: 'claude-sonnet-4-6', alias: ['sonnet'] },
    { id: 'claude-haiku-4-5-20251001', alias: ['haiku'] },
  ],

  buildArgs({ prompt, system, model, stream, cfg }) {
    const args = ['-p', prompt, '--model', model, '--system-prompt', system];
    args.push(...(stream
      ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']
      : ['--output-format', 'json']));
    if (!(cfg && cfg.allowTools)) args.push('--disallowedTools', ...SUPPRESS_TOOLS);
    return args;
  },

  parseFinal(stdout) {
    const d = JSON.parse(stdout);
    if (d.is_error) throw new Error(String(d.result || 'claude error'));
    const u = d.usage || {};
    return {
      text: d.result || '',
      finishReason: d.stop_reason,
      usage: {
        prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        completion_tokens: u.output_tokens || 0,
      },
    };
  },

  parseStreamLine(line, emit) {
    const d = JSON.parse(line);
    if (d.type === 'stream_event' && d.event) {
      const ev = d.event;
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        emit({ delta: ev.delta.text || '' });
      }
    } else if (d.type === 'result') {
      const u = d.usage || {};
      emit({
        finishReason: d.stop_reason,
        usage: {
          prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          completion_tokens: u.output_tokens || 0,
        },
      });
      if (d.is_error && d.result) emit({ error: String(d.result).slice(0, 500) });
    }
  },
};
