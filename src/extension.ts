'use strict'

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as stream from "stream";
import { Lock } from './lock';

const wordRegexp = /[A-Z]?[a-z]+('t)?/g;

let spellDiagnostics: vscode.DiagnosticCollection;

let aspell: child_process.ChildProcess = null;
let aspellLock = new Lock();
let aspellLines: AwaitLine;
let knownGood = arrayToHash(["func", "cb", "ctx", "Keybase"]);
let knownBad = {};

function arrayToHash(array: string[]) {
    return array.reduce((obj, x) => { obj[x] = true; return obj; }, {});
}

interface spellCheckError {
    word: string;
    suggestions: string[];
}

async function checkSpelling(words: string[]): Promise<spellCheckError[]> {
    if (words.length === 0) {
        // Can't have spelling errors if you don't have any words.
        return [];
    }
    await aspellLock.lock();
    console.log("Sending ", words, " to aspell");
    aspell.stdin.write(words.join(" ") + "\n");
    let ret = [];
    let newGoods = arrayToHash(words);
    for (; ;) {
        let line = await aspellLines.getLine();
        if (line == "") {
            break; // aspell signals done
        }
        let error = spellCheckLine(line);
        if (error != null) {
            delete newGoods[error.word];
            ret.push(error);
            knownBad[error.word] = error;
        }
    }
    Object.assign(knownGood, newGoods);
    aspellLock.unlock();
    return ret;
}

function trimCache() {
    console.log("Cache is: ", Object.keys(knownGood).length, Object.keys(knownBad).length);
}

function triggerSpellcheck(document: vscode.TextDocument) {
    let matches = document.getText().match(wordRegexp);
    console.log('Trigger');
    let matchesHash = arrayToHash(matches);
    let words = Object.keys(matchesHash);
    words = words.filter((x) => { return x.length > 1 });
    words = words.filter((x) => { return knownGood[x] === undefined });

    let knownErrors: spellCheckError[] = words.map((x) => {
        return knownBad[x];
    }).filter((x) => { return x != null });

    words = words.filter((x) => { return knownBad[x] === undefined });

    checkSpelling(words).then((errors: spellCheckError[]) => {
        console.log('Errors (from aspell):', errors.length);
        console.log('Errors (from cache):', knownErrors.length);

        errors = errors.concat(knownErrors);

        if (errors.length == 0) {
            spellDiagnostics.set(document.uri, []);
            return;
        }

        let diagnostics: vscode.Diagnostic[] = [];
        let text = document.getText();
        errors.forEach((err) => {
            let index = -1;
            for (; ;) {
                index = text.indexOf(err.word, index + 1);
                if (index == -1) {
                    break;
                }
                let start = document.positionAt(index);
                let end = start.with(undefined, start.character + err.word.length);
                diagnostics.push({
                    severity: vscode.DiagnosticSeverity.Warning,
                    range: new vscode.Range(start, end),
                    message: err.word + "(suggestions: " + err.suggestions.slice(0, 10).join(" ") + ")",
                    source: 'aspell'
                });
            }
        });
        console.log(diagnostics);
        spellDiagnostics.set(document.uri, diagnostics);

        trimCache();
    });
}

function triggerDiffSpellcheck(event: vscode.TextDocumentChangeEvent) {
    triggerSpellcheck(event.document);
}

function triggerSpellcheckCommand(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) {
    triggerSpellcheck(textEditor.document);
}

const aspellRegexp = /^\& ([a-zA-Z]+) ([0-9]+) ([0-9]+): (.+)$/;
function spellCheckLine(chunk: string): spellCheckError | null {
    if (chunk.length < 1) {
        return null;
    }
    let match = chunk.match(aspellRegexp);
    if (match != null) {
        const word = match[1];
        const suggestions = match[4].split(" ");
        return { word, suggestions };
    } else {
        return null;
    }
}

class AwaitLine {
    awaiters: ((string) => void)[];
    backlog: string[];
    constructor() {
        this.awaiters = [];
        this.backlog = [];
    }

    private feedLine(data: string) {
        if (this.awaiters.length > 0) {
            this.awaiters.shift()(data);
        } else {
            this.backlog.push(data);
        }
    }

    static fromStream(s: stream.Readable): AwaitLine {
        const obj = new AwaitLine();
        let dataBacklog = "";
        s.on('data', function (data) {
            dataBacklog += data;
            let i = dataBacklog.indexOf("\n");
            while (i != -1) {
                const line = dataBacklog.substring(0, i);
                obj.feedLine(line);
                dataBacklog = dataBacklog.substring(i + 1);
                i = dataBacklog.indexOf("\n");
            }
        });
        return obj;
    }

    getLine(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            if (this.backlog.length > 0) {
                resolve(this.backlog.shift());
            } else {
                this.awaiters.push(resolve);
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext): void {
    spellDiagnostics = vscode.languages.createDiagnosticCollection('aspell');

    aspell = child_process.spawn('aspell', ['pipe'])
    aspell.stdout.setEncoding('utf8');
    aspellLines = AwaitLine.fromStream(aspell.stdout);

    aspell.on('close', function () {
        console.log('Aspell closed');
        // kill the extension, we don't have a way to recover.
        process.exit(1);
    })

    // vscode.workspace.onDidOpenTextDocument(triggerSpellcheck);
    // vscode.workspace.onDidChangeTextDocument(triggerDiffSpellcheck);
    // vscode.workspace.onDidSaveTextDocument(triggerSpellcheck);

    vscode.workspace.onDidCloseTextDocument((textDocument) => {
        spellDiagnostics.delete(textDocument.uri);
    }, null);

    vscode.commands.registerTextEditorCommand("aspell.spellCheck", triggerSpellcheckCommand);
    vscode.commands.registerTextEditorCommand("aspell.clearSpellCheck", (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) => {
        spellDiagnostics.delete(textEditor.document.uri);
    });
}
