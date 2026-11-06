import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as nodePath from 'path';
import { SafeSyncEngine, SyncPhase, digest } from './safeSyncEngine';
import { SafeSyncStore } from './safeSyncStore';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';

const IGNORE_SETTING_KEY = 'ignore-patterns';

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private ignorePatterns: string[] = [
        '**/Tmp',
        '**/Tmp/**',
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || !['file', 'vscode-remote'].includes(workspaceRoot?.scheme || '')) { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || !['file', 'vscode-remote'].includes(workspaceRoot?.scheme || '')) { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot===undefined || !['file', 'vscode-remote'].includes(workspaceRoot.scheme)) { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse( new TextDecoder().decode(content) );
        } catch (error) {
            return undefined;
        }
    }

    private engine?: SafeSyncEngine;
    private store?: SafeSyncStore;
    private disposed = false;
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private notificationKeys = new Set<string>();
    private failures = new Map<string, string>();
    private running = new Set<string>();
    private rerun = new Set<string>();
    private initialScan = true;
    private static outputChannel?: vscode.OutputChannel;
    static getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel ??= vscode.window.createOutputChannel('Overleaf Safe Sync');
    }
    private readonly output = LocalReplicaSCMProvider.getOutputChannel();
    private static readonly instances = new Map<string, LocalReplicaSCMProvider>();

    static readonly changeListeners = new Set<() => void>();
    static listSyncFiles(): {root: string; path: string; phase: string; detail: string}[] {
        const result: {root: string; path: string; phase: string; detail: string}[] = [];
        for (const [root, instance] of this.instances) {
            const pending = instance.engine?.journal.pending || {};
            for (const path of new Set([...Object.keys(pending), ...instance.failures.keys()])) {
                result.push({root, path, phase: pending[path]?.phase || 'error', detail: pending[path]?.error || instance.failures.get(path) || 'Waiting for server verification'});
            }
        }
        return result.sort((a,b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
    }
    private changed(): void { for (const listener of LocalReplicaSCMProvider.changeListeners) { listener(); } }
    private log(detail: string): void { this.output.appendLine(`${new Date().toISOString()} [${this.baseUri.fsPath}] ${detail}`); }

    private matchIgnorePatterns(path: string): boolean {
        // A previous replica's custom patterns must not accidentally re-enable Tmp or our journal.
        const patterns = [...(this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns),
            '**/Tmp', '**/Tmp/**', '**/.overleaf', '**/.overleaf/**', '**/*.safe-sync-*.tmp'];
        return patterns.some(pattern => minimatch(path, pattern, {dot:true}));
    }
    private localPath(name: string): string {
        this.store!.validatePath(name);
        return nodePath.join(this.baseUri.fsPath, name.slice(1));
    }
    private async readLocalSafe(name: string): Promise<Uint8Array | undefined> {
        const filename = this.localPath(name);
        try {
            // Do not follow a symlink outside the replica, even in a parent directory.
            let parent = this.baseUri.fsPath;
            for (const part of name.slice(1).split('/')) {
                parent = nodePath.join(parent, part);
                if ((await fs.lstat(parent)).isSymbolicLink()) { throw new Error('Symlinks are not uploaded automatically.'); }
            }
            if (vscode.workspace.textDocuments.some(doc => doc.uri.fsPath === filename && doc.isDirty)) {
                throw new Error('Unsaved editor changes; save the file before synchronization.');
            }
            const stat = await fs.lstat(filename);
            if (stat.isDirectory()) { return undefined; }
            return await fs.readFile(filename);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
            throw error;
        }
    }
    private refreshStatus(): void {
        this.changed();
        const entries = Object.entries(this.engine?.journal.pending || {});
        if (this.failures.size) {
            this.status = {status:'need-attention', message:`${this.failures.size} file(s) need attention; ${entries.length} unverified. Review Safe Sync log.`};
        } else if (entries.length) {
            const blocked = entries.filter(([,e]) => e.phase === 'conflict' || e.phase === 'error').length;
            this.status = {status: blocked ? 'need-attention' : 'push',
                message: `${entries.length} file(s) unverified; ${blocked} need review. Click to inspect Safe Sync.`};
        } else if (this.timers.size || this.running.size || this.initialScan) {
            this.status = {status:'push', message: this.initialScan ? 'Checking initial file inventory; not yet verified.' : 'Local changes queued; not yet verified.'};
        } else {
            this.status = {status:'idle', message:'All checked local files verified against server reads. Local-first mode: no automatic downloads.'};
        }
    }
    private report(name: string, phase: SyncPhase | 'verified', detail: string): void {
        const entry = this.engine?.journal.pending[name];
        this.log(`[${phase}] ${name}: ${detail}${entry ? `; attempt=${entry.attempts}; local=${entry.target}; expected=${entry.expected ?? 'absent'}; observed=${entry.observed ?? 'absent'}` : ''}`);
        if (phase === 'error' || phase === 'conflict') { this.failures.set(name, detail); }
        else if (phase === 'verified') { this.failures.delete(name); }
        this.refreshStatus();
        if (phase === 'error' || phase === 'conflict') {
            const key = `${name}:${phase}:${detail}`;
            if (!this.notificationKeys.has(key)) {
                this.notificationKeys.add(key);
                void vscode.window.showWarningMessage(`Overleaf: ${name} has NOT been synchronized. Local file preserved. ${detail}`,
                    'Show Sync Log').then(choice => { if (choice) { this.output.show(); } });
            }
        } else if (phase === 'verified') {
            for (const key of this.notificationKeys) { if (key.startsWith(`${name}:`)) { this.notificationKeys.delete(key); } }
        }
    }
    private async safely(action: () => Promise<void>): Promise<void> {
        try { await action(); }
        catch (error) {
            this.failures.set('[runtime]', String(error));
            this.output.appendLine(`${new Date().toISOString()} [error] ${String(error)}`);
            this.status = {status:'need-attention', message:`Sync stopped: ${String(error)}`};
            this.changed();
            void vscode.window.showErrorMessage(`Overleaf Safe Sync: ${String(error)}. See sync changes and log for details.`);
        }
    }
    private schedule(name: string, retryOnly=false): void {
        if (this.disposed || this.matchIgnorePatterns(name)) { return; }
        if (this.running.has(name)) {
            if (!retryOnly) { this.rerun.add(name); }
            return;
        }
        clearTimeout(this.timers.get(name));
        this.timers.set(name, setTimeout(() => {
            this.timers.delete(name);
            this.running.add(name);
            void this.safely(async () => {
                try { if ((await fs.lstat(this.localPath(name))).isDirectory()) {
                    for (const child of await this.scanLocal(`${name}/`)) { this.schedule(child); }
                    return;
                } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
                await this.engine?.reconcile(name);
            }).finally(() => {
                this.running.delete(name);
                if (this.rerun.delete(name)) { this.schedule(name); }
                this.refreshStatus();
            });
        }, 600));
        this.refreshStatus();
    }
    private async scanLocal(root = '/'): Promise<string[]> {
        const result: string[] = [];
        for (const item of await fs.readdir(this.localPath(root), {withFileTypes:true})) {
            const name = `${root}${item.name}`;
            if (this.matchIgnorePatterns(name) || item.isSymbolicLink()) { continue; }
            if (item.isDirectory()) { result.push(...await this.scanLocal(`${name}/`)); }
            else if (item.isFile()) { result.push(name); }
        }
        return result;
    }
    private async scanRemote(root = '/'): Promise<string[]> {
        const result: string[] = [];
        for (const [name,type] of await vscode.workspace.fs.readDirectory(this.vfs.pathToUri(root))) {
            const rel = `${root}${name}`;
            if (this.matchIgnorePatterns(rel)) { continue; }
            if (type === vscode.FileType.Directory) { result.push(...await this.scanRemote(`${rel}/`)); }
            else if (type === vscode.FileType.File) { result.push(rel); }
        }
        return result;
    }
    private async createParents(name: string): Promise<void> {
        const parts = name.split('/').filter(Boolean); parts.pop();
        let root = '';
        for (const part of parts) {
            root += `/${part}`;
            const uri = this.vfs.pathToUri(root);
            try { await vscode.workspace.fs.stat(uri); }
            catch (error) {
                if ((error as vscode.FileSystemError).code !== 'FileNotFound') { throw error; }
                await vscode.workspace.fs.createDirectory(uri);
                this.log(`[created cloud folder] ${root}`);
            }
        }
    }
    private async initWatch(): Promise<vscode.Disposable[]> {
        this.disposed = false;
        this.status = {status:'need-attention', message:'Starting Safe Sync; server verification pending.'};
        const identity = `${this.vfs.origin.toString()}|${this.baseUri.fsPath}`;
        this.store = new SafeSyncStore(nodePath.join(this.baseUri.fsPath, '.overleaf', 'safe-sync'), identity);
        LocalReplicaSCMProvider.instances.set(this.baseUri.fsPath, this); this.changed();
        try {
            await this.store.lock();
            const journal = await this.store.load();
            this.engine = new SafeSyncEngine(journal, {
                readLocal: name => this.readLocalSafe(name),
                readRemote: name => this.vfs.readFileForSync(this.vfs.pathToUri(name)),
                writeRemote: async (name, data, expected) => {
                    if (this.disposed) { throw new Error('Synchronization stopped.'); }
                    await this.createParents(name);
                    this.log(`[upload request] ${name}; bytes=${data.length}; ${expected === null ? 'create' : 'update'}`);
                    await this.vfs.writeFileForSync(this.vfs.pathToUri(name), data, expected);
                },
                saveBlob: (hash,data) => this.store!.saveBlob(hash,data),
                loadBlob: hash => this.store!.loadBlob(hash),
                saveJournal: state => this.store!.save(state),
                report: (name,phase,detail) => this.report(name,phase,detail),
                ignored: name => this.matchIgnorePatterns(name),
            });
            const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
            let freshReplica = false;
            try { await vscode.workspace.fs.stat(settingUri); }
            catch (error) {
                if ((error as vscode.FileSystemError).code !== 'FileNotFound') { throw error; }
                freshReplica = true;
                await vscode.workspace.fs.writeFile(settingUri, Buffer.from(JSON.stringify({
                    uri:this.vfs.origin.toString(), serverName:this.vfs.serverName,
                    enableCompileNPreview:false, projectName:this.vfs.projectName,
                }, null, 4)));
            }
            // Only an explicitly newly-created replica may initially download absent files.
            // Existing source files are NEVER written, even if the journal has no baseline.
            if (freshReplica) {
                for (const name of await this.scanRemote()) {
                    if (await this.readLocalSafe(name) !== undefined) { continue; }
                    const data = await this.vfs.readFileForSync(this.vfs.pathToUri(name));
                    if (data === undefined) { continue; }
                    const filename = this.localPath(name);
                    await fs.mkdir(nodePath.dirname(filename), {recursive:true});
                    try { await fs.writeFile(filename, data, {flag:'wx'}); }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
                }
            }
            const localWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.baseUri, '**/*'));
            const remoteWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.vfs.origin, '**/*'));
            const localEvent = (uri: vscode.Uri) => {
                const prefix = `${this.baseUri.path.replace(/\/$/, '')}/`;
                if (uri.path.startsWith(prefix)) {
                    const name = `/${uri.path.slice(prefix.length)}`;
                    if (!this.matchIgnorePatterns(name)) { this.log(`[local event] ${name}`); this.schedule(name); }
                }
            };
            const remoteEvent = (uri: vscode.Uri) => {
                const {pathParts} = parseUri(uri);
                const name = `/${pathParts.filter(Boolean).join('/')}`;
                if (!this.matchIgnorePatterns(name)) { this.schedule(name); }
            };
            const timer = setInterval(() => {
                if (this.disposed) { return; }
                for (const [name,entry] of Object.entries(journal.pending)) {
                    if (entry.phase !== 'conflict') { this.schedule(name, true); }
                }
            }, 20000);
            LocalReplicaSCMProvider.instances.set(this.baseUri.fsPath, this);
            this.changed();
            const subscriptions: vscode.Disposable[] = [localWatcher, remoteWatcher,
                localWatcher.onDidChange(localEvent), localWatcher.onDidCreate(localEvent), localWatcher.onDidDelete(localEvent),
                remoteWatcher.onDidChange(remoteEvent), remoteWatcher.onDidCreate(remoteEvent), remoteWatcher.onDidDelete(remoteEvent),
                vscode.workspace.onDidSaveTextDocument(doc => localEvent(doc.uri)),
                new vscode.Disposable(() => {
                    this.disposed = true; this.engine?.stop(); clearInterval(timer);
                    for (const t of this.timers.values()) { clearTimeout(t); }
                    this.timers.clear(); LocalReplicaSCMProvider.instances.delete(this.baseUri.fsPath); this.changed();
                    // Release only after queued/in-flight work settles: a replacement cannot race a writer.
                    void this.engine?.drain().then(() => this.store?.unlock()).catch(e => this.output.appendLine(String(e)));
                }),
            ];
            this.output.appendLine(`${new Date().toISOString()} Safe Sync active: ${this.baseUri.fsPath}; local-first, uncached server verification.`);
            // Return subscriptions immediately; a slow server must not prevent visible error/status handling.
            this.initialScan = true;
            void this.safely(async () => {
                const paths = new Set([...await this.scanLocal(), ...await this.scanRemote(), ...Object.keys(journal.verified), ...Object.keys(journal.pending)]);
                this.log(`[inventory] ${paths.size} files; Tmp and configured ignore patterns excluded.`);
                for (const name of paths) { if (!this.disposed) { await this.engine!.reconcile(name); } }
            }).finally(() => { this.initialScan = false; this.refreshStatus(); });
            return subscriptions;
        } catch (error) {
            this.failures.set('[startup]',String(error)); this.changed();
            await this.store.unlock(); throw error;
        }
    }
    static async runCommand(action: 'retry' | 'review' | 'publish' | 'accept' | 'publishAll', item?: {root: string; path: string}): Promise<void> {
        const instance = item?.root ? this.instances.get(item.root) : [...this.instances.values()][0];
        if (!instance?.engine || !instance.store) {
            void vscode.window.showWarningMessage('No active Local Replica. Open its root folder containing .overleaf/settings.json.'); return;
        }
        await instance.safely(async () => {
            if (action === 'retry') {
                instance.log('[manual scan] Checking local and cloud inventory.');
                for (const name of new Set([...await instance.scanLocal(), ...await instance.scanRemote(), ...Object.keys(instance.engine!.journal.pending)])) { await instance.engine!.reconcile(name); }
                instance.failures.delete('[runtime]'); instance.refreshStatus(); return;
            }
            const paths = Object.keys(instance.engine!.journal.pending);
            if (action === 'publishAll') {
                if (!paths.length) { void vscode.window.showInformationMessage('No unverified files.'); return; }
                const answer = await vscode.window.showWarningMessage(`Publish ALL ${paths.length} listed local files to Overleaf? Existing cloud versions will be backed up. Files missing locally are skipped.`, {modal:true}, 'Publish All Local');
                if (answer !== 'Publish All Local') { return; }
                instance.log(`[user action] Publish All Local: ${paths.join(', ')}`);
                for (const name of paths) {
                    await instance.safely(async () => { if (await instance.readLocalSafe(name) !== undefined) { await instance.engine!.authorizeLocal(name); } });
                }
                instance.refreshStatus(); return;
            }
            const name = item?.path ?? await vscode.window.showQuickPick(paths, {title: 'Select synchronization file'});
            if (!name) { return; }
            instance.store!.validatePath(name);
            instance.log(`[user action] ${action} ${name}`);
            if (action === 'review') {
                const remote = await instance.vfs.readFileForSync(instance.vfs.pathToUri(name));
                const local = await instance.readLocalSafe(name);
                const data = remote ?? new Uint8Array();
                const hash = digest(data); await instance.store!.saveBlob(hash,data);
                const left = vscode.Uri.file(nodePath.join(instance.store!.root,'revisions',hash));
                const right = local === undefined ? left : vscode.Uri.file(instance.localPath(name));
                if (local === undefined) {
                    await vscode.commands.executeCommand('vscode.open', left);
                    void vscode.window.showInformationMessage(`${name}: absent locally. Use Accept Cloud to download, or leave unchanged.`);
                } else {
                    await vscode.commands.executeCommand('vscode.diff', left, right, `Cloud (left) ↔ Local (right): ${name}`);
                    if (remote === undefined) { void vscode.window.showInformationMessage(`${name}: absent on Overleaf; left side is empty. Use Publish Local to create it.`); }
                }
            } else if (action === 'publish') {
                const answer = await vscode.window.showWarningMessage(`Publish local ${name} over its current Overleaf version? The remote snapshot will be backed up; your local file will not be changed.`, {modal:true}, 'Publish Local');
                if (answer === 'Publish Local') { await instance.engine!.authorizeLocal(name); instance.refreshStatus(); }
            } else if (action === 'accept') {
                const answer = await vscode.window.showWarningMessage(`Replace local ${name} with the current cloud version? Saved local content will be backed up. Unsaved edits block this action.`, {modal:true}, 'Accept Cloud');
                if (answer !== 'Accept Cloud') { return; }
                await instance.engine!.acceptRemote(name, async (data, expected) => {
                    // No await between last disk/editor checks and replacement. Watcher work is serialized by the engine.
                    const filename = instance.localPath(name);
                    await fs.mkdir(nodePath.dirname(filename), {recursive:true});
                    await instance.readLocalSafe(name); // validate symlink parents
                    if (vscode.workspace.textDocuments.some(d => d.uri.fsPath === filename && d.isDirty)) { throw new Error('Save or discard unsaved edits before accepting cloud.'); }
                    const current = syncFs.existsSync(filename) ? syncFs.readFileSync(filename) : undefined;
                    if ((current === undefined ? null : digest(current)) !== expected) { throw new Error('Local file changed while accepting cloud; try again after review.'); }
                    const temp = `${filename}.safe-sync-${process.pid}.tmp`;
                    try {
                        const fd = syncFs.openSync(temp,'wx',syncFs.existsSync(filename) ? syncFs.statSync(filename).mode & 0o777 : 0o600);
                        try { syncFs.writeFileSync(fd,data); syncFs.fsyncSync(fd); } finally { syncFs.closeSync(fd); }
                        syncFs.renameSync(temp,filename);
                    }
                    finally { if (syncFs.existsSync(temp)) { syncFs.unlinkSync(temp); } }
                });
                instance.log(`[accepted cloud] ${name}; previous local content in .overleaf/safe-sync/revisions; hashes in history.jsonl.`);
                instance.refreshStatus();
            }
        });
    }
    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        return Promise.reject(new Error('Safe Sync never writes existing local source files. Use an explicit editor action.'));
    }
    readFile(relPath: string): Thenable<Uint8Array | undefined> { return this.readLocalSafe(relPath); }
    get triggers(): Promise<vscode.Disposable[]> { return this.initWatch(); }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            {label: 'Retry and verify local files', callback: () => LocalReplicaSCMProvider.runCommand('retry')},
            {label: 'Review unsynchronized files', callback: () => LocalReplicaSCMProvider.runCommand('review')},
            {label: 'Publish selected local version...', callback: () => LocalReplicaSCMProvider.runCommand('publish')},
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
