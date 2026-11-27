// How a call to Claude in Chrome's tools reads in the transcript, in Desktop's words ("Claude wants to
// open a page in Chrome on your computer" becomes "Opened <site>"). A file of its own, not a part of
// app.js, so a test can load it without a page; the page gets it as window.chromeLabel.
(function (root) {
  const site = (u) => { try { return new URL(/^[a-z]+:/i.test(u) ? u : 'https://' + u).host || String(u); } catch { return String(u || ''); } };
  // -> [verb, argument] for the step's line, or null for a name that is not one of the extension's tools.
  function chromeLabel(name, input) {
    const m = /^mcp__claude-in-chrome__(.+)$/.exec(name || '');
    if (!m) return null;
    const i = input && typeof input === 'object' ? input : {};
    switch (m[1]) {
      case 'navigate': return i.url === 'back' || i.url === 'forward' ? ['Went ' + i.url + ' in Chrome', ''] : ['Opened', site(i.url)];
      case 'computer': {
        const a = String(i.action || '');
        if (a === 'screenshot' || a === 'zoom') return ['Took a screenshot of the page', ''];
        if (/click/.test(a)) return ['Clicked in Chrome', ''];
        if (a === 'type') return ['Typed in Chrome', ''];
        if (a === 'key') return ['Pressed', String(i.text || '')];
        if (a === 'scroll' || a === 'scroll_to') return ['Scrolled the page', ''];
        if (a === 'wait') return ['Waited', ''];
        return ['Used Chrome', a];
      }
      case 'read_page': case 'get_page_text': return ['Read the page', ''];
      case 'find': return ['Looked for', String(i.query || '').slice(0, 120)];
      case 'form_input': return ['Filled in a field', ''];
      case 'javascript_tool': return ['Ran a script on the page', ''];
      case 'read_console_messages': return ['Read the console', ''];
      case 'read_network_requests': return ['Read the network requests', ''];
      case 'tabs_context_mcp': return ['Looked at your tabs', ''];
      case 'tabs_create_mcp': return ['Opened a new tab', ''];
      case 'tabs_close_mcp': return ['Closed a tab', ''];
      case 'resize_window': return ['Resized the window', ''];
      case 'gif_creator': return ['Recorded the page', ''];
      case 'upload_image': case 'file_upload': return ['Uploaded a file to the page', ''];
      case 'shortcuts_list': return ['Looked at your shortcuts', ''];
      case 'shortcuts_execute': return ['Ran a shortcut in Chrome', ''];
      case 'browser_batch': return ['Did several things in Chrome', ''];
      case 'update_plan': return ['Shared its plan for Chrome', ''];
      default: return ['Used Chrome', m[1].replace(/_/g, ' ')];
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { chromeLabel };
  else root.chromeLabel = chromeLabel;
})(typeof window !== 'undefined' ? window : globalThis);
