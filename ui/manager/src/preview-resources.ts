import type { MediaResource, ThemeRef } from "../../../contracts/manager.mjs";
import type { ManagerClient } from "./client";

export type PreviewTarget = { kind: "theme"; theme: ThemeRef; revision: string; variant: "thumbnail" | "preview" } |
  { kind: "active"; revision: string } |
  { kind: "source" | "package"; handle: string };
export const previewKey = (target: PreviewTarget) => JSON.stringify(target);
interface Subscriber { resolve(value: MediaResource): void; reject(error: Error): void; detach(): void }
interface Job { target: PreviewTarget; key: string; foreground: boolean; started: boolean; subscribers: Set<Subscriber> }
interface Queue { thumbnails: number; foreground: number; jobs: Map<string, Job>; waiting: Job[] }
const queues = new WeakMap<ManagerClient, Queue>();

function request(client: ManagerClient, target: PreviewTarget): Promise<MediaResource> {
  if (target.kind === "active") return client.call("media.activePreview", { revision: target.revision });
  if (target.kind === "theme") return client.call("media.resolve", { theme: target.theme, revision: target.revision, variant: target.variant });
  return target.kind === "source" ? client.call("sources.preview", { handle: target.handle }) : client.call("packages.preview", { handle: target.handle });
}
function pump(client: ManagerClient, queue: Queue) {
  for (;;) {
    // Reserve a foreground slot for the selected theme/source. Two background
    // thumbnails must not prevent a user-requested preview from being sent.
    const index = queue.waiting.findIndex(job => job.foreground ? queue.foreground < 1 : queue.thumbnails < 2);
    if (index < 0) return;
    const job = queue.waiting.splice(index, 1)[0]!;
    if (!job.subscribers.size) { queue.jobs.delete(job.key); continue; }
    job.started = true;
    if (job.foreground) queue.foreground++; else queue.thumbnails++;
    void request(client, job.target).then(value => {
      for (const subscriber of job.subscribers) subscriber.resolve(value);
    }, error => {
      for (const subscriber of job.subscribers) subscriber.reject(error instanceof Error ? error : new Error("预览未完成。"));
    }).finally(() => {
      for (const subscriber of job.subscribers) subscriber.detach();
      queue.jobs.delete(job.key);
      if (job.foreground) queue.foreground--; else queue.thumbnails--;
      pump(client, queue);
    });
  }
}

// Cancels queued reads and subscribers, never a backend transaction or writer.
export function resolvePreview(client: ManagerClient, target: PreviewTarget, signal: AbortSignal): Promise<MediaResource> {
  if (signal.aborted) return Promise.reject(new DOMException("Preview hidden", "AbortError"));
  let queue = queues.get(client);
  if (!queue) { queue = { thumbnails: 0, foreground: 0, jobs: new Map(), waiting: [] }; queues.set(client, queue); }
  const owner = queue, key = previewKey(target);
  let job = owner.jobs.get(key);
  if (!job) {
    // All mounted library cards enqueue immediately. Bound active native reads
    // in pump(), while retaining the remaining cards until their turn arrives.
    const foreground = target.kind !== "theme" || target.variant !== "thumbnail";
    job = { target, key, foreground, started: false, subscribers: new Set() }; owner.jobs.set(key, job);
    // Detail/source previews precede thumbnails without interrupting existing reads.
    if (foreground) owner.waiting.unshift(job); else owner.waiting.push(job);
  }
  const current = job;
  return new Promise((resolve, reject) => {
    const subscriber: Subscriber = { resolve, reject, detach: () => signal.removeEventListener("abort", cancel) };
    function cancel() {
      current.subscribers.delete(subscriber); subscriber.detach(); reject(new DOMException("Preview hidden", "AbortError"));
      if (!current.started && !current.subscribers.size) {
        owner.jobs.delete(key); owner.waiting = owner.waiting.filter(value => value !== current);
      }
    }
    current.subscribers.add(subscriber); signal.addEventListener("abort", cancel, { once: true }); pump(client, owner);
  });
}
