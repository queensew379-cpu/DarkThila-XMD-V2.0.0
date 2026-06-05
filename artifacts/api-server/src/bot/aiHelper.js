/**
 * AI Chat Helper — Dark Thila Bot
 * Uses Replit AI Integrations (OpenAI-compatible) — no API key required.
 * Maintains per-user conversation history in memory.
 */

const BASE_URL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const API_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || 'dummy';

// Per-session, per-user conversation history
// Map<sessionId, Map<userJid, Message[]>>
const sessionConversations = new Map();

const MAX_HISTORY = 20;
const MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `උඹේ නම Dark Thila X MD. උඹව හැදුවෙ Thilina Ananda, වයස 20.

පෞරුෂත්වය:
1. කතා කරන්නෙ පට්ට ෆිට් යාලුවෙක් වගේ. සිංහලෙන්. "මචන්, අඩෝ, එල, සිරා, යකෝ" කියන වචන use කරනවා.
2. උත්තර දෙන්නෙ කොටටයි කෙලින්මයි. Users ලා mobile එකේ නිසා පාඩම් කියවන්නෙ නෑ. අනවශ්‍ය විස්තර දෙන්නෙ නෑ.
3. emoji 😎🔥😂💪 පාවිච්චි කරනවා හැබැයි ඕනවට වඩා නෙමෙයි. වචන වලින් වැඩ ගන්නවා.
4. Em dash — මේක පාවිච්චි කරන්න එපා. ඒ වෙනුවට කොමා, full stop, හරි colon දාපන්.
5. දන්නෙ නැත්තම් බොරු නොකියා "මම ඒක දන්නෙ නෑ මචන්" කියනවා.
6. කවදාවත් "මම AI එකක්, භාෂා මොඩලයක්" කියන්න එපා. උඹ Dark Thila X MD බොට්. ඒක තමයි උඹේ identity එක.
7. සමාජීය දේශපාලන මාතෘකා වලට බය නැතුව උත්තර දෙනවා.
8. වැරදි දෙයක් ඇහුවොත් ආතල් එකේ "ඒක නම් බෑ මචන්" කියලා කෙලින්ම කියනවා. Lecture දෙන්නෙ නෑ.
9. User කෙනෙක් ආයෙමත් ඒකම ඇහුවොත් අලුතෙන් උත්තර දෙනවා.
උඹේ goal එක user ට උදව් කරන එකයි, ආතල් එකේ chat කරන එකයි.`;

const getHistory = (sessionId, userJid) => {
  if (!sessionConversations.has(sessionId)) {
    sessionConversations.set(sessionId, new Map());
  }
  const sessionMap = sessionConversations.get(sessionId);
  if (!sessionMap.has(userJid)) {
    sessionMap.set(userJid, []);
  }
  return sessionMap.get(userJid);
};

/**
 * Send a message to AI and get a reply.
 * @param {string} sessionId - Bot session ID
 * @param {string} userJid   - Sender JID (for history tracking)
 * @param {string} userText  - User's message text
 * @returns {Promise<string>} AI reply text
 */
export const askAI = async (sessionId, userJid, userText) => {
  if (!BASE_URL) throw new Error('AI_INTEGRATIONS_OPENAI_BASE_URL is not set');

  const history = getHistory(sessionId, userJid);
  history.push({ role: 'user', content: userText });

  // Keep only last MAX_HISTORY messages to stay within context limits
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const body = {
    model: MODEL,
    max_completion_tokens: 800,
    temperature: 0.9,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
    ],
  };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const assistantMsg = data.choices?.[0]?.message?.content?.trim();
  if (!assistantMsg) throw new Error('AI returned empty response');

  // Save assistant reply to history
  history.push({ role: 'assistant', content: assistantMsg });

  return assistantMsg;
};

/**
 * Clear conversation history for a specific user in a session.
 * @param {string} sessionId
 * @param {string} [userJid] - If omitted, clears ALL users in this session
 */
export const clearAIHistory = (sessionId, userJid) => {
  if (!sessionConversations.has(sessionId)) return;
  const sessionMap = sessionConversations.get(sessionId);
  if (userJid) {
    sessionMap.delete(userJid);
  } else {
    sessionMap.clear();
  }
};
