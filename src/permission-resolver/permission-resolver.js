'use strict';

/**
 * permission-resolver.js — §5.11 Permission Mode (Auto / Custom 切替) v2
 *
 * 公開 API:
 * resolve(payload) → { decision, source, matchedRule }
 * mapToolNameToToolType(toolName) → ToolType (9 種別 / null を返さない)
 *
 * 照合キー抽出 (buildMatchKey) は §5.11.4.2 の実機確定値に準拠:
 * - Agent: tool_input.subagent_type (T0 実機確定)
 * - Skill: tool_input.skill (T0 実機確定 / skill_name ではない)
 *
 * v2 変更点 :
 * - mapToolNameToToolType() 追加 (9 種別 / + Q10=A)
 * - resolve() に Custom モード対応追加 (§5.11.5.6 疑似コード 5 ステップ)
 * - Custom モード設定ファイル: %APPDATA%/kurotan/custom-confirm-config.json (v2 形式)
 * - source enum 拡張 (§5.11.6.2 準拠)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEBUG = process.env.KUROTAN_DEBUG === '1';
function dbg(...args) {
  if (DEBUG) process.stderr.write('[permission-resolver] ' + args.join(' ') + '\n');
}

// ─── §5.11.6.2 matchKey 切り詰め + secret マスク (機密漏洩防止) ─────────────
/**
 * matchKey を先頭 60 文字に切り詰める (§5.11.6.2 仕様要件) + 既知のシークレットパターンをマスク。
 * tool-call-history.json に永続保存される照合キーが
 * Bash コマンド先頭 60 文字 / Read/Edit ファイルパス / WebSearch query などを含むため、
 * 含まれうる API キー / token / Bearer / password 等を `***` に置換する。
 *
 * @param {string | null} key
 * @returns {string | null}
 */
const SECRET_MASK_PATTERNS = [
 // sk-XXXX (Anthropic / OpenAI 等)
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replace: 'sk-***' },
 // ghp_, gho_, ghu_, ghs_ (GitHub tokens)
  { re: /gh[opusr]_[A-Za-z0-9]{16,}/g, replace: 'gh*_***' },
 // Bearer <token>
  { re: /(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, replace: '$1***' },
 // password=xxx / password: xxx (env style)
  { re: /(password\s*[:=]\s*['"]?)[^'"\s,;)}]{2,}/gi, replace: '$1***' },
 // token=xxx / token: xxx
  { re: /(token\s*[:=]\s*['"]?)[^'"\s,;)}]{4,}/gi, replace: '$1***' },
 // api_key=xxx / api-key: xxx
  { re: /(api[_-]?key\s*[:=]\s*['"]?)[^'"\s,;)}]{4,}/gi, replace: '$1***' },
 // secret=xxx
  { re: /(secret\s*[:=]\s*['"]?)[^'"\s,;)}]{4,}/gi, replace: '$1***' },
];

function maskSecrets(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const { re, replace } of SECRET_MASK_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

function truncateMatchKey(key) {
  if (typeof key !== 'string') return key;
  const masked = maskSecrets(key);
  if (masked.length <= 60) return masked;
  return masked.slice(0, 60);
}

// ─── §5.11.4.2 照合キー抽出 ──────────────────────────────────
/**
 * tool_name + tool_input からルール照合に使う「照合キー」を返す。
 * 戻り値: string | null (null = 照合キー抽出不能 → フォールバック)
 * 返却値は §5.11.6.2 に従い先頭 60 文字に切り詰める。
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string | null}
 */
function buildMatchKey(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
      const cmd = toolInput.command;
      if (typeof cmd !== 'string') return null;
      return truncateMatchKey(cmd);
    }
    case 'Read': {
      const fp = toolInput.file_path || toolInput.path;
      if (typeof fp !== 'string') return null;
      return truncateMatchKey(fp);
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const fp = toolInput.file_path;
      if (typeof fp !== 'string') return null;
      return truncateMatchKey(fp);
    }
    case 'Glob': {
 // pattern or path どちらも照合対象として使う
      const key = toolInput.pattern || toolInput.path || toolInput.file_path;
      if (typeof key !== 'string') return null;
      return truncateMatchKey(key);
    }
    case 'Grep': {
      const key = toolInput.path || toolInput.file_path || toolInput.pattern;
      if (typeof key !== 'string') return null;
      return truncateMatchKey(key);
    }
    case 'WebFetch': {
      const url = toolInput.url;
      if (typeof url !== 'string') return null;
      try {
        return truncateMatchKey(new URL(url).hostname);
      } catch (_) {
        return null;
      }
    }
    case 'WebSearch': {
      const q = toolInput.query;
      if (typeof q !== 'string') return null;
      return truncateMatchKey(q);
    }
    case 'Agent':
    case 'Task': {
 // T0 実機確定: tool_input.subagent_type
      const st = toolInput.subagent_type || toolInput.agent_type;
      if (typeof st !== 'string') return null;
      return truncateMatchKey(st);
    }
    case 'Skill': {
 // T0 実機確定: tool_input.skill (skill_name ではない)
      const sk = toolInput.skill;
      if (typeof sk !== 'string') return null;
      return truncateMatchKey(sk);
    }
    default: {
 // mcp__* など前方一致の tool_name はキー不要 (tool_name だけでマッチ)。
 // ただし未知 tool (Other 種別) は toolName 自体を照合キーに使う。
 // これにより specifier 付きルール (MyCustomTool(foo) / MyNewTool(rm:*) 等) が
 // 未知 tool でも機能する (qa BUG-I-19 / I-24 修正、セキュリティ向上)。
      if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
 return ''; // mcp__* は従来通り tool 名前方一致
      }
      return truncateMatchKey(typeof toolName === 'string' ? toolName : '');
    }
  }
}

// ─── §5.11.4.2 rule 構文パース ───────────────────────────────
/**
 * rule 文字列 ("Bash(echo:*)" 等) を解析して { toolPart, specifier } を返す。
 * 不正な構文は null を返す。
 *
 * quote-aware: " または ' で囲まれた範囲内の () はネスト判定から除外する。
 * \" \' のエスケープシーケンスも考慮する。
 * 改行を含む specifier も受け付ける。
 *
 * @param {string} rule
 * @returns {{ toolPart: string, specifier: string | null } | null}
 */
function parseRule(rule) {
  if (typeof rule !== 'string' || !rule) return null;

  const parenIdx = rule.indexOf('(');
  if (parenIdx === -1) {
 // 括弧なし: Tool 名のみ (全マッチ)
    return { toolPart: rule.trim(), specifier: null };
  }

  const toolPart = rule.slice(0, parenIdx).trim();

 // quote-aware で対応する closing ')' を探す
 // parenIdx の '(' に対応する ')' を見つける。
 // クォート (" or ') 内の括弧はネスト判定から除外する。
  let depth = 0;
 let inQuote = null; // null | '"' | "'"
  let closingIdx = -1;

  for (let i = parenIdx; i < rule.length; i++) {
    const ch = rule[i];

    if (inQuote) {
 // クォート内: エスケープを読み飛ばし、閉じクォートを検出
      if (ch === '\\' && i + 1 < rule.length) {
 i++; // エスケープされた次の文字をスキップ
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
 // クォート内の () はネスト判定に使わない
      continue;
    }

 // クォート外
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        closingIdx = i;
        break;
      }
    }
  }

  if (closingIdx === -1) {
 // 対応する ')' が見つからない → 不正
    return null;
  }

  if (closingIdx !== rule.length - 1) {
 // closing ')' の後に余分な文字がある → 不正
    return null;
  }

  const specifier = rule.slice(parenIdx + 1, closingIdx);

 // ネストした括弧 (クォート外) はサポートしない
 // depth === 0 で抜けているので parenIdx+1..closingIdx-1 内に
 // クォート外の '(' や ')' が depth を超えて残っていないかチェック
  {
    let d = 0;
    let iq = null;
    for (let i = 0; i < specifier.length; i++) {
      const ch = specifier[i];
      if (iq) {
        if (ch === '\\' && i + 1 < specifier.length) { i++; continue; }
        if (ch === iq) { iq = null; }
        continue;
      }
      if (ch === '"' || ch === "'") { iq = ch; continue; }
      if (ch === '(') d++;
      else if (ch === ')') d--;
 if (d !== 0) return null; // ネストした括弧 → 不正
    }
  }

  return { toolPart, specifier };
}

// ─── §5.11.4.2 glob / prefix マッチ ────────────────────────
/**
 * specifier と subject (照合キー) をマッチさせる。
 * 構文:
 * - specifier なし (null) → subject 問わず true
 * - "prefix:*" 末尾 wildcard → word-boundary prefix マッチ
 * - "prefix *" 空白区切り → word-boundary prefix マッチ
 * - "*" / "**" を含む glob → globMatch()
 * - WebFetch の "domain:hostname" → domain 比較
 * - その他 → 完全一致
 *
 * @param {string | null} specifier
 * @param {string} subject
 * @param {string} toolName
 * @returns {boolean}
 */
function matchSpecifier(specifier, subject, toolName) {
 // 引数なし (Tool 名のみ) → 全マッチ
  if (specifier === null) return true;

 // WebFetch: "domain:hostname" 形式
  if ((toolName === 'WebFetch') && specifier.startsWith('domain:')) {
    const domainPattern = specifier.slice('domain:'.length);
    return globMatch(domainPattern, subject);
  }

 // "prefix:*" 末尾ワイルドカード → word-boundary prefix
  if (specifier.endsWith(':*')) {
 const prefix = specifier.slice(0, -2); // 末尾の ':*' を除去
 // word boundary: subject が <prefix> + 空白 または <prefix> と一致
 // ただし subject が prefixX... のように繋がっている場合はマッチしない
    if (subject === prefix) return true;
    if (subject.startsWith(prefix + ' ') || subject.startsWith(prefix + '\t')) return true;
    return false;
  }

 // "prefix *" 空白区切り → word-boundary prefix
  if (specifier.endsWith(' *')) {
 const prefix = specifier.slice(0, -2); // 末尾の ' *' を除去
    if (subject === prefix) return true;
    if (subject.startsWith(prefix + ' ') || subject.startsWith(prefix + '\t')) return true;
    return false;
  }

 // "*" や "**" を含む glob
  if (specifier.includes('*') || specifier.includes('?')) {
    return globMatch(specifier, subject);
  }

 // Agent / Skill: exact match
  if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Skill') {
    return subject === specifier;
  }

 // 完全一致 (Read/Edit/Write の path 完全一致)
  return subject === specifier;
}

/**
 * 簡易 glob マッチ。
 * "*" → 単一階層 (path セパレータを跨がない)
 * "**" → 複数階層
 *
 * @param {string} pattern
 * @param {string} str
 * @returns {boolean}
 */
function globMatch(pattern, str) {
 // glob を正規表現に変換
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
 // "**" → 任意文字列 (セパレータ含む)
      regexStr += '.*';
      i += 2;
 // 続く '/' は省略してもよい
      if (pattern[i] === '/' || pattern[i] === '\\') i++;
    } else if (pattern[i] === '*') {
 // "*" → セパレータを除く任意文字列
      regexStr += '[^/\\\\]*';
      i++;
    } else if (pattern[i] === '?') {
      regexStr += '[^/\\\\]';
      i++;
    } else {
 // 正規表現特殊文字をエスケープ
      regexStr += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  try {
    return new RegExp('^' + regexStr + '$', 'i').test(str);
  } catch (_) {
    return false;
  }
}

// ─── §5.11.4.2 rule vs payload マッチ ───────────────────────
/**
 * 1 つの rule が payload にマッチするか判定する。
 * フォールバック (null 返却) は呼び出し元で処理する。
 *
 * @param {string} rule
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string | null} matchKey - buildMatchKey() の結果
 * @returns {boolean}
 */
function matchRule(rule, toolName, toolInput, matchKey) {
  const parsed = parseRule(rule);
  if (!parsed) {
    dbg('rule parse failed:', rule);
 return false; // 不正 rule はスキップ (フォールバックは resolve() で担う)
  }

  const { toolPart, specifier } = parsed;

 // mcp__* 前方一致
  if (toolPart.endsWith('*') || toolPart.endsWith('__*')) {
    const prefixWithoutStar = toolPart.slice(0, -1);
    if (!toolName.startsWith(prefixWithoutStar)) return false;
    return true;
  }

 // tool 名が一致しない → マッチしない
  if (toolPart !== toolName) {
 // Agent と Task は同等扱い (spec §5.11.4.2 より rule "Agent" は tool_name "Task" にも効く)
    if (!((toolPart === 'Agent' && toolName === 'Task') || (toolPart === 'Task' && toolName === 'Agent'))) {
      return false;
    }
  }

 // 引数なし → tool 名一致で OK
  if (specifier === null) return true;

 // 照合キー取得失敗 → マッチしない (安全側)
  if (matchKey === null) return false;

  return matchSpecifier(specifier, matchKey, toolName);
}

// ─── §5.11.4.3 ツール名 → ツール種別マッピング (v2 / + Q10=A) ────
/**
 * ツール名を 9 種別のいずれかにマッピングする。
 * null を返すケースは存在しない (未知 tool は "Other" を返す)。
 *
 * @param {string} toolName
 * @returns {"Bash"|"Read"|"Edit"|"Search"|"Web"|"Skill"|"Agent"|"mcp__*"|"Other"}
 */
function mapToolNameToToolType(toolName) {
  if (typeof toolName !== 'string') return 'Other';

  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
      return 'Bash';
    case 'Read':
      return 'Read';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'Edit';
    case 'Glob':
    case 'Grep':
      return 'Search';
    case 'WebFetch':
    case 'WebSearch':
      return 'Web';
    case 'Skill':
      return 'Skill';
    case 'Agent':
    case 'Task':
      return 'Agent';
    default:
 // mcp__* 前方一致 (§5.11.4.3 マッピング表 #8)
      if (toolName.startsWith('mcp__')) return 'mcp__*';
 // 上記以外は全て Other (Q10=A / 未知 tool のデフォルトカテゴリ)
      return 'Other';
  }
}

// ─── §5.11.5.2 Custom 設定ファイル読み込み ─────────────────────
/**
 * v2 Custom 設定ファイルのデフォルト値を生成する。
 * toolTypes は全 9 種別 "inherit" (+ Q10=A)。
 *
 * @returns {{ version: number, toolTypes: object, exceptions: Array }}
 */
function defaultCustomConfig() {
  return {
    version: 2,
    toolTypes: {
      Bash:    'inherit',
      Read:    'inherit',
      Edit:    'inherit',
      Search:  'inherit',
      Web:     'inherit',
      Skill:   'inherit',
      Agent:   'inherit',
      'mcp__*': 'inherit',
      Other:   'inherit',
    },
    exceptions: [],
  };
}

/**
 * Custom 設定ファイルを読み込む。
 * ファイル不存在 / parse 失敗 / v1 検出時はデフォルト値を返す。
 * (v1 → v2 マイグレーションは migration.js が起動時に担う)
 *
 * @param {string} [filePath] - 省略時は %APPDATA%/kurotan/custom-confirm-config.json
 * @returns {{ version: number, toolTypes: object, exceptions: Array }}
 */
function readCustomConfig(filePath) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const defaultPath = path.join(appData, 'kurotan', 'custom-confirm-config.json');
  const configPath = filePath || defaultPath;

  if (!safeFileExists(configPath)) {
    dbg('custom config not found, using defaults:', configPath);
    return defaultCustomConfig();
  }

  const raw = safeReadJson(configPath);
  if (!raw || typeof raw !== 'object') {
    dbg('custom config parse failed, using defaults:', configPath);
    return defaultCustomConfig();
  }

 // v1 検出: マイグレーション未実施の場合はデフォルト値にフォールバック
  if (raw.version === 1 || (raw.version === undefined && Array.isArray(raw.patterns))) {
    dbg('custom config v1 detected, using defaults (migration required):', configPath);
    return defaultCustomConfig();
  }

 // v2 検証
  if (raw.version !== 2) {
    dbg('custom config unknown version:', raw.version, '- using defaults');
    return defaultCustomConfig();
  }

  const config = defaultCustomConfig();

 // toolTypes マージ (不正値はデフォルト "inherit" に戻す)
  const validDecisions = new Set(['allow', 'ask', 'deny', 'inherit']);
  if (raw.toolTypes && typeof raw.toolTypes === 'object') {
    for (const key of Object.keys(config.toolTypes)) {
      const val = raw.toolTypes[key];
      if (typeof val === 'string' && validDecisions.has(val)) {
        config.toolTypes[key] = val;
      } else if (val !== undefined) {
        dbg('invalid toolTypes value for', key, ':', val, '- using inherit');
      }
    }
  }

 // Other キー欠落補完 (§5.11.5.2)
 // 書き戻しは行わない (方針 A: readCustomConfig は読み取り専用。保存は IPC ハンドラ側の責任)
  if (raw.toolTypes && raw.toolTypes['Other'] === undefined) {
    dbg('Other key missing in toolTypes, supplementing with inherit');
  }

 // exceptions 読み込み
  if (Array.isArray(raw.exceptions)) {
    config.exceptions = raw.exceptions.filter(exc => {
      if (!exc || typeof exc.rule !== 'string' || !exc.rule) {
        dbg('invalid exception entry (missing rule), skipping:', JSON.stringify(exc));
        return false;
      }
      if (!validDecisions.has(exc.decision)) {
        dbg('invalid exception decision:', exc.decision, 'for rule:', exc.rule, '- skipping');
        return false;
      }
      return true;
    });
  }

  return config;
}

// ─── §5.11.4.1 settings.json 読み込み ───────────────────────
/**
 * cwd から filesystem root まで遡って .claude/settings.local.json
 * および .claude/settings.json を探索する (最大 50 段)。
 *
 * @param {string} startDir
 * @returns {{ localSettings: object | null, sharedSettings: object | null }}
 */
function findProjectSettings(startDir) {
  let dir = startDir;
  let steps = 0;
  const MAX_STEPS = 50;

  while (steps < MAX_STEPS) {
    const localPath  = path.join(dir, '.claude', 'settings.local.json');
    const sharedPath = path.join(dir, '.claude', 'settings.json');

    const localExists  = safeFileExists(localPath);
    const sharedExists = safeFileExists(sharedPath);

    if (localExists || sharedExists) {
      return {
        localSettings:  localExists  ? safeReadJson(localPath)  : null,
        sharedSettings: sharedExists ? safeReadJson(sharedPath) : null,
      };
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
 // filesystem root に到達
      break;
    }
    dir = parent;
    steps++;
  }

  if (steps >= MAX_STEPS) {
    dbg('project root not found within 50 levels');
  }

  return { localSettings: null, sharedSettings: null };
}

function safeFileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    dbg('safeReadJson failed:', filePath, e.message);
 return null; // parse 失敗もフォールバックシグナル
  }
}

/**
 * User scope settings.json を読む。
 * Windows: %USERPROFILE%\.claude\settings.json
 *
 * @returns {object | null}
 */
function readUserSettings() {
  const userHome = os.homedir();
  const userSettingsPath = path.join(userHome, '.claude', 'settings.json');
  if (!safeFileExists(userSettingsPath)) return null;
  return safeReadJson(userSettingsPath);
}

// ─── permissions マージ ──────────────────────────────────────
/**
 * 複数の settings オブジェクトから permissions.allow / deny / ask を
 * 連結 + 重複排除でマージする (§5.11.4.1)。
 *
 * 読み込み順: user → shared → local (優先度の低い順から連結、
 * 重複は後から登録されたものを捨てる = 先着優先)
 *
 * @param {...(object|null)} settingsObjects
 * @returns {{ allow: string[], deny: string[], ask: string[] }}
 */
function mergePermissions(...settingsObjects) {
  const allow = [];
  const deny  = [];
  const ask   = [];
  const seen = { allow: new Set(), deny: new Set(), ask: new Set() };

  for (const settings of settingsObjects) {
    if (!settings || typeof settings !== 'object') continue;
    const perms = settings.permissions;
    if (!perms || typeof perms !== 'object') continue;

    for (const [key, arr] of [['allow', allow], ['deny', deny], ['ask', ask]]) {
      if (!Array.isArray(perms[key])) continue;
      for (const rule of perms[key]) {
        if (typeof rule === 'string' && !seen[key].has(rule)) {
          seen[key].add(rule);
          arr.push(rule);
        }
      }
    }
  }

  return { allow, deny, ask };
}

// ─── §5.11.4.3 Auto モード解決 ─────────────────────────────
/**
 * Auto モード: settings.json の deny / ask / allow のみで判定する。
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string|null} matchKey
 * @param {{ allow: string[], deny: string[], ask: string[] }} permissions
 * @returns {{ decision: 'allow'|'deny'|'ask', source: string, matchedRule: string|null }}
 */
function resolveAuto(toolName, toolInput, matchKey, permissions) {
  const { allow, deny, ask } = permissions;

  dbg('[auto] deny rules:', deny.length, 'ask rules:', ask.length, 'allow rules:', allow.length);

 // 1. deny 最優先
  for (const rule of deny) {
    try {
      if (matchRule(rule, toolName, toolInput, matchKey)) {
        dbg('[auto] matched deny rule:', rule);
        return { decision: 'deny', source: 'auto-deny', matchedRule: rule };
      }
    } catch (e) {
      dbg('[auto] rule match error (deny):', rule, e.message);
    }
  }

 // 2. ask 評価
  for (const rule of ask) {
    try {
      if (matchRule(rule, toolName, toolInput, matchKey)) {
        dbg('[auto] matched ask rule:', rule);
        return { decision: 'ask', source: 'auto-ask', matchedRule: rule };
      }
    } catch (e) {
      dbg('[auto] rule match error (ask):', rule, e.message);
    }
  }

 // 3. allow 評価
  for (const rule of allow) {
    try {
      if (matchRule(rule, toolName, toolInput, matchKey)) {
        dbg('[auto] matched allow rule:', rule);
        return { decision: 'allow', source: 'auto-allow', matchedRule: rule };
      }
    } catch (e) {
      dbg('[auto] rule match error (allow):', rule, e.message);
    }
  }

 // 4. マッチなし → UI 表示
  dbg('[auto] no match, fallback to UI');
  return { decision: 'ask', source: 'no-match', matchedRule: null };
}

// ─── §5.11.5.6 Custom モード解決 ───────────────────────────
/**
 * Custom モード: §5.11.5.6 疑似コード 5 ステップ実装。
 *
 * 優先順位 (+):
 * Step 1: settings.json deny 最強 → settings-deny
 * Step 2: exceptions[] マッチ (decision != inherit) → custom-exception
 * Step 3: toolTypes[toolType] が allow/ask/deny → custom-tool-type
 * Step 4: toolTypes[toolType] === "inherit" → settings ask → custom-inherit-auto
 * Step 5: settings allow → custom-inherit-auto
 * else: no-match
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string|null} matchKey
 * @param {{ allow: string[], deny: string[], ask: string[] }} permissions
 * @param {{ version: number, toolTypes: object, exceptions: Array }} customConfig
 * @returns {{ decision: 'allow'|'deny'|'ask', source: string, matchedRule: string|null }}
 */
function resolveCustom(toolName, toolInput, matchKey, permissions, customConfig) {
  const { allow, deny, ask } = permissions;

 // Step 1: settings.json deny 最強 ()
  for (const rule of deny) {
    try {
      if (matchRule(rule, toolName, toolInput, matchKey)) {
        dbg('[custom] settings-deny matched rule:', rule);
        return { decision: 'deny', source: 'settings-deny', matchedRule: rule };
      }
    } catch (e) {
      dbg('[custom] rule match error (deny):', rule, e.message);
    }
  }

 // Step 2: 個別パターン例外 ()
  for (const exc of customConfig.exceptions) {
    try {
      if (matchRule(exc.rule, toolName, toolInput, matchKey)) {
        if (exc.decision === 'allow' || exc.decision === 'ask' || exc.decision === 'deny') {
          dbg('[custom] exception matched rule:', exc.rule, 'decision:', exc.decision);
          return {
            decision: exc.decision,
            source: 'custom-exception',
            matchedRule: exc.rule,
          };
        }
 // decision === "inherit" の場合はここで決定せず次へ
        dbg('[custom] exception inherit, falling through to toolType');
 // 最初にマッチした inherit 例外でループを抜け、種別評価 (Step 3) へ進む。
 // 複数の inherit 例外が並んでいても残りは走査しない (spec §5.11.5.6 意図準拠)。
        break;
      }
    } catch (e) {
      dbg('[custom] exception rule match error:', exc.rule, e.message);
    }
  }

 // Step 3: ツール種別 4 状態
  const toolType = mapToolNameToToolType(toolName);
  const typeDecision = customConfig.toolTypes[toolType];
  dbg('[custom] toolType:', toolType, 'typeDecision:', typeDecision);

  if (typeDecision === 'allow') {
    return { decision: 'allow', source: 'custom-tool-type', matchedRule: null };
  }
  if (typeDecision === 'ask') {
    return { decision: 'ask', source: 'custom-tool-type', matchedRule: null };
  }
  if (typeDecision === 'deny') {
    return { decision: 'deny', source: 'custom-tool-type', matchedRule: null };
  }

 // typeDecision === "inherit" → Step 4-5: settings.json ask / allow へフォールバック

 // Step 4: settings.json ask 評価
  for (const rule of ask) {
    try {
      if (matchRule(rule, toolName, toolInput, matchKey)) {
        dbg('[custom] inherit → settings-ask matched rule:', rule);
        return { decision: 'ask', source: 'custom-inherit-auto', matchedRule: rule };
      }
    } catch (e) {
      dbg('[custom] rule match error (ask):', rule, e.message);
    }
  }

 // Step 5: settings.json allow 評価
  for (const rule of allow) {
    try {
      if (matchRule(rule, toolName, toolInput, matchKey)) {
        dbg('[custom] inherit → settings-allow matched rule:', rule);
        return { decision: 'allow', source: 'custom-inherit-auto', matchedRule: rule };
      }
    } catch (e) {
      dbg('[custom] rule match error (allow):', rule, e.message);
    }
  }

 // いずれにもマッチしない → UI 表示 (no-match)
  dbg('[custom] no match, fallback to UI');
  return { decision: 'ask', source: 'no-match', matchedRule: null };
}

// ─── §5.11.4.3 resolve メイン ────────────────────────────────
/**
 * payload を受け取り、Auto / Custom モードの解決結果を返す。
 *
 * @param {{
 * tool_name: string,
 * tool_input: object,
 * cwd: string,
 * sessionId: string,
 * mode?: 'auto'|'custom',
 * customConfigPath?: string,
 * }} payload
 * @returns {{ decision: 'allow'|'deny'|'ask', source: string, matchedRule: string|null }}
 */
function resolve(payload) {
  const toolName        = (payload && payload.tool_name)        || '';
  const toolInput       = (payload && payload.tool_input)       || {};
  const cwd             = (payload && payload.cwd)              || process.cwd();
  const mode            = (payload && payload.mode)             || 'auto';
  const customConfigPath = (payload && payload.customConfigPath) || undefined;

 // フォールバック結果 (例外時の安全側)
  const FALLBACK = { decision: 'ask', source: 'no-match', matchedRule: null };

  try {
 // 1. 照合キー抽出
    let matchKey;
    try {
      matchKey = buildMatchKey(toolName, toolInput);
    } catch (e) {
      dbg('buildMatchKey threw:', e.message);
      dbg('fallback to UI: matchKey extraction error');
      return FALLBACK;
    }

 // 2. settings.json 読み込み
    let userSettings, sharedSettings, localSettings;
    try {
      userSettings = readUserSettings();
      const proj = findProjectSettings(cwd);
      sharedSettings = proj.sharedSettings;
      localSettings  = proj.localSettings;
    } catch (e) {
      dbg('settings read threw:', e.message);
      dbg('fallback to UI: settings read error');
      return FALLBACK;
    }

 // 3. permissions マージ (§5.11.4.1: user → shared → local の順)
    const permissions = mergePermissions(userSettings, sharedSettings, localSettings);

 // 4. Auto / Custom モード分岐
    if (mode === 'custom') {
 // Custom モード: Custom 設定ファイルを読み込んで §5.11.5.6 アルゴリズム実行
      let customConfig;
      try {
        customConfig = readCustomConfig(customConfigPath);
      } catch (e) {
        dbg('customConfig read threw:', e.message);
        dbg('fallback to UI: customConfig read error');
        return FALLBACK;
      }
      return resolveCustom(toolName, toolInput, matchKey, permissions, customConfig);
    }

 // Auto モード (デフォルト)
    return resolveAuto(toolName, toolInput, matchKey, permissions);

  } catch (e) {
 // 予期しない例外 → フォールバック (§5.11.4.4)
    dbg('fallback to UI: unexpected error:', e.message);
    return FALLBACK;
  }
}

module.exports = {
  resolve,
  mapToolNameToToolType,
  buildMatchKey,
  truncateMatchKey,
  matchRule,
  parseRule,
  globMatch,
  mergePermissions,
  readCustomConfig,
  defaultCustomConfig,
};
