import * as vscode from 'vscode';
import { ROOT_NAME, ELEGANT_NAME } from './consts';

import { RemoteFileSystemProvider, VirtualFileSystem } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import { LocalReplicaSCMProvider } from './scm/localReplicaSCM';

export function activate(context: vscode.ExtensionContext) {
    const syncLog = LocalReplicaSCMProvider.getOutputChannel();
    syncLog.appendLine(`${new Date().toISOString()} Safe Sync extension activated; checking local replica association.`);
    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    for (const action of ['retry', 'review', 'publish'] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`${ROOT_NAME}.safeSync.${action}`, () => LocalReplicaSCMProvider.runCommand(action)));
    }

    // activate vfs for local replica
    LocalReplicaSCMProvider.readSettings()
    .then(async setting => {
        if (!setting?.uri) {
            syncLog.appendLine('No local replica metadata in the open workspace root. Open the folder containing .overleaf/settings.json.');
        }
        if (setting?.uri) {
            const uri = vscode.Uri.parse(setting.uri);
            if (uri.scheme===ROOT_NAME) {
                // activate vfs
                const vfs = (await (await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri))) as VirtualFileSystem;
                await vfs.init();
                vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
                // activate compile & preview
                if (setting?.enableCompileNPreview) {
                    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, true);
                }
            }
        }
    }).catch(error => {
        syncLog.appendLine(`[startup error] ${String(error)}`);
        void vscode.window.showErrorMessage(`Overleaf Safe Sync failed to start: ${String(error)}. Local files are preserved.`);
    });
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
}