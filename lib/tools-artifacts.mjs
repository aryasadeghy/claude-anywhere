// Claude's artifact tools: make a page, diagram or document the person sees working beside the
// chat, instead of writing an HTML file and a screenshot of it. Storage is lib/artifacts.mjs.
// They only write inside the app's own data dir, so none of them asks.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as artifacts from './artifacts.mjs';

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const line = (m) => `"${m.title}" (id ${m.id}, ${m.type}, version ${m.version})`;

export default function artifactTools(run) {
  const guard = (fn) => async (args) => {
    if (!run.sessionId) return text('The session has no id yet; try again.', true);
    try { return await fn(args); } catch (e) { return text(e.message, true); }
  };
  const announce = (kind, m) => run.push({ t: 'artifact', kind, sessionId: run.sessionId, artifact: m });
  return {
    allow: ['create_artifact', 'update_artifact', 'list_artifacts'],
    tools: [
      tool(
        'create_artifact',
        'Show the person something they should see working: a web page or app, a design, a diagram, a document or a piece of code. It opens in a panel beside the chat, they can switch between versions, download it and share a link. Use it instead of writing an HTML file and sending a screenshot of it. Types: html (one self-contained page, inline CSS and JS), react (one component, `export default function App()`, React 18 and hooks, no other packages), svg, markdown, mermaid (diagram source) and code (shown as text). Change it later with update_artifact rather than creating a second one.',
        {
          title: z.string().min(1).max(120).describe('Short title shown in the panel, e.g. "Pricing page"'),
          type: z.enum(artifacts.TYPES).describe('html | react | svg | markdown | mermaid | code'),
          content: z.string().min(1).describe('The whole artifact: the page source, the component, the svg, the markdown or the diagram'),
          id: z.string().max(60).optional().describe('Short lowercase name to refer to it later, e.g. "pricing-page"; made from the title when left out'),
        },
        guard(async (a) => {
          const m = artifacts.create(run.sessionId, a);
          announce('created', m);
          return text(`Created artifact ${line(m)}. The person can see it in the Artifacts panel. Change it with update_artifact.`);
        }),
      ),
      tool(
        'update_artifact',
        'Change an artifact you made earlier. Every version is kept. Either send the whole new content, or one find/replace edit (find must match exactly once unless all is true) - prefer the edit for small changes.',
        {
          id: z.string().min(1).describe('The artifact id from create_artifact or list_artifacts'),
          content: z.string().optional().describe('The whole new content'),
          find: z.string().optional().describe('Exact text to replace in the current version'),
          replace: z.string().optional().describe('What to put in its place (empty to delete it)'),
          all: z.boolean().optional().describe('Replace every match of find'),
          title: z.string().max(120).optional().describe('A new title'),
          note: z.string().max(200).optional().describe('One line about what changed, shown in the version list'),
        },
        guard(async (a) => {
          const m = artifacts.update(run.sessionId, a.id, a);
          announce('updated', m);
          return text(`Updated artifact ${line(m)}.`);
        }),
      ),
      tool(
        'list_artifacts',
        'List the artifacts made in this session, newest first.',
        {},
        guard(async () => {
          const l = artifacts.list(run.sessionId);
          return text(l.length ? l.map((m) => '- ' + line(m)).join('\n') : 'No artifacts in this session yet.');
        }),
      ),
    ],
  };
}
