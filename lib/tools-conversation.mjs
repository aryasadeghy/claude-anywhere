// Claude-facing tools this package adds: a recap with next-step buttons once a turn is done, a
// chapter marker ("Session chapters" in Desktop's own words), a "Suggested task" card, and a
// session-status badge for the sidebar. One pack, per the TOOL_PACKS convention in lib/runs.mjs.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readConvSettings, writeConvSettings } from './conv-settings.mjs';

export default function conversationTools(run) {
  const tools = [];
  // Desktop's own switch, on by default: a person who does not want Claude narrating its own
  // wrap-up just turns the tool off, same as autoClassify below - it is never offered, not
  // merely hidden, so a model cannot call it and get silently ignored.
  if (readConvSettings().showRecap !== false) tools.push(tool(
      'SuggestNextSteps',
      'After finishing a turn, offer the user a short summary and buttons for what to do next - optionally with a question. Each button sends its prompt as the next message when pressed. Use it when there are clear follow-up actions a person might want.',
      {
        // `recap` is the original field name, kept working for anything already calling it;
        // `summary` is Desktop's own word for the same sentence and is tried first when both
        // somehow arrive. `question` is new: a single line asked straight after the summary.
        recap: z.string().optional().describe('One or two sentences on what just happened'),
        summary: z.string().optional().describe('One or two sentences on what just happened (preferred name for `recap`)'),
        question: z.string().optional().describe('A short follow-up question to ask, shown under the summary'),
        steps: z.array(z.object({
          label: z.string().describe('Short button text, e.g. "Add tests"'),
          prompt: z.string().describe('What to send to Claude if this button is pressed'),
        })).min(1).max(5),
      },
      // The result says what is due next, as Desktop's wrap_up does (lib/app-prompt.mjs relies on it):
      // a question in the box ends the turn; without one, the full answer still has to be written.
      async ({ recap, summary, question, steps }) => ({ content: [{ type: 'text', text: `Shown to the user: ${steps.length} next step${steps.length === 1 ? '' : 's'}${(summary || recap) ? ' with a summary' : ''}${question ? ' and a question' : ''}.` + (question ? ' The box shows your question and ends your turn: write no text after this call.' : ' Now write your closing message: your answer to the user in full, which the summary does not replace.') }] }),
    ));
  tools.push(
    tool(
      'MarkChapter',
      'Mark this point in the conversation as the start of a new chapter, so the person can jump back to it from the session\'s Chapters menu. Use it when the work moves on to a clearly different part of the task.',
      { title: z.string().min(1).max(80).describe('Short chapter title, e.g. "Set up the database"') },
      async ({ title }) => ({ content: [{ type: 'text', text: `Marked chapter: "${title}".` }] }),
    ),
    tool(
      'SuggestTask',
      'Offer a follow-up task as its own card: a button to start it in a new session and one to do it right here. Use it for substantial, separable work the user has not asked for yet.',
      { title: z.string().min(1).max(120).describe('Short task title'), prompt: z.string().min(1).describe('The prompt that starts the task') },
      async ({ title }) => ({ content: [{ type: 'text', text: `Suggested task: ${title}.` }] }),
    ),
  );
  const allow = ['SuggestNextSteps', 'MarkChapter', 'SuggestTask'];
  // Desktop's own switch, off by default: a status Claude sets about the person's work is still
  // Claude deciding something, not merely answering - so this tool exists only once asked for.
  if (readConvSettings().autoClassify) {
    tools.push(tool(
      'SetSessionStatus',
      'Mark this session as blocked (needs something from the user before it can go on), ready_for_review (the work is done and wants a look) or done. Shown as a badge on the session in the sidebar.',
      { status: z.enum(['blocked', 'ready_for_review', 'done']), note: z.string().max(200).optional().describe('A short reason, shown with the badge') },
      async ({ status, note }) => {
        const s = readConvSettings();
        if (run.sessionId) { s.status[run.sessionId] = { status, note: note || '', at: Date.now() }; writeConvSettings(s); }
        run.push({ t: 'session_status', status, note: note || '' });
        return { content: [{ type: 'text', text: `Session marked ${status.replace(/_/g, ' ')}.` }] };
      },
    ));
    allow.push('SetSessionStatus');
  }
  return { tools, allow };
}
