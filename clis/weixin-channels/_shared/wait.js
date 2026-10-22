import { TimeoutError } from '@sovovs/bycli/errors';
import { log } from '@sovovs/bycli/logger';

// One deadline for the whole browser operation. Stage transitions do not renew
// it. Only previously unseen business observations count as progress; polling,
// timestamps and repeating A/B states are not progress. Only the total deadline
// stops polling: the platform may legitimately process without visible updates.
export function publishWait(timeout, { onUpdate = async () => {}, heartbeat = false } = {}) {
  const started = Date.now(), deadline = started + timeout * 1000;
  let snapshot, reportedAt = started;
  // Browser RPCs can themselves be slow. Report the last known observation
  // during those waits without issuing parallel browser calls or replaying a
  // write. Their cancellation remains owned by the bridge/outer command budget.
  const timer = heartbeat ? setInterval(() => {
    if (!snapshot || snapshot.status !== 'waiting' || Date.now() - reportedAt < 15000) return;
    reportedAt = Date.now();
    log.info(`Weixin Channels progress: ${JSON.stringify({ ...snapshot,
      elapsed_seconds: Math.floor((reportedAt - started) / 1000),
      idle_seconds: Math.floor((reportedAt - Date.parse(snapshot.last_progress_at)) / 1000) })}`);
  }, 1000) : null;
  timer?.unref?.();
  const assertRemaining = () => {
    if (Date.now() >= deadline) throw new TimeoutError('Weixin Channels operation', timeout,
      `stage=${snapshot?.stage || 'starting'}; total budget exhausted; retain the editor and original operation, do not repeat writes`);
  };
  return {
    deadline, assertRemaining,
    close() { if (timer) clearInterval(timer); },
    get snapshot() { return snapshot; },
    async finish() {
      if (snapshot) { snapshot = { ...snapshot, status: 'completed' }; await onUpdate(snapshot); }
    },
    async stage(name) {
      assertRemaining();
      const seen = new Set();
      let progressed = Date.now(), nextReport = progressed;
      const observe = async (observation = {}, progress = observation) => {
        assertRemaining();
        const now = Date.now(), signature = JSON.stringify(progress);
        if (!seen.has(signature)) { seen.add(signature); progressed = now; }
        snapshot = { stage: name, status: 'waiting', elapsed_seconds: Math.floor((now - started) / 1000),
          idle_seconds: Math.floor((now - progressed) / 1000), timeout_seconds: timeout,
          last_progress_at: new Date(progressed).toISOString(), observation };
        if (now >= nextReport) {
          reportedAt = now;
          await onUpdate(snapshot);
          log.info(`Weixin Channels progress: ${JSON.stringify(snapshot)}`);
          nextReport = now + 15000;
        }
      };
      // Persist the stage before entering a potentially slow browser RPC.
      await observe({ state: 'starting' });
      return { observe };
    },
  };
}

// Keep descriptions, filenames, DOM text, signed URLs and tokens out of logs.
export function videoObservation(state) {
  return { ready: state.ready === true, ai_selected: state.ai_selected === true,
    cover_pending: state.cover_pending === true, editors_count: state.editors_count ?? 0,
    processing: state.processing ?? null, progress_percent: state.progress_percent ?? null,
    video_ready_state: Math.max(0, ...(state.videos ?? []).map(v => v.ready_state ?? 0)) };
}
