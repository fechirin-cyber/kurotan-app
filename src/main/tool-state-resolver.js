'use strict';

// ─── Stage モード: tool_name → state ID ──────────────────────────
//
// Agent / Task は PreToolUse で子くろたん生成の専用経路 (§5.6.4) を持つため
// ここでは明示的に null を返し、index.js の else-if 分岐に委ねる。
// それ以外の未知ツール (MCP 系・将来ツール等) は tool_other に集約する。

const STAGE_TOOL_STATE_MAP = {
  'Read':         'tool_read',
  'Glob':         'tool_read',
  'Grep':         'tool_read',
  'Edit':         'tool_edit',
  'Write':        'tool_edit',
  'NotebookEdit': 'tool_edit',
  'Bash':         'tool_bash',
  'BashOutput':   'tool_bash',
  'KillShell':    'tool_bash',
  'WebFetch':     'tool_web',
  'WebSearch':    'tool_web',
  'Skill':        'tool_skill',
};

/** Agent / Task は子くろたん生成経路 (§5.6.4) が担うため null を維持 */
const AGENT_TASK_TOOLS = new Set(['Agent', 'Task']);

/**
 * ツール名を state ID に解決する。
 *
 * @param {string} toolName
 * @returns {string|null}
 * - 既知ツール → 対応 state ID ('tool_read' 等)
 * - Agent / Task → null (専用経路に委ねる)
 * - その他未知ツール → 'tool_other'
 */
function resolveToolState(toolName) {
  if (STAGE_TOOL_STATE_MAP[toolName]) {
    return STAGE_TOOL_STATE_MAP[toolName];
  }
  if (AGENT_TASK_TOOLS.has(toolName)) {
    return null;
  }
  return 'tool_other';
}

module.exports = { resolveToolState, STAGE_TOOL_STATE_MAP, AGENT_TASK_TOOLS };
