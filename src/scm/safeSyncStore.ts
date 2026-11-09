import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SyncJournal, digest } from './safeSyncEngine';

/** Atomic local journal + content-addressed revisions, shared by all restarts of this replica. */
export class SafeSyncStore {
    private readonly token = randomUUID();
    private locked = false;
    constructor(public readonly root: string, private readonly project: string) {}
    private async processIdentity(pid: number): Promise<string | undefined> {
        if (process.platform !== 'linux') { return undefined; }
        try {
            const [boot, stat] = await Promise.all([
                fs.readFile('/proc/sys/kernel/random/boot_id','utf8'), fs.readFile(`/proc/${pid}/stat`,'utf8'),
            ]);
            return `${boot.trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
            throw error;
        }
    }
    async lock(waitMs = 0, onWait?: (detail: string) => void): Promise<void> {
        if (this.locked) { throw new Error('Sync store lock is already held by this operation.'); }
        await fs.mkdir(this.root, {recursive: true});
        const filename = path.join(this.root, 'lock.json');
        const identity = await this.processIdentity(process.pid);
        const deadline = Date.now() + waitMs;
        let notified = false;
        for (;;) {
            try {
                const handle = await fs.open(filename, 'wx', 0o600);
                try {
                    await handle.writeFile(JSON.stringify({pid: process.pid, token: this.token, identity, scope:'operation', acquiredAt:new Date().toISOString()}));
                    await handle.sync();
                } finally { await handle.close(); }
                this.locked = true; return;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            }
            let text: string;
            try { text = await fs.readFile(filename, 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
            let previous: {pid:number; token:string; identity?:string; scope?:string};
            try { previous = JSON.parse(text); }
            catch { previous = {pid:0,token:''}; }
            let stale = false;
            if (Number.isInteger(previous.pid) && previous.pid > 0 && previous.token) {
                try { process.kill(previous.pid, 0); }
                catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { stale = true; } }
                if (!stale && previous.identity) {
                    const current = await this.processIdentity(previous.pid);
                    if (current !== undefined && current !== previous.identity) { stale = true; }
                }
            }
            if (stale) {
                // Serialize stale-owner cleanup. Without this gate two reconnecting hosts could
                // both inspect the old lock and the slower one could unlink the new owner's lock.
                const gate = path.join(this.root,`lock-recovery-${digest(Buffer.from(text))}`);
                let recovery: fs.FileHandle | undefined;
                try {
                    recovery = await fs.open(gate,'wx',0o600);
                    await recovery.writeFile(JSON.stringify({pid:process.pid,identity}));
                    try { if (await fs.readFile(filename,'utf8') === text) { await fs.unlink(filename); } }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
                    onWait?.(`Recovered stale sync lock for PID ${previous.pid}.`);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
                    if (Date.now() >= deadline) { throw new Error(`Sync lock recovery is unfinished: ${gate}. No active lock was removed.`); }
                    await new Promise(resolve => setTimeout(resolve,100));
                } finally {
                    if (recovery) { await recovery.close(); await fs.unlink(gate); }
                }
                continue;
            }
            const detail = previous.scope === 'operation'
                ? `A sync operation is still in progress (PID ${previous.pid}); waiting for it to finish.`
                : `A legacy sync session may still hold this replica (PID ${previous.pid || 'unknown'}). Reload the old extension session to release it.`;
            if (!notified) { onWait?.(detail); notified = true; }
            if (Date.now() >= deadline) {
                throw new Error(`Sync lock busy: ${detail} No takeover was forced; retry will wait again. Another VS Code window is not necessarily open.`);
            }
            await new Promise(resolve => setTimeout(resolve,100));
        }
    }
    async unlock(): Promise<void> {
        if (!this.locked) { return; }
        const filename = path.join(this.root, 'lock.json');
        try {
            const current = JSON.parse(await fs.readFile(filename, 'utf8'));
            if (current.token === this.token) { await fs.unlink(filename); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        finally { this.locked = false; }
    }
    async withLock<T>(operation: () => Promise<T>, onWait?: (detail: string) => void): Promise<T> {
        await this.lock(15000,onWait);
        try { return await operation(); } finally { await this.unlock(); }
    }
    async load(): Promise<SyncJournal> {
        try {
            const result = JSON.parse(await fs.readFile(path.join(this.root, 'journal.json'), 'utf8'));
            if (result.version !== 1 || result.project !== this.project || !result.verified || !result.pending) {
                throw new Error('Invalid or foreign sync journal. Refusing to reset the baseline.');
            }
            for (const name of [...Object.keys(result.verified), ...Object.keys(result.pending)]) { this.validatePath(name); }
            return result;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            return {version: 1, project: this.project, verified: {}, pending: {}};
        }
    }
    validatePath(name: string): void {
        if (!name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.')) {
            throw new Error('Invalid sync path.');
        }
    }
    async save(journal: SyncJournal): Promise<void> {
        const temp = path.join(this.root, `journal-${this.token}.tmp`);
        const handle = await fs.open(temp, 'w', 0o600);
        try { await handle.writeFile(JSON.stringify(journal, null, 2)); await handle.sync(); }
        finally { await handle.close(); }
        // Keep path/hash history so previous revisions remain identifiable after a later save.
        const history = await fs.open(path.join(this.root, 'history.jsonl'), 'a', 0o600);
        try { await history.writeFile(JSON.stringify({at:new Date().toISOString(), ...journal}) + '\n'); await history.sync(); }
        finally { await history.close(); }
        await fs.rename(temp, path.join(this.root, 'journal.json'));
    }
    async saveBlob(hash: string, data: Uint8Array): Promise<void> {
        if (digest(data) !== hash) { throw new Error('Revision checksum mismatch.'); }
        const dir = path.join(this.root, 'revisions'); await fs.mkdir(dir, {recursive: true});
        const filename = path.join(dir, hash);
        try {
            const handle = await fs.open(filename, 'wx', 0o600);
            try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            if (digest(await fs.readFile(filename)) !== hash) { throw new Error('Stored revision is corrupt.'); }
        }
    }
    async loadBlob(hash: string): Promise<Uint8Array> {
        if (!/^[a-f0-9]{64}$/.test(hash)) { throw new Error('Invalid revision hash.'); }
        const content = await fs.readFile(path.join(this.root, 'revisions', hash));
        if (digest(content) !== hash) { throw new Error('Stored revision is corrupt.'); }
        return content;
    }
}
