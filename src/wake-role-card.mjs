// 人设卡注入决策（纯函数，便于单测）。
// 规则：新会话首次唤醒、角色/会话/卡片内容变化、或上下文刚被压缩时，注入完整角色卡；
// 其余轮次只给一行「已注入」，避免每轮重复几千字的卡正文。
export function roleCardRecordMatches(record, { roleName, sha, sessionId }) {
  if (!record || typeof record !== 'object') return false;
  return String(record.role || '') === String(roleName || '')
    && String(record.sha || '') === String(sha || '')
    && String(record.sessionId || '') === String(sessionId || '');
}

export function shouldInjectRoleCard({ reason, hasCompactionNotice, recorded }) {
  if (reason === 'bootstrap') return true;
  if (hasCompactionNotice) return true;
  return !recorded;
}

export function composeRoleLine({ roleName, text = '', inject = false, recorded = false }) {
  if (!roleName) return '';
  if (inject && text) return `【当前角色】${roleName}\n\n${text}\n\n`;
  if (recorded) return `【当前角色】${roleName}（角色卡已注入；工具清单与状态仍可调 qq_get_prompt 查看）\n\n`;
  return `【当前角色】${roleName}（完整角色卡请调用 qq_get_prompt 查看）\n\n`;
}
