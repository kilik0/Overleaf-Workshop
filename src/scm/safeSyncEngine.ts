import { createHash } from 'crypto';

export const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
export type SyncPhase = 'pending' | 'verifying' | 'conflict' | 'error';
export interface PendingFile {
    target: string;
    expected: string | null;
    observed?: string | null;
    phase: SyncPhase;
    error?: string;
    attempts: number;
}
export interface SyncJournal {
    version: 1;
    project: string;
    verified: Record<string, string>;
    pending: Record<string, PendingFile>;
}
export interface SyncStorage {
    readLocal(path: string): Promise<Uint8Array | undefined>;
    readRemote(path: string): Promise<Uint8Array | undefined>;
    writeRemote(path: string, data: Uint8Array, expected: string | null): Promise<void>;
    saveBlob(hash: string, data: Uint8Array): Promise<void>;
    loadBlob(hash: string): Promise<Uint8Array>;
    saveJournal(journal: SyncJournal): Promise<void>;
    report(path: string, phase: SyncPhase | 'verified', detail: string): void;
    ignored(path: string): boolean;
}

/** Local-first synchronization. Deliberately has NO operation that writes/deletes local source files.
 * Acknowledgements are not proof: only an uncached server read can advance the verified baseline.
 */
export class SafeSyncEngine {
    private chain: Promise<void> = Promise.resolve();
    private closed = false;
    constructor(public readonly journal: SyncJournal, private readonly io: SyncStorage) {}
    stop(): void { this.closed = true; }
    drain(): Promise<void> { return this.chain; }
    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.chain.then(operation);
        this.chain = next.then(() => undefined, () => undefined);
        return next;
    }
    private persist(): Promise<void> { return this.io.saveJournal(this.journal); }
    private async stage(path: string, local: Uint8Array, expected: string | null, phase: SyncPhase): Promise<void> {
        const hash = digest(local);
        // Persist actual content BEFORE recording an intent or making a network request.
        await this.io.saveBlob(hash, local);
        this.journal.pending[path] = {target: hash, expected, phase, attempts: 0};
        await this.persist();
    }
    private async remoteHash(path: string): Promise<string | null> {
        const remote = await this.io.readRemote(path);
        if (remote === undefined) { return null; }
        const hash = digest(remote);
        await this.io.saveBlob(hash, remote);
        return hash;
    }
    private async complete(path: string, hash: string): Promise<void> {
        const previous = this.journal.verified[path];
        const pending = this.journal.pending[path];
        this.journal.verified[path] = hash;
        delete this.journal.pending[path];
        try { await this.persist(); }
        catch (error) {
            if (previous === undefined) { delete this.journal.verified[path]; }
            else { this.journal.verified[path] = previous; }
            if (pending) { this.journal.pending[path] = pending; }
            throw error;
        }
        this.io.report(path, 'verified', hash);
    }
    private async block(path: string, entry: PendingFile, message: string): Promise<void> {
        entry.phase = 'conflict'; entry.error = message;
        await this.persist();
        this.io.report(path, 'conflict', message);
    }
    /** Called on startup, explicit save, local watcher change or a remote notification. */
    reconcile(path: string): Promise<void> { return this.serial(() => this.run(path)); }
    private async run(path: string): Promise<void> {
        if (this.closed || this.io.ignored(path)) { return; }
        let entry = this.journal.pending[path];
        try {
            const local = await this.io.readLocal(path);
            if (local === undefined) {
                // No automatic deletion in either direction. Never resurrect a deleted local file.
                if (!entry && !this.journal.verified[path]) {
                    const remote = await this.remoteHash(path);
                    if (remote === null) { return; }
                    entry = {target: remote, expected: remote, phase: 'conflict', attempts: 0};
                    this.journal.pending[path] = entry;
                }
                if (entry || this.journal.verified[path]) {
                    if (!entry) {
                        entry = {target: this.journal.verified[path], expected: this.journal.verified[path], phase: 'conflict', attempts: 0};
                        this.journal.pending[path] = entry;
                    }
                    await this.block(path, entry, 'Local file is missing. Remote deletion requires manual review.');
                }
                return;
            }
            const target = digest(local);
            const baseline = this.journal.verified[path];
            // Also snapshot clean local data. Network failure must never lose the saved revision.
            await this.io.saveBlob(target, local);
            if (!entry || entry.target !== target) {
                await this.stage(path, local, baseline ?? null, 'pending');
                entry = this.journal.pending[path];
            }
            const remote = await this.remoteHash(path);
            entry.observed = remote;
            if (remote === target) { await this.complete(path, target); return; }
            if (entry.phase === 'conflict') {
                this.io.report(path, 'conflict', entry.error || 'Review required.');
                return;
            }
            if (remote !== entry.expected) {
                await this.block(path, entry, baseline === undefined
                    ? 'First connection: local and remote differ. Both versions preserved; choose Publish Local after review.'
                    : 'Remote changed since last verified upload. Local file was preserved; review before publishing.');
                return;
            }
            if (this.closed) { return; }
            // Re-check disk after the server read. A newer save must not be replaced by an older intent.
            const latest = await this.io.readLocal(path);
            if (!latest || digest(latest) !== target) { return; }
            entry.attempts++; entry.phase = 'verifying'; delete entry.error;
            await this.persist();
            this.io.report(path, 'verifying', 'Uploading; waiting for independent server verification.');
            await this.io.writeRemote(path, local, remote);
            const confirmed = await this.remoteHash(path);
            if (confirmed !== target) {
                throw new Error('Server verification mismatch. Upload is NOT confirmed; local content is preserved.');
            }
            await this.complete(path, target);
            // A save may have arrived while the upload was in progress. Leave its content durably queued.
            const after = await this.io.readLocal(path);
            if (after && digest(after) !== target) {
                await this.stage(path, after, target, 'pending');
                this.io.report(path, 'pending', 'A newer local revision is waiting to upload.');
            }
        } catch (error) {
            const current = this.journal.pending[path];
            let detail = String(error);
            if (current) {
                current.phase = 'error'; current.error = detail;
                try { await this.persist(); } catch (diskError) { detail += `; journal write failed: ${String(diskError)}`; }
            }
            this.io.report(path, 'error', detail);
        }
    }
    /** Explicit one-file download only. Snapshot both versions and serialize against all uploads. */
    acceptRemote(path: string, replace: (data: Uint8Array, expectedLocal: string | null) => Promise<void>): Promise<void> {
        return this.serial(async () => {
            if (this.closed || this.io.ignored(path)) { throw new Error('Sync stopped or path ignored.'); }
            const local = await this.io.readLocal(path);
            const expected = local === undefined ? null : digest(local);
            if (local !== undefined) { await this.io.saveBlob(expected!, local); }
            const remote = await this.io.readRemote(path);
            if (remote === undefined) { throw new Error('Cloud file is absent; accepting cloud never deletes local files.'); }
            const hash = digest(remote); await this.io.saveBlob(hash,remote);
            if (await this.remoteHash(path) !== hash) { throw new Error('Cloud changed during review; retry Accept Cloud.'); }
            const latest = await this.io.readLocal(path);
            if ((latest === undefined ? null : digest(latest)) !== expected) { throw new Error('Local file changed; refusing to replace newer content.'); }
            // Persist identifiable recovery information BEFORE the destructive user-authorized action.
            this.journal.pending[path] = {target: expected ?? hash, expected: hash, observed: hash, phase:'conflict', attempts:0, error:'Accept Cloud requested; local/cloud backups saved.'};
            await this.persist();
            await replace(remote,expected);
            const actual = await this.io.readLocal(path);
            if (actual === undefined || digest(actual) !== hash) { throw new Error('Accepted cloud file did not match; review required.'); }
            await this.complete(path,hash);
        });
    }
    /** Only after an explicit UI confirmation. Save cloud content before granting one overwrite. */
    authorizeLocal(path: string): Promise<void> {
        return this.serial(async () => {
            if (this.closed || this.io.ignored(path)) { return; }
            const local = await this.io.readLocal(path);
            if (!local) { throw new Error('Local file is missing; refusing to delete remote content.'); }
            const remote = await this.remoteHash(path);
            await this.stage(path, local, remote, 'pending');
        }).then(() => this.reconcile(path));
    }
}
