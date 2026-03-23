import type { ParsedTask, ParsedPipeline } from '../types.js';

/**
 * Parse [TASK:skillId]...[/TASK] blocks from Router Agent output.
 */
export function parseTaskBlocks(text: string): {
  cleanText: string;
  tasks: ParsedTask[];
} {
  const tasks: ParsedTask[] = [];
  const taskRegex = /\[TASK:(\w[\w-]*)\]\s*([\s\S]*?)\s*\[\/TASK\]/g;

  let match;
  while ((match = taskRegex.exec(text)) !== null) {
    tasks.push({
      skillId: match[1],
      description: match[2].trim(),
    });
  }

  // Remove task blocks from text to get clean response
  const cleanText = text
    .replace(/\[TASK:\w[\w-]*\]\s*[\s\S]*?\s*\[\/TASK\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleanText, tasks };
}

/**
 * Parse [PIPELINE]...[/PIPELINE] blocks (may contain parallel flag).
 * Also collects bare [TASK] blocks outside any pipeline.
 */
export function parsePipelineBlocks(text: string): {
  cleanText: string;
  pipelines: ParsedPipeline[];
  bareTasks: ParsedTask[];
} {
  const pipelines: ParsedPipeline[] = [];

  // Match [PIPELINE] or [PIPELINE parallel] blocks
  const pipelineRegex = /\[PIPELINE(\s+parallel)?\]\s*([\s\S]*?)\s*\[\/PIPELINE\]/g;

  // Track which portions of text are inside pipelines
  const pipelineRanges: Array<[number, number]> = [];

  let match;
  while ((match = pipelineRegex.exec(text)) !== null) {
    const parallel = !!match[1];
    const inner = match[2];
    pipelineRanges.push([match.index, match.index + match[0].length]);

    // Parse tasks within this pipeline
    const { tasks } = parseTaskBlocks(inner);
    if (tasks.length > 0) {
      pipelines.push({ tasks, parallel });
    }
  }

  // Find bare tasks (outside any pipeline)
  let textWithoutPipelines = text;
  // Remove pipeline blocks from text (iterate in reverse to keep indices valid)
  for (let i = pipelineRanges.length - 1; i >= 0; i--) {
    const [start, end] = pipelineRanges[i];
    textWithoutPipelines =
      textWithoutPipelines.substring(0, start) +
      textWithoutPipelines.substring(end);
  }

  const { tasks: bareTasks } = parseTaskBlocks(textWithoutPipelines);

  // Clean text: remove all pipelines and bare tasks
  const cleanText = text
    .replace(/\[PIPELINE(\s+parallel)?\]\s*[\s\S]*?\s*\[\/PIPELINE\]/g, '')
    .replace(/\[TASK:\w[\w-]*\]\s*[\s\S]*?\s*\[\/TASK\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleanText, pipelines, bareTasks };
}

/**
 * Truncate a result string for feeding back to the Router Agent.
 * Keeps head and tail to preserve context without exceeding limits.
 */
export function truncateResultForRouter(result: string, maxChars = 1500): string {
  // If result contains code blocks (charts/diagrams), use a larger limit to preserve them
  if (/```(?:chart|mermaid|mindmap)\b/.test(result)) {
    maxChars = Math.max(maxChars, 4000);
  }
  if (result.length <= maxChars) return result;

  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.25);

  return (
    result.slice(0, headSize) +
    '\n\n...(truncated)...\n\n' +
    result.slice(-tailSize)
  );
}
