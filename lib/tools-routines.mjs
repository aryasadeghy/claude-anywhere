// Claude-facing tools for scheduled tasks (Desktop calls them routines; its own tool names,
// mcp__scheduled-tasks__* there, are kept here too so a prompt that already knows them from
// Desktop still works). Creating, updating and deleting go through the normal permission prompt
// like any other tool; listing does not - per the task, reading the schedule back is not a
// decision worth interrupting a turn for.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import * as routines from './routines.mjs';

// Mirrors lib/runs.mjs's PERMISSION_MODES. Not imported from there: runs.mjs is what builds
// this pack (TOOL_PACKS), so importing back from it would make a cycle for no gain - the two
// lists already have to change together, same as toolsTerminal's permission strings do.
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];

const scheduleShape = z.object({
  type: z.enum(['hourly', 'daily', 'weekdays', 'weekly', 'custom']),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM, 24-hour, local time - for daily/weekdays/weekly'),
  day: z.number().min(0).max(6).optional().describe('0=Sunday..6=Saturday - for weekly'),
  cron: z.string().optional().describe('5-field cron expression - for custom'),
});

function present(routine) {
  return {
    id: routine.id, name: routine.name, prompt: routine.prompt, folder: routine.folder,
    model: routine.model, permissionMode: routine.permissionMode, enabled: routine.enabled,
    schedule: routines.describe(routine), cron: routine.schedule.cron,
    nextRunAt: routine.nextRunAt, lastRunAt: routine.lastRunAt, lastRunStatus: routine.lastRunStatus,
  };
}

export default function routinesTools(run) {
  const tools = [
    tool(
      'create_scheduled_task', 'Create a scheduled task (a routine) that runs Claude Code on its own schedule, on this computer. Each run is a fresh session, visible in the sidebar tagged with the routine that started it.',
      {
        name: z.string().min(1).max(80),
        prompt: z.string().min(1).describe('What to send Claude on each run'),
        folder: z.string().min(1).optional().describe('Folder to run in - defaults to this session\'s folder'),
        model: z.string().optional(),
        permissionMode: z.enum(PERMISSION_MODES).optional(),
        schedule: scheduleShape,
      },
      async ({ name, prompt, folder, model, permissionMode, schedule }) => {
        const dir = folder || run.cwd;
        if (!dir || !fs.existsSync(dir)) return { content: [{ type: 'text', text: `That folder does not exist on this machine: ${dir}` }], isError: true };
        try {
          const row = routines.create({ name, prompt, folder: dir, model, permissionMode, schedule });
          run.push({ t: 'routines_changed' });
          return { content: [{ type: 'text', text: `Created scheduled task "${row.name}" (${routines.describe(row)}).` }] };
        } catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'list_scheduled_tasks', 'List every scheduled task on this computer, with its schedule and when it last/next runs.',
      {},
      async () => ({ content: [{ type: 'text', text: JSON.stringify(routines.list().map(present)) }] }),
    ),
    tool(
      'update_scheduled_task', 'Change a scheduled task\'s name, prompt, folder, model, permission mode, schedule, or on/off switch.',
      {
        id: z.string(), name: z.string().optional(), prompt: z.string().optional(), folder: z.string().optional(),
        model: z.string().optional(), permissionMode: z.enum(PERMISSION_MODES).optional(),
        schedule: scheduleShape.optional(), enabled: z.boolean().optional(),
      },
      async ({ id, ...patch }) => {
        try {
          const row = routines.update(id, patch);
          if (!row) return { content: [{ type: 'text', text: `No scheduled task with id ${id}.` }], isError: true };
          run.push({ t: 'routines_changed' });
          return { content: [{ type: 'text', text: `Updated scheduled task "${row.name}".` }] };
        } catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      },
    ),
    tool(
      'delete_scheduled_task', 'Delete a scheduled task. Its past runs stay in the sidebar as ordinary sessions.',
      { id: z.string() },
      async ({ id }) => {
        const had = routines.remove(id);
        run.push({ t: 'routines_changed' });
        return { content: [{ type: 'text', text: had ? 'Deleted.' : `No scheduled task with id ${id}.` }], isError: !had };
      },
    ),
    tool(
      'run_scheduled_task', 'Run a scheduled task right now, out of its normal schedule, in a new session.',
      { id: z.string() },
      async ({ id }) => {
        const row = await routines.runNow(id);
        if (!row) return { content: [{ type: 'text', text: `No scheduled task with id ${id}.` }], isError: true };
        run.push({ t: 'routines_changed' });
        const last = row.runs[0];
        return { content: [{ type: 'text', text: last?.sessionId ? `Started as session ${last.sessionId}.` : 'Could not start a run.' }], isError: !last?.sessionId };
      },
    ),
    tool(
      'list_task_runs', 'List the run history of one scheduled task: when each run started, which session it opened, and how it ended.',
      { id: z.string() },
      async ({ id }) => {
        const row = routines.get(id);
        if (!row) return { content: [{ type: 'text', text: `No scheduled task with id ${id}.` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(row.runs) }] };
      },
    ),
  ];
  return { tools, allow: ['list_scheduled_tasks', 'list_task_runs'] };
}
