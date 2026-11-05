import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SyncJournal, digest } from './safeSyncEngine';

/** Atomic local journal + content-addressed revisions, shared by all restarts of this replica. */
export class SafeSyncStore {
    private readonly token = randomUUID();
    private locked = false;
    constructor(public readonly root: string, private readonly project: string) {}
    async lock(): Promise<void> {
        await fs.mkdir(this.root, {recursive: true});
        const filename = path.join(this.root, 'lock.json');
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const handle = await fs.open(filename, 'wx', 0o600);
                await handle.writeFile(JSON.stringify({pid: process.pid, token: this.token}));
                await handle.close(); this.locked = true; return;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
                const previous = JSON.parse(await fs.readFile(filename, 'utf8'));
                try { process.kill(previous.pid, 0); }
                catch (probe) {
                    if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(filename); continue; }
                }
                throw new Error('Another VS Code window is syncing this replica. Close the duplicate window before retrying.');
            }
        }
        throw new Error('Could not acquire replica sync lock.');
    }
    async unlock(): Promise<void> {
        if (!this.locked) { return; }
        const filename = path.join(this.root, 'lock.json');
        try {
            const current = JSON.parse(await fs.readFile(filename, 'utf8'));
            if (current.token === this.token) { await fs.unlink(filename); }
        } finally { this.locked = false; }
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
