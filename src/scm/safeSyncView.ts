import * as vscode from 'vscode';
import { LocalReplicaSCMProvider } from './localReplicaSCM';

type SyncRow = ReturnType<typeof LocalReplicaSCMProvider.listSyncFiles>[number];
interface SyncNode {root: string; path: string; folder?: boolean; row?: SyncRow}
/** Live list of durable pending paths plus runtime failures, in the existing Overleaf container. */
export class SafeSyncView implements vscode.TreeDataProvider<SyncNode>, vscode.Disposable {
    private readonly updates = new vscode.EventEmitter<SyncNode | undefined>();
    readonly onDidChangeTreeData = this.updates.event;
    private readonly listener = () => this.updates.fire(undefined);
    constructor() { LocalReplicaSCMProvider.changeListeners.add(this.listener); }
    dispose(): void { LocalReplicaSCMProvider.changeListeners.delete(this.listener); this.updates.dispose(); }
    getTreeItem(node: SyncNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.path === '/' ? node.root : node.path.split('/').pop()!, node.folder ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        if (node.folder) {
            item.iconPath = new vscode.ThemeIcon('folder');
            item.description = `${LocalReplicaSCMProvider.listSyncFiles().filter(r => r.root === node.root && (node.path === '/' || r.path.startsWith(node.path + '/'))).length} pending`;
        } else {
            item.description = node.row?.phase;
            item.tooltip = `${node.path}\n${node.row?.phase}: ${node.row?.detail}\n${node.root}\nClick for actions; right-click for Diff / Publish Local / Accept Cloud.`;
            item.iconPath = new vscode.ThemeIcon(node.row?.phase === 'conflict' ? 'git-compare' : node.row?.phase === 'error' ? 'error' : 'cloud-upload');
            item.contextValue = node.path.startsWith('/') ? 'safeSyncFile' : 'safeSyncRuntime';
            item.command = {command:'overleaf-workshop.safeSync.actions', title:'Choose synchronization action', arguments:[node]};
        }
        return item;
    }
    getChildren(node?: SyncNode): SyncNode[] {
        const rows = LocalReplicaSCMProvider.listSyncFiles();
        if (!node) { return [...new Set(rows.map(r => r.root))].map(root => ({root,path:'/',folder:true})); }
        const prefix = node.path === '/' ? '/' : node.path + '/';
        const children = new Map<string,SyncNode>();
        for (const row of rows.filter(r => r.root === node.root)) {
            if (!row.path.startsWith('/') && node.path === '/') { children.set(row.path,{root:row.root,path:row.path,row}); continue; }
            if (!row.path.startsWith(prefix)) { continue; }
            const tail = row.path.slice(prefix.length), part = tail.split('/')[0];
            const path = prefix + part;
            children.set(path,tail.includes('/') ? {root:row.root,path,folder:true} : {root:row.root,path,row});
        }
        return [...children.values()].sort((a,b) => Number(!!b.folder)-Number(!!a.folder) || a.path.localeCompare(b.path));
    }
    static register(context: vscode.ExtensionContext): void {
        const provider = new SafeSyncView();
        const tree = vscode.window.createTreeView('overleaf-workshop.safeSyncChanges',{treeDataProvider:provider,showCollapseAll:true});
        tree.message = 'Click a file for Diff / Publish Local / Accept Cloud. Only pending files are listed.';
        context.subscriptions.push(provider,tree,
            vscode.commands.registerCommand('overleaf-workshop.safeSync.log', () => LocalReplicaSCMProvider.getOutputChannel().show()),
            vscode.commands.registerCommand('overleaf-workshop.safeSync.actions', async (node: SyncNode) => {
                if (!node.path.startsWith('/')) { LocalReplicaSCMProvider.getOutputChannel().show(); return; }
                const choice = await vscode.window.showQuickPick([
                    {label:'$(diff) View Diff — Cloud ↔ Local',action:'review' as const},
                    {label:'$(cloud-upload) Publish Local — use local file',action:'publish' as const},
                    {label:'$(cloud-download) Accept Cloud — replace local file',action:'accept' as const},
                ],{title:node.path,placeHolder:node.row?.detail});
                if (choice) { await LocalReplicaSCMProvider.runCommand(choice.action,node); }
            }));
    }
}
