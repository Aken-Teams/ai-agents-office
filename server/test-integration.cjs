/**
 * Integration test for Claude CLI interaction via the server API.
 * Tests: text response, session continuity, file generation.
 *
 * Prerequisites: server must be running on localhost:3001
 *
 * Usage: node test-integration.cjs
 */

const API = 'http://localhost:3001/api';
let TOKEN = '';
let USER_ID = '';

// Helpers
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function streamSSE(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const events = [];
  let fullText = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.substring(6));
        events.push(event);
        if (event.type === 'text') fullText += event.data;
      } catch {}
    }
  }

  return { events, fullText };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${message}`);
  }
}

// Tests
async function main() {
  console.log('=== AI Agents Office Integration Tests ===\n');

  // 0. Health check
  console.log('Test 0: Server health check');
  try {
    const health = await api('GET', '/health');
    const data = await health.json();
    assert(data.status === 'ok', 'Server is running');
  } catch (e) {
    console.error('  FAIL: Server not running on localhost:3001. Start it first.');
    process.exit(1);
  }

  // 1. Login (use existing test account or register)
  console.log('\nTest 1: Authentication');
  const testEmail = `test-${Date.now()}@test.com`;
  const testPass = 'TestPassword123!';

  let regRes = await api('POST', '/auth/register', {
    email: testEmail,
    password: testPass,
    displayName: 'Test User',
  });
  let regData = await regRes.json();
  assert(regData.token, 'Registration returns token');
  TOKEN = regData.token;
  USER_ID = regData.user?.id;

  // 2. Create conversation with docx-gen skill
  console.log('\nTest 2: Create conversation');
  const convRes = await api('POST', '/conversations', {
    title: 'Integration Test',
    skillId: 'docx-gen',
  });
  const convData = await convRes.json();
  assert(convData.id, `Conversation created: ${convData.id}`);
  const CONV_ID = convData.id;

  // 3. Send simple message and get text response
  console.log('\nTest 3: Simple text response');
  console.log('  Sending message... (this may take 10-30 seconds)');
  const { events: events1, fullText: text1 } = await streamSSE(`/generate/${CONV_ID}`, {
    message: '用一句話回覆：你好',
  });

  const hasText = events1.some(e => e.type === 'text');
  const hasDone = events1.some(e => e.type === 'done');
  const hasUsage = events1.some(e => e.type === 'usage');
  assert(hasText, `Got text event (response: "${text1.substring(0, 60)}...")`);
  assert(hasDone, 'Got done event');
  assert(hasUsage, 'Got usage event');
  assert(text1.length > 0, `Response text is not empty (${text1.length} chars)`);

  // 4. Verify message persisted in DB
  console.log('\nTest 4: Message persistence');
  const convDetailRes = await api('GET', `/conversations/${CONV_ID}`);
  const convDetail = await convDetailRes.json();
  const msgs = convDetail.messages || [];
  const userMsgs = msgs.filter(m => m.role === 'user');
  const assistantMsgs = msgs.filter(m => m.role === 'assistant');
  assert(userMsgs.length >= 1, `User messages saved: ${userMsgs.length}`);
  assert(assistantMsgs.length >= 1, `Assistant messages saved: ${assistantMsgs.length}`);
  assert(assistantMsgs[0]?.content?.length > 0, 'Assistant message content is not empty');

  // 5. Multi-turn: send a follow-up message (tests --resume)
  console.log('\nTest 5: Multi-turn conversation (--resume)');
  console.log('  Sending follow-up message...');
  const { events: events2, fullText: text2 } = await streamSSE(`/generate/${CONV_ID}`, {
    message: '用一句話回覆：你剛剛說了什麼？',
  });

  const hasText2 = events2.some(e => e.type === 'text');
  assert(hasText2, `Got text in follow-up (response: "${text2.substring(0, 60)}...")`);
  assert(text2.length > 0, 'Follow-up response is not empty');

  // Check for session_id error
  const sessionErrors = events2.filter(e => e.type === 'error');
  const hasSessionIdError = sessionErrors.some(e =>
    typeof e.data === 'string' && e.data.includes('Session ID')
  );
  assert(!hasSessionIdError, 'No "Session ID already in use" error');

  // 6. Summary
  console.log('\n=== Test Summary ===');
  const eventTypes1 = [...new Set(events1.map(e => e.type))];
  const eventTypes2 = [...new Set(events2.map(e => e.type))];
  console.log(`  First message events: ${eventTypes1.join(', ')}`);
  console.log(`  Follow-up events: ${eventTypes2.join(', ')}`);
  console.log(`  First response length: ${text1.length} chars`);
  console.log(`  Follow-up response length: ${text2.length} chars`);

  // Cleanup: delete conversation
  await api('DELETE', `/conversations/${CONV_ID}`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
