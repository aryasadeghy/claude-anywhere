// Claude's own terminal tools. The tab a command runs in is the same one the person's
// Terminal pane shows - nothing here is a hidden shell, which is the whole point of asking
// before run_in_terminal runs anything: the person sees exactly what ran and can take the
// tab over, the way Desktop's own terminal tools work.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as terminal from './terminal.mjs';

export default function (run) {
  return {
    // open_terminal_tab only opens a tab (nothing runs by itself) and read_terminal only
    // reads what is already there - neither needs asking. run_in_terminal runs a command,
    // which is the same risk as Bash, so it stays off the allow list.
    allow: ['open_terminal_tab', 'read_terminal'],
    tools: [
      tool(
        'open_terminal_tab',
        "Open a new tab in the terminal pane, in a given folder (the session's own folder by default). The person sees it appear; nothing runs in it yet.",
        { cwd: z.string().optional().describe('Absolute path to open the tab in; defaults to the session\'s folder') },
        async ({ cwd }) => {
          if (!run.sessionId) return { content: [{ type: 'text', text: 'No session yet.' }], isError: true };
          const tab = await terminal.createTab(run.sessionId, { cwd: cwd || run.cwd });
          run.push({ t: 'terminal_tab', tab });
          return { content: [{ type: 'text', text: `Opened terminal tab "${tab.title}" (id ${tab.id}) in ${tab.cwd}.` }] };
        },
      ),
      tool(
        'run_in_terminal',
        'Run a shell command in a terminal tab the person can see and read its output back. Prefer this over Bash when the person is likely to want to watch, continue, or take over the command themselves (a dev server, something long and interactive); otherwise use Bash. Asks the person first.',
        {
          command: z.string().describe('The command to run'),
          tabId: z.string().optional().describe('An existing open tab to run it in; a new tab opens otherwise'),
          cwd: z.string().optional().describe('Folder for a new tab; ignored when tabId is given'),
          timeoutMs: z.number().optional().describe('How long to wait before returning partial output - the command keeps running either way; default 120000 (2 minutes)'),
        },
        async ({ command, tabId, cwd, timeoutMs }) => {
          if (!run.sessionId) return { content: [{ type: 'text', text: 'No session yet.' }], isError: true };
          let tab = tabId ? terminal.getTab(run.sessionId, tabId) : null;
          if (!tab || !tab.alive) {
            const info = await terminal.createTab(run.sessionId, { cwd: cwd || run.cwd, title: command.slice(0, 40) });
            tab = terminal.getTab(run.sessionId, info.id);
            run.push({ t: 'terminal_tab', tab: info });
          } else {
            run.push({ t: 'terminal_focus', tabId: tab.id });
          }
          const r = await terminal.runCommand(tab, command, { timeoutMs });
          if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
          const note = r.timedOut
            ? `\n(still running after ${Math.round((timeoutMs || 120000) / 1000)}s - this is the output so far; read_terminal can check on it)`
            : r.exitCode ? `\n(exit code ${r.exitCode})` : '';
          return { content: [{ type: 'text', text: (r.output || '(no output)') + note }] };
        },
      ),
      tool(
        'read_terminal',
        "Read a terminal tab's recent output without running anything in it.",
        { tabId: z.string().describe('The tab to read, by id (see open_terminal_tab or the tab the person has open)') },
        async ({ tabId }) => {
          if (!run.sessionId) return { content: [{ type: 'text', text: 'No session yet.' }], isError: true };
          const tab = terminal.getTab(run.sessionId, tabId);
          if (!tab) return { content: [{ type: 'text', text: 'No such terminal tab.' }], isError: true };
          const state = tab.alive ? (tab.running ? 'running' : 'idle') : tab.crashed ? 'exited (crashed or was killed)' : 'exited';
          return { content: [{ type: 'text', text: `[${tab.title} · ${state}]\n` + (terminal.readBuffer(tab) || '(no output yet)') }] };
        },
      ),
    ],
  };
}
