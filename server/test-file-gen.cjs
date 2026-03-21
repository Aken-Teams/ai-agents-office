/**
 * Test file generation (DOCX, XLSX, PPTX, PDF).
 * Tests that Claude can use the generator scripts to produce actual files.
 *
 * Prerequisites: server must be running on localhost:3001
 *
 * Usage: node test-file-gen.cjs [docx|xlsx|pptx|pdf|all]
 */

const API = 'http://localhost:3001/api';
let TOKEN = '';

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  return fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function streamAndCollect(convId, message) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
  };
  const res = await fetch(`${API}/generate/${convId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message }),
  });

  const events = [];
  let fullText = '';
  let files = [];
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
        if (event.type === 'file_generated') files.push(...event.data);
        if (event.type === 'tool_activity') {
          console.log(`    Tool: ${event.data.tool} (${event.data.status})${event.data.input ? ' - ' + event.data.input.substring(0, 80) : ''}`);
        }
        if (event.type === 'error') {
          console.log(`    ERROR: ${event.data}`);
        }
      } catch {}
    }
  }

  return { events, fullText, files };
}

async function testFileGen(skillId, prompt, expectedExt) {
  console.log(`\n--- Testing ${skillId} (expecting .${expectedExt}) ---`);
  console.log(`  Prompt: "${prompt.substring(0, 80)}..."`);

  // Create conversation
  const convRes = await api('POST', '/conversations', {
    title: `Test ${skillId}`,
    skillId,
  });
  const conv = await convRes.json();
  console.log(`  Conversation: ${conv.id}`);

  // Send generation request
  console.log('  Sending request... (may take 30-120 seconds)');
  const startTime = Date.now();
  const { fullText, files, events } = await streamAndCollect(conv.id, prompt);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`  Completed in ${elapsed}s`);
  console.log(`  Response: "${fullText.substring(0, 150)}..."`);
  console.log(`  Files generated: ${files.length}`);

  if (files.length > 0) {
    for (const f of files) {
      console.log(`    - ${f.filename} (${f.file_type}, ${f.file_size} bytes)`);

      // Try downloading
      const dlRes = await fetch(`${API}/files/${f.id}/download`, {
        headers: { 'Authorization': `Bearer ${TOKEN}` },
      });
      if (dlRes.ok) {
        const blob = await dlRes.arrayBuffer();
        console.log(`    Download OK: ${blob.byteLength} bytes`);
      } else {
        console.log(`    Download FAILED: ${dlRes.status}`);
      }
    }
    console.log(`  RESULT: PASS`);
  } else {
    // Check if there are files via the API
    const filesRes = await api('GET', `/files?conversationId=${conv.id}`);
    const apiFiles = await filesRes.json();
    if (apiFiles.length > 0) {
      console.log(`  Files found via API: ${apiFiles.length}`);
      for (const f of apiFiles) {
        console.log(`    - ${f.filename} (${f.file_type}, ${f.file_size} bytes)`);
      }
      console.log(`  RESULT: PASS (files detected via API)`);
    } else {
      console.log(`  RESULT: FAIL (no files generated)`);
      // Show event types for debugging
      const types = [...new Set(events.map(e => e.type))];
      console.log(`  Event types: ${types.join(', ')}`);
    }
  }

  return { convId: conv.id, files };
}

async function main() {
  const target = process.argv[2] || 'all';
  console.log('=== File Generation Tests ===');

  // Auth
  const testEmail = `filetest-${Date.now()}@test.com`;
  const regRes = await api('POST', '/auth/register', {
    email: testEmail,
    password: 'TestPassword123!',
    displayName: 'File Test User',
  });
  const regData = await regRes.json();
  TOKEN = regData.token;
  console.log('Authenticated as:', testEmail);

  const tests = {
    'docx-gen': {
      prompt: 'Create a simple Word document with the title "Test Report" and two sections: "Introduction" with the text "This is a test document generated automatically." and "Conclusion" with the text "The test was successful."',
      ext: 'docx',
    },
    'xlsx-gen': {
      prompt: 'Create a simple Excel spreadsheet with one sheet called "Sales Data" with columns: Month, Revenue, Expenses. Add 3 rows of sample data.',
      ext: 'xlsx',
    },
    'pptx-gen': {
      prompt: 'Create a simple PowerPoint presentation with 3 slides: a title slide with "Quarterly Review", a content slide about "Q1 Results" with 3 bullet points, and a closing slide with "Thank You".',
      ext: 'pptx',
    },
    'pdf-gen': {
      prompt: 'Create a simple PDF document with the title "Meeting Notes" and two sections: "Agenda" with text "Review project status" and "Action Items" with text "Complete testing by Friday".',
      ext: 'pdf',
    },
  };

  const toRun = target === 'all' ? Object.keys(tests) : [target];

  for (const skillId of toRun) {
    if (!tests[skillId]) {
      console.error(`Unknown skill: ${skillId}`);
      continue;
    }
    await testFileGen(skillId, tests[skillId].prompt, tests[skillId].ext);
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
