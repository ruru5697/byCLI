import { Page } from '@sovovs/bycli/browser/page';
import { ArgumentError } from '@sovovs/bycli/errors';
import { resolve } from 'node:path';
import { readOperation, reopensSavedDraft } from './publish.js';

// Reuse an explicitly bound browser lease after restart. Supplying a target ID
// on the adapter lease alone cannot adopt a tab from another session.
export async function editorSessionPage(page, args, inspectOnly = false) {
  const op = await readOperation(resolve(args.operation));
  if (!inspectOnly && (reopensSavedDraft(op, args.mode) || args['reopen-saved-draft'] === true)) return page;
  const session = args['editor-session'] || op?.editor_session;
  if (!session || inspectOnly && !args['inspect-editor']) return page;
  if (!/^[\w-]{1,100}$/.test(session)) throw new ArgumentError('Invalid bound editor session');
  return new Page(session, undefined, page.contextId, undefined, 'browser');
}
